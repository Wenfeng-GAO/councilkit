/**
 * Atomic file writes (plan-a §3, D1 §11). Every managed file is written to a
 * same-directory tmp file, `fsync`'d, then `rename`'d over the target — so a
 * crash leaves either the full previous version or the full new version, never a
 * half-written file. The tmp file MUST be in the same directory to avoid EXDEV
 * on cross-device rename.
 *
 * Callers wrap write failures into a CliError(io) via `store.ts`; this module
 * owns the low-level durability mechanics and never truncates a live target.
 * `readFileText` is the exception: it throws a diagnostic CliError(io) itself
 * for any non-ENOENT fault, so a present-but-unreadable file is never mistaken
 * for "missing" and overwritten (F4).
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
import { errors } from "../errors";

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

  // Unified handling over open → write → fsync → close → rename so a failure at
  // ANY stage never leaves a partial `.tmp` in the target directory (F7). The
  // first thrown error is preserved; a later close/unlink error must not mask it.
  const fd = openSync(tmp, "w", DEFAULT_FILE_MODE);
  let written = 0;
  let primaryError: unknown;
  try {
    written = writeAllSync(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } catch (error) {
    primaryError = error;
  }
  // closeSync errors (e.g. EIO on close) must not overwrite the original
  // write/fsync error, but a successful write followed by a close failure is
  // itself a write error.
  try {
    closeSync(fd);
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
  }
  if (primaryError !== undefined) {
    bestEffortUnlink(tmp);
    throw primaryError;
  }
  try {
    renameSync(tmp, filePath);
  } catch (cause) {
    bestEffortUnlink(tmp);
    throw cause;
  }
  return written;
}

/** Best-effort unlink of a uniquely-named tmp file; cleanup failure is ignored
 * because the tmp is non-final and uniquely named. */
function bestEffortUnlink(tmp: string): void {
  try {
    unlinkSync(tmp);
  } catch {
    // tmp is uniquely named and non-final — ignore cleanup failure.
  }
}

/** Write JSON pretty-printed, with a trailing newline. */
export function atomicWriteJson(filePath: string, value: unknown): number {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read a file's full content as UTF-8 text, or `null` when it does not exist.
 *
 * ONLY a definitive `ENOENT` maps to `null` (i.e. "fresh, nothing there yet").
 * A non-regular file (directory / symlink target / device) or a real I/O fault
 * (EACCES / EIO / EFBIG …) is surfaced as a diagnostic `CliError(io)`. Folding
 * those into `null` would make the Store treat a present-but-unreadable file as
 * empty and the next create would `rename` over it — silent data loss (F4). */
export function readFileText(filePath: string): string | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch (error) {
    if (isENOENT(error)) return null;
    throw errors.io(`cannot stat "${filePath}": ${ioMessage(error)}`);
  }
  if (!stat.isFile()) {
    throw errors.io(
      `"${filePath}" is not a regular file (mode=${stat.mode.toString(8)}); refusing to overwrite a non-regular managed file`,
    );
  }
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isENOENT(error)) return null;
    throw errors.io(`cannot read "${filePath}": ${ioMessage(error)}`);
  }
}

function isENOENT(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Node sets `code === "ENOENT"` on fs stat/read ENOENT.
  return (error as { code?: string }).code === "ENOENT";
}

function ioMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  return code ?? (error instanceof Error ? error.name : "IOFailure");
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
