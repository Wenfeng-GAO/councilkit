/**
 * Atomic file writes (plan-a §3, D1 §11). Every managed file is written to a
 * same-directory tmp file, `fsync`'d, then `rename`'d over the target — so a
 * crash leaves either the full previous version or the full new version, never a
 * half-written file. The tmp file MUST be in the same directory to avoid EXDEV
 * on cross-device rename.
 *
 * Callers wrap failures into a CliError(io) via `store.ts`; this module only
 * owns the low-level durability mechanics and never truncates a live target.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_FILE_MODE = 0o600;

/** Create the parent dir (0700) if missing; safe to call repeatedly. */
export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

/** Write `data` to `filePath` atomically: tmp + fsync + rename. Returns the
 * number of bytes written. The existing file is never opened for writing. */
export function atomicWriteFile(filePath: string, data: string): number {
  ensureParentDir(filePath);
  const base = filePath.split("/").pop() ?? "file";
  const tmp = join(dirname(filePath), `.${base}.${randomBytes(6).toString("hex")}.tmp`);

  const fd = openSync(tmp, "w", DEFAULT_FILE_MODE);
  let written: number;
  try {
    written = writeAllSync(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, filePath);
  } catch (cause) {
    // Best-effort tmp cleanup on rename failure; the original file is untouched.
    try {
      unlinkSync(tmp);
    } catch {
      // tmp is uniquely named and non-final — ignore cleanup failure.
    }
    throw cause;
  }
  return written;
}

/** Write JSON pretty-printed, with a trailing newline. */
export function atomicWriteJson(filePath: string, value: unknown): number {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read a file's full content as UTF-8 text, or `null` when it does not exist
 * (or names something other than a regular file). */
export function readFileText(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function writeAllSync(fd: number, buffer: Buffer): number {
  let total = 0;
  while (total < buffer.length) {
    const written = writeSync(fd, buffer, total, buffer.length - total);
    if (written <= 0) {
      throw new Error(`atomic write stalled after ${total} bytes`);
    }
    total += written;
  }
  return total;
}
