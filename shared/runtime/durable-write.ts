/**
 * Managed artifact writes that do not follow a destination symlink.
 *
 * A replace writes a same-directory temp file, fsyncs, and renames over the
 * path. Rename swaps out a symlink and leaves its target untouched. Append and
 * read open with O_NOFOLLOW, so a symlink fails closed instead of creating or
 * reading the target. Creating a parent also fails closed when that directory,
 * or a missing ancestor, is a symlink — a leaf O_NOFOLLOW does not cover the
 * directory the leaf is created in.
 */
import { randomBytes } from "node:crypto";
import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

function ioError(code: "ELOOP" | "ENOTDIR" | "ENOENT", path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  error.path = path;
  return error;
}

/**
 * Ensure `dir` exists as a real directory (mode 0700).
 * A symlink at `dir`, or a symlink on the way to a missing component, throws ELOOP.
 * An existing real directory is mkdir'd again so a caller can still observe mkdir failure.
 */
export function mkdirPrivate(dir: string): void {
  const missing: string[] = [];
  let cursor = dir;
  while (true) {
    let st: Stats;
    try {
      st = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw ioError("ENOENT", dir);
      cursor = parent;
      continue;
    }
    if (st.isSymbolicLink()) throw ioError("ELOOP", cursor);
    if (!st.isDirectory()) throw ioError("ENOTDIR", cursor);
    break;
  }
  if (missing.length === 0) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return;
  }
  for (let i = missing.length - 1; i >= 0; i--) {
    const next = missing[i] ?? dir;
    mkdirSync(next, { mode: PRIVATE_DIR_MODE });
    const created = lstatSync(next);
    if (created.isSymbolicLink() || !created.isDirectory()) throw ioError("ELOOP", next);
  }
}

function assertParentNotSymlink(dir: string): void {
  try {
    if (lstatSync(dir).isSymbolicLink()) throw ioError("ELOOP", dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** Write `data` over `filePath` without following a symlink. Returns bytes written. */
export function replacePrivateFile(filePath: string, data: string | Buffer): number {
  mkdirPrivate(dirname(filePath));
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
  mkdirPrivate(dirname(filePath));
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
  assertParentNotSymlink(dirname(filePath));
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
