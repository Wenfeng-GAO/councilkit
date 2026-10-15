/**
 * Managed artifact writes that do not follow a destination symlink.
 *
 * A replace writes a same-directory temp file, fsyncs, and renames over the
 * path. Rename swaps out a symlink and leaves its target untouched. Append and
 * read open with O_NOFOLLOW, so a symlink fails closed instead of creating or
 * reading the target.
 */
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const PRIVATE_FILE_MODE = 0o600;

/** Write `data` over `filePath` without following a symlink. Returns bytes written. */
export function replacePrivateFile(filePath: string, data: string | Buffer): number {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const base = filePath.split("/").pop() ?? "file";
  const tmp = join(dirname(filePath), `.${base}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  const buffer = toBuffer(data);
  let written = 0;
  let primaryError: unknown;
  try {
    written = writeAllSync(fd, buffer);
    fsyncSync(fd);
  } catch (error) {
    primaryError = error;
  }
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

/** Append `data` to a regular file. A symlink, including a dangling one, throws ELOOP. */
export function appendPrivateFile(filePath: string, data: string | Buffer): number {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = openNoFollowAppend(filePath);
  const buffer = toBuffer(data);
  let written = 0;
  let primaryError: unknown;
  try {
    written = writeAllSync(fd, buffer);
  } catch (error) {
    primaryError = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
  }
  if (primaryError !== undefined) throw primaryError;
  return written;
}

/** Open `filePath` for append without creating missing parents and without following a symlink. */
export function openNoFollowAppend(filePath: string): number {
  return openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
}

/**
 * Read a regular file without following a symlink.
 * Returns null for ENOENT, ELOOP, or a non-regular file. Other IO errors throw.
 */
export function readPrivateText(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function toBuffer(data: string | Buffer): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
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

function bestEffortUnlink(tmp: string): void {
  try {
    unlinkSync(tmp);
  } catch {
    // uniquely named temp — a cleanup failure must not hide the write error
  }
}
