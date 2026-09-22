import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export class ExplainerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function readBounded(path: string, maxBytes: number, optional = false): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new ExplainerError("Invalid or oversized stored artifact", 400);
    const value = readFileSync(fd);
    if (value.length > maxBytes) throw new ExplainerError("Stored artifact exceeds size limit");
    return value.toString("utf8");
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ExplainerError) throw error;
    throw new ExplainerError(
      "Cannot read stored artifact (unsafe path or storage I/O failure)",
      500,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function assertPrivatePath(root: string, target: string, allowMissing = false): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel.startsWith("..") || rel.startsWith("/"))
    throw new ExplainerError("Path outside permitted artifacts", 403);
  let current = resolve(root);
  for (const part of ["", ...rel.split("/").filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new ExplainerError("Symlink artifact is not permitted", 403);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof ExplainerError) throw error;
      throw new ExplainerError("Stored artifact path unavailable", 500);
    }
  }
}
export function atomicJson(path: string, value: unknown): void {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch {
    throw new ExplainerError("Cannot persist artifact: storage write failure", 500);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* no staged file */
    }
  }
}
