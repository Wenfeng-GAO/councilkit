import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, sep } from "node:path";
import { errors } from "./errors";

/**
 * Closes the directory fd when the TrustedRoot is collected. The fd has to
 * stay open until collection. On ext4, delete + mkdir at the same path
 * recycles the directory inode once nothing holds it, so a dev/ino snapshot
 * alone cannot see the swap.
 */
const closePinnedDirectoryOnCollect = new FinalizationRegistry<number>((fd) => {
  try {
    closeSync(fd);
  } catch {}
});

/** A trusted root pinned at bind time. */
export interface TrustedRoot {
  /** Lexical path the root was bound from. */
  path: string;
  /** Canonical realpath captured at bind time. */
  realPath: string;
  /** Device of the held directory fd. */
  dev: number;
  /** Inode of the held directory fd. */
  ino: number;
  /** Open directory fd. Keeps the bound inode allocated for the life of this object. */
  fd: number;
}

/**
 * Bind a trusted root: lstat must prove a REAL directory (never a symlink)
 * and realpath pins its canonical location. Returns null ONLY when the root
 * does not exist (ENOENT) — the caller decides whether that is an empty
 * success. Any other stat/resolve failure, or a symlinked root, is exit 5.
 */
export function bindTrustedRoot(root: string): TrustedRoot | null {
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch (cause) {
    if (ioCode(cause) === "ENOENT") return null;
    throw errors.io(`cannot stat the trusted root: ${ioName(cause)}`, { cause: ioName(cause) });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw errors.io("the trusted root is not a real directory (refusing to proceed)");
  }
  let fd: number;
  try {
    fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (cause) {
    throw errors.io(`cannot resolve the trusted root: ${ioName(cause)}`, { cause: ioName(cause) });
  }
  try {
    const pinned = fstatSync(fd);
    const bound: TrustedRoot = {
      path: root,
      realPath: realpathSync(root),
      dev: pinned.dev,
      ino: pinned.ino,
      fd,
    };
    closePinnedDirectoryOnCollect.register(bound, fd);
    return bound;
  } catch (cause) {
    try {
      closeSync(fd);
    } catch {}
    throw errors.io(`cannot resolve the trusted root: ${ioName(cause)}`, { cause: ioName(cause) });
  }
}

/**
 * Re-validate a bound root against the CURRENT filesystem. The path must still
 * be a real directory at the pinned realpath, and it must still be the held
 * directory fd. `fstat` on that fd reports nlink 0 after the directory is
 * unlinked, which catches a same-path recreate even when the new directory
 * would otherwise recycle the inode.
 */
export function revalidateTrustedRoot(bound: TrustedRoot): void {
  let stat: Stats;
  let realPath: string;
  let pinned: Stats;
  try {
    pinned = fstatSync(bound.fd);
    stat = lstatSync(bound.path);
    realPath = realpathSync(bound.path);
  } catch (cause) {
    throw errors.io(`the trusted root changed: ${ioName(cause)}`, { cause: ioName(cause) });
  }
  if (
    pinned.nlink === 0 ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realPath !== bound.realPath ||
    stat.dev !== pinned.dev ||
    stat.ino !== pinned.ino
  ) {
    throw errors.io("the trusted root changed (refusing to proceed)");
  }
}

/**
 * Assert that `target` (which may not exist yet) stays strictly INSIDE the
 * bound root. Every existing component between the root and the target must
 * be a real directory — a symlink at ANY level is fail-closed — and the
 * nearest existing ancestor's REAL path must resolve under the bound realpath
 * (a lexical check alone is blind to an intermediate symlink pointing outside
 * the tree). Missing components are fine: they will be created fresh.
 */
export function assertWithinRoot(bound: TrustedRoot, target: string): void {
  let cursor = target;
  let containmentChecked = false;
  while (cursor !== bound.path) {
    let stat: Stats | null = null;
    try {
      stat = lstatSync(cursor);
    } catch (cause) {
      if (ioCode(cause) !== "ENOENT") {
        throw errors.io(`cannot stat a path component: ${ioName(cause)}`, {
          cause: ioName(cause),
        });
      }
    }
    if (stat !== null) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw errors.io("a path component is not a real directory (refusing to proceed)");
      }
      if (!containmentChecked) {
        containmentChecked = true;
        // lstat shields only the LEAF component, so this realpath resolves any
        // symlink ABOVE the first existing component — that is where an
        // escaped intermediate symlink is caught.
        let realAncestor: string;
        try {
          realAncestor = realpathSync(cursor);
        } catch (cause) {
          throw errors.io(`cannot resolve a path component: ${ioName(cause)}`, {
            cause: ioName(cause),
          });
        }
        if (realAncestor !== bound.realPath && !realAncestor.startsWith(bound.realPath + sep)) {
          throw errors.io("a path resolves outside the trusted root (refusing to proceed)");
        }
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      // Walked past the bound root without reaching it — the target was never
      // lexically inside it.
      throw errors.io("a path is outside the trusted root (refusing to proceed)");
    }
    cursor = parent;
  }
}

function ioCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

function ioName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return "IOFailure";
}
