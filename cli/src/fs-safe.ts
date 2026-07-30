/**
 * Shared filesystem-safety primitives for commands that recursively delete or
 * create directories inside the runs tree (`runs gc`, `review`). The trust
 * model: the runs ROOT is bound ONCE (lstat proves a real directory, realpath
 * + dev/ino pin its canonical location and identity) and every target is validated against that
 * BOUND root — never against a root re-resolved later, which could have been
 * swapped for a symlink to an external tree in between (reviewer findings).
 */
import { type Stats, lstatSync, realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { errors } from "./errors";

/** A trusted root pinned at bind time. */
export interface TrustedRoot {
  /** Lexical path the root was bound from. */
  path: string;
  /** Canonical realpath captured at bind time. */
  realPath: string;
  /** Device of the bound directory (lstat at bind time). */
  dev: number;
  /** Inode of the bound directory (lstat at bind time): a same-path
   * REPLACEMENT (delete + fresh real directory) keeps the realpath string but
   * gets a new inode, so the realpath alone cannot detect it. */
  ino: number;
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
  try {
    return { path: root, realPath: realpathSync(root), dev: stat.dev, ino: stat.ino };
  } catch (cause) {
    throw errors.io(`cannot resolve the trusted root: ${ioName(cause)}`, { cause: ioName(cause) });
  }
}

/**
 * Re-validate a bound root against the CURRENT filesystem: it must still be a
 * real directory resolving to the SAME realpath pinned at bind time AND the
 * SAME dev+inode. A root swapped since bind time (deleted, replaced, or turned
 * into a symlink — even one resolving to a tree shaped like the original, and
 * even a same-path replacement by another REAL directory, which keeps the
 * realpath but not the inode) is fail-closed exit 5.
 */
export function revalidateTrustedRoot(bound: TrustedRoot): void {
  let stat: Stats;
  let realPath: string;
  try {
    stat = lstatSync(bound.path);
    realPath = realpathSync(bound.path);
  } catch (cause) {
    throw errors.io(`the trusted root changed: ${ioName(cause)}`, { cause: ioName(cause) });
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realPath !== bound.realPath ||
    stat.dev !== bound.dev ||
    stat.ino !== bound.ino
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
