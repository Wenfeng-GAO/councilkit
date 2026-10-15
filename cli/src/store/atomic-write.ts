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
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { replacePrivateFile } from "@shared/runtime/durable-write";
import { errors } from "../errors";

export const DEFAULT_FILE_MODE = 0o600;

/** Create the parent dir (0700) if missing; safe to call repeatedly. */
export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

/** Write `data` to `filePath` atomically: tmp + fsync + rename. Returns the
 * number of bytes written. The existing file is never opened for writing, and
 * a destination symlink is replaced rather than followed. */
export function atomicWriteFile(filePath: string, data: string): number {
  return replacePrivateFile(filePath, data);
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

export type DurableJson<T> =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "ok"; value: T };

/**
 * `accept` returns null to reject. A present file that is not JSON, or that
 * `accept` rejects, is `invalid`. That is not the same as a missing file.
 * Create-if-absent writers must not replace `invalid` bytes with a fresh default.
 */
export function parseDurableJsonText<T>(
  text: string,
  accept: (value: unknown) => T | null,
): { status: "invalid" } | { status: "ok"; value: T } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "invalid" };
  }
  const accepted = accept(value);
  if (accepted === null) return { status: "invalid" };
  return { status: "ok", value: accepted };
}

export function readDurableJson<T>(
  filePath: string,
  accept: (value: unknown) => T | null,
): DurableJson<T> {
  const text = readFileText(filePath);
  if (text === null) return { status: "missing" };
  return parseDurableJsonText(text, accept);
}

export function requireDurableJson<T>(read: DurableJson<T>, label: string): T | null {
  if (read.status === "invalid") {
    throw errors.io(`${label} is present but invalid; refusing to reset it`);
  }
  return read.status === "ok" ? read.value : null;
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
