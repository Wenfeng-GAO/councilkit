/**
 * Atomic write and readFileText behavior that does not need a mocked fs.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors";
import { atomicWriteFile, atomicWriteJson, readFileText } from "../src/store/atomic-write";

const dirs: string[] = [];
const asRoot = process.getuid?.() === 0;

function makeParent(): string {
  const parent = mkdtempSync(join(tmpdir(), "ck-store-atomic-"));
  chmodSync(parent, 0o700);
  dirs.push(parent);
  return parent;
}

function cliError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected CliError");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("atomicWriteFile", () => {
  it("creates a 0700 parent, writes exact bytes at 0600, and leaves no tmp file", () => {
    const parent = makeParent();
    const file = join(parent, "nested", "note.txt");
    expect(atomicWriteFile(file, "héllo")).toBe(6);
    expect(readFileSync(file, "utf8")).toBe("héllo");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(parent, "nested")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(parent, "nested")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces an existing file and reports 0 bytes for an empty payload", () => {
    const parent = makeParent();
    const file = join(parent, "note.txt");
    expect(atomicWriteFile(file, "one")).toBe(3);
    expect(atomicWriteFile(file, "")).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("throws EISDIR when the target is a directory and removes the tmp file", () => {
    const parent = makeParent();
    const target = join(parent, "target");
    mkdirSync(target, { mode: 0o700 });
    let code = "";
    try {
      atomicWriteFile(target, "nope");
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    expect(code).toBe("EISDIR");
    expect(readdirSync(target)).toEqual([]);
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("atomicWriteJson", () => {
  it("writes pretty JSON with a trailing newline and returns the byte length", () => {
    const parent = makeParent();
    const file = join(parent, "row.json");
    const expected = `${JSON.stringify({ name: "é" }, null, 2)}\n`;
    expect(atomicWriteJson(file, { name: "é" })).toBe(Buffer.byteLength(expected));
    expect(readFileSync(file, "utf8")).toBe(expected);
  });
});

describe("readFileText", () => {
  it("returns null when the path is missing, including a missing parent", () => {
    const parent = makeParent();
    expect(readFileText(join(parent, "missing.txt"))).toBeNull();
    expect(readFileText(join(parent, "no-parent", "missing.txt"))).toBeNull();
  });

  it("returns the exact UTF-8 contents of a regular file", () => {
    const parent = makeParent();
    const file = join(parent, "note.txt");
    writeFileSync(file, "line\n");
    expect(readFileText(file)).toBe("line\n");
  });

  it("follows a symlink to a file and rejects a symlink to a directory", () => {
    const parent = makeParent();
    const target = join(parent, "target.txt");
    const dir = join(parent, "dir");
    writeFileSync(target, "via-symlink");
    mkdirSync(dir, { mode: 0o700 });
    const fileLink = join(parent, "file-link");
    const dirLink = join(parent, "dir-link");
    symlinkSync(target, fileLink);
    symlinkSync(dir, dirLink);
    expect(readFileText(fileLink)).toBe("via-symlink");
    const err = cliError(() => readFileText(dirLink));
    expect(err.exitCode).toBe(5);
    expect(err.message).toBe(
      `"${dirLink}" is not a regular file (mode=40700); refusing to overwrite a non-regular managed file`,
    );
  });

  it("returns null for a dangling symlink", () => {
    const parent = makeParent();
    const link = join(parent, "dangling");
    symlinkSync(join(parent, "missing-target"), link);
    expect(readFileText(link)).toBeNull();
  });

  it("rejects a directory with its mode in the IO error", () => {
    const parent = makeParent();
    const dir = join(parent, "not-a-file");
    mkdirSync(dir, { mode: 0o700 });
    const err = cliError(() => readFileText(dir));
    expect(err.exitCode).toBe(5);
    expect(err.message).toBe(
      `"${dir}" is not a regular file (mode=40700); refusing to overwrite a non-regular managed file`,
    );
  });

  it.skipIf(asRoot)("reports EACCES from stat when the parent directory is not searchable", () => {
    const parent = makeParent();
    const blocked = join(parent, "blocked");
    mkdirSync(blocked, { mode: 0o700 });
    const file = join(blocked, "secret.txt");
    writeFileSync(file, "hidden");
    chmodSync(blocked, 0o000);
    try {
      const err = cliError(() => readFileText(file));
      expect(err.exitCode).toBe(5);
      expect(err.message).toBe(`cannot stat "${file}": EACCES`);
    } finally {
      chmodSync(blocked, 0o700);
    }
  });

  it.skipIf(asRoot)("reports EACCES from read when the file itself is mode 000", () => {
    const parent = makeParent();
    const file = join(parent, "secret.txt");
    writeFileSync(file, "hidden");
    chmodSync(file, 0o000);
    try {
      const err = cliError(() => readFileText(file));
      expect(err.exitCode).toBe(5);
      expect(err.message).toBe(`cannot read "${file}": EACCES`);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, "utf8")).toBe("hidden");
  });
});
