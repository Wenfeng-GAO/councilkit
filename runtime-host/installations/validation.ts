import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Filesystem-metadata validation of one Installation candidate.
 *
 * The Host never executes candidates (no `--version`, no handshake) and never
 * reads credential material (`~/.config/cld/env`, Codex auth files). Validation
 * is realpath resolution, permission bits, ownership and a content fingerprint
 * of the executable file itself — a script/binary, not a credential. Results
 * are structured: missing or broken files are data, never exceptions.
 */

export type ValidationFailureReason =
  | "not_found"
  | "not_executable"
  | "bad_owner"
  | "writable_path"
  | "unreadable";

/** Pinned metadata the registry compares against for symlink-swap/drift checks. */
export interface ValidationRecord {
  realpath: string;
  /** `sha256:<hex>` of the executable file contents. */
  fingerprint: string;
  /** Permission bits only (mode & 0o7777). */
  mode: number;
  uid: number;
  gid: number;
}

export type ValidationResult =
  | { ok: true; record: ValidationRecord }
  | { ok: false; reason: ValidationFailureReason; detail: string };

export interface ValidationOptions {
  /** uid allowed next to root; defaults to the current process uid. */
  uid?: number;
}

const GROUP_OR_OTHER_WRITABLE = 0o022;
const OWNER_EXEC = 0o100;
const PERMISSION_BITS = 0o7777;

function fail(reason: ValidationFailureReason, detail: string): ValidationResult {
  return { ok: false, reason, detail };
}

function statFailure(error: NodeJS.ErrnoException, what: string): ValidationResult {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") {
    return fail("not_found", `${what} does not exist.`);
  }
  return fail("unreadable", `${what} cannot be inspected (${error.code ?? "unknown error"}).`);
}

/**
 * Validate one candidate path. Passes only when the resolved file is an
 * owner-executable regular file owned by the current uid or root, and neither
 * the file nor any directory in its path chain is group/other writable.
 */
export function validateExecutable(
  path: string,
  options: ValidationOptions = {},
): ValidationResult {
  const allowedUid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);

  let realpath: string;
  try {
    realpath = realpathSync(path);
  } catch (error) {
    return statFailure(error as NodeJS.ErrnoException, `Executable "${path}"`);
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(realpath);
  } catch (error) {
    return statFailure(error as NodeJS.ErrnoException, `Executable "${realpath}"`);
  }
  if (!stat.isFile()) {
    return fail("not_executable", `"${realpath}" is not a regular file.`);
  }
  if ((stat.mode & OWNER_EXEC) === 0) {
    return fail("not_executable", `"${realpath}" lacks the owner execute bit.`);
  }
  if (stat.uid !== 0 && stat.uid !== allowedUid) {
    return fail(
      "bad_owner",
      `"${realpath}" is owned by uid ${stat.uid}, not the current user or root.`,
    );
  }
  if ((stat.mode & GROUP_OR_OTHER_WRITABLE) !== 0) {
    return fail("writable_path", `"${realpath}" is group- or other-writable.`);
  }

  // Every directory from the file up to "/" must be non group/other writable.
  let dir = dirname(realpath);
  for (;;) {
    let dirStat: ReturnType<typeof statSync>;
    try {
      dirStat = statSync(dir);
    } catch (error) {
      return statFailure(error as NodeJS.ErrnoException, `Directory "${dir}"`);
    }
    if ((dirStat.mode & GROUP_OR_OTHER_WRITABLE) !== 0) {
      return fail(
        "writable_path",
        `Directory "${dir}" in the path chain is group- or other-writable.`,
      );
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  let digest: string;
  try {
    digest = createHash("sha256").update(readFileSync(realpath)).digest("hex");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return fail("unreadable", `"${realpath}" cannot be fingerprinted (${code}).`);
  }

  return {
    ok: true,
    record: {
      realpath,
      fingerprint: `sha256:${digest}`,
      mode: stat.mode & PERMISSION_BITS,
      uid: stat.uid,
      gid: stat.gid,
    },
  };
}
