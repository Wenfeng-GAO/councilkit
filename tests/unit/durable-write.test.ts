/**
 * Managed writes must not follow a destination symlink.
 * Rename replaces the link. O_NOFOLLOW append refuses it, including a dangling link.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPrivateFile,
  openNoFollowAppend,
  readPrivateText,
  replacePrivateFile,
} from "@shared/runtime/durable-write";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

function makeParent(): string {
  const parent = mkdtempSync(join(tmpdir(), "ck-durable-write-"));
  dirs.push(parent);
  return parent;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("replacePrivateFile", () => {
  it("replaces a symlink and leaves the target bytes untouched", () => {
    const parent = makeParent();
    const outside = join(parent, "outside.txt");
    const link = join(parent, "managed.txt");
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, link);

    expect(replacePrivateFile(link, "NEW\n")).toBe(4);

    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf8")).toBe("NEW\n");
    expect(lstatSync(link).mode & 0o777).toBe(0o600);
  });

  it("returns 0 and writes an empty regular file", () => {
    const parent = makeParent();
    const file = join(parent, "empty.txt");
    expect(replacePrivateFile(file, "")).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("creates a missing parent directory and writes the file there", () => {
    const parent = makeParent();
    const file = join(parent, "sub", "note.txt");
    expect(replacePrivateFile(file, "ok\n")).toBe(3);
    expect(readFileSync(file, "utf8")).toBe("ok\n");
    expect(lstatSync(join(parent, "sub")).isDirectory()).toBe(true);
  });

  it("does not write through a parent directory symlink", () => {
    const parent = makeParent();
    const outside = join(parent, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "SECRET\n");
    const link = join(parent, "managed");
    symlinkSync(outside, link);

    expect(() => replacePrivateFile(join(link, "new.txt"), "NEW\n")).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("SECRET\n");
    expect(() => lstatSync(join(outside, "new.txt"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("does not create a nested directory through an ancestor symlink", () => {
    const parent = makeParent();
    const outside = join(parent, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "SECRET\n");
    const link = join(parent, "managed");
    symlinkSync(outside, link);

    expect(() => replacePrivateFile(join(link, "nested", "new.txt"), "NEW\n")).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("SECRET\n");
    expect(() => lstatSync(join(outside, "nested"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe("appendPrivateFile", () => {
  it("appends to a regular file", () => {
    const parent = makeParent();
    const file = join(parent, "log.txt");
    expect(appendPrivateFile(file, "one\n")).toBe(4);
    expect(appendPrivateFile(file, "two\n")).toBe(4);
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  it("refuses a symlink to an existing file", () => {
    const parent = makeParent();
    const outside = join(parent, "outside.txt");
    const link = join(parent, "managed.txt");
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, link);

    expect(() => appendPrivateFile(link, "APPENDED\n")).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("does not append through a parent directory symlink", () => {
    const parent = makeParent();
    const outside = join(parent, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "SECRET\n");
    const link = join(parent, "managed");
    symlinkSync(outside, link);

    expect(() => appendPrivateFile(join(link, "log.txt"), "APPENDED\n")).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("SECRET\n");
    expect(() => lstatSync(join(outside, "log.txt"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("refuses a dangling symlink without creating the target", () => {
    const parent = makeParent();
    const outside = join(parent, "missing-target.txt");
    const link = join(parent, "managed.txt");
    symlinkSync(outside, link);

    expect(() => appendPrivateFile(link, "APPENDED\n")).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(() => lstatSync(outside)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe("openNoFollowAppend", () => {
  it("does not create the target of a dangling symlink", () => {
    const parent = makeParent();
    const outside = join(parent, "missing-target.txt");
    const link = join(parent, "managed.txt");
    symlinkSync(outside, link);
    expect(() => openNoFollowAppend(link)).toThrow(expect.objectContaining({ code: "ELOOP" }));
    expect(() => lstatSync(outside)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});

describe("readPrivateText", () => {
  it("returns null for a symlink and does not read the target", () => {
    const parent = makeParent();
    const outside = join(parent, "outside.txt");
    const link = join(parent, "managed.txt");
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, link);
    expect(readPrivateText(link)).toBeNull();
    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
  });

  it("reads a regular file and returns null when the path is missing", () => {
    const parent = makeParent();
    const file = join(parent, "note.txt");
    writeFileSync(file, "hello\n");
    expect(readPrivateText(file)).toBe("hello\n");
    expect(readPrivateText(join(parent, "missing.txt"))).toBeNull();
  });
});
