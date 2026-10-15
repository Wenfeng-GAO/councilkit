import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODULES } from "../../review-explainer/contract";
import {
  BUSY_SNIPPET,
  JAVA_SNIPPET,
  README_SNIPPET,
  SAMPLE_DIFF,
  SAMPLE_EXPECT,
} from "../../review-explainer/fixtures/sample-diff";
import { createSyntheticRepo } from "../../review-explainer/fixtures/synthetic-repo";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

interface DiffLine {
  type: string;
  text: string;
  oldLine?: number | null;
  newLine?: number | null;
}
interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}
interface DiffFile {
  path: string;
  oldPath?: string | null;
  status: string;
  binary?: boolean;
  missing?: boolean;
  hunks?: DiffHunk[];
}

describe("A01 parseFrozenDiff", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function parser() {
    const mod = await importFeature<Record<string, unknown>>(MODULES.diff);
    return requireExport<(diff: string) => { files: DiffFile[] }>(
      mod,
      "parseFrozenDiff",
      MODULES.diff,
    );
  }

  it("parses every file in the frozen unified diff including uncommented ones", async () => {
    const parseFrozenDiff = await parser();
    const parsed = parseFrozenDiff(SAMPLE_DIFF);
    const paths = parsed.files.map((file) => file.path);
    expect(paths).toEqual(SAMPLE_EXPECT.files.map((file) => file.path));
    const readme = parsed.files.find((file) => file.path === "README.md");
    expect(readme?.status).toMatch(/modif/);
    const added = (readme?.hunks ?? [])
      .flatMap((hunk) => hunk.lines)
      .filter((line) => line.type === "add");
    expect(added.some((line) => line.text.includes(README_SNIPPET))).toBe(true);
    const java = parsed.files.find((file) => file.path === "tests/WideCoverage.java");
    expect(java).toBeTruthy();
    expect(
      (java?.hunks ?? [])
        .flatMap((hunk) => hunk.lines)
        .some((line) => line.text.includes(JAVA_SNIPPET)),
    ).toBe(true);
  });

  it("keeps old/new line numbers and does not count context as additions", async () => {
    const parseFrozenDiff = await parser();
    const parsed = parseFrozenDiff(SAMPLE_DIFF);
    const busy = parsed.files.find((file) => file.path === "src/busy.go");
    expect(busy).toBeTruthy();
    const lines = (busy?.hunks ?? []).flatMap((hunk) => hunk.lines);
    const hit = lines.find((line) => line.text.includes(BUSY_SNIPPET));
    expect(hit?.type).toBe("add");
    expect(hit?.newLine).toBe(SAMPLE_EXPECT.busyNewLine);
    expect(hit?.oldLine === null || hit?.oldLine === undefined).toBe(true);
    const context = lines.find((line) => line.text.includes("func Handle"));
    expect(context?.type).toMatch(/ctx|context|same/);
    const addedCount = lines.filter((line) => line.type === "add").length;
    expect(addedCount).toBe(4);
  });

  it("marks added, deleted, renamed, and binary files without forging binary as code", async () => {
    const parseFrozenDiff = await parser();
    const parsed = parseFrozenDiff(SAMPLE_DIFF);
    const added = parsed.files.find((file) => file.path === "src/recovery.go");
    expect(added?.status).toMatch(/add/);
    const deleted = parsed.files.find((file) => file.path === "src/deleted.go");
    expect(deleted?.status).toMatch(/del/);
    const renamed = parsed.files.find((file) => file.path === "src/renamed.go");
    expect(renamed?.status).toMatch(/rename/);
    expect(renamed?.oldPath).toBe("src/old_name.go");
    const binary = parsed.files.find((file) => file.path === "assets/icon.bin");
    expect(binary?.binary).toBe(true);
    const binaryText = JSON.stringify(binary);
    expect(binaryText.includes("\u0000")).toBe(false);
    expect((binary?.hunks ?? []).flatMap((hunk) => hunk.lines).length).toBe(0);
  });

  it("keeps a space in the path when git appends an empty timestamp tab", async () => {
    const parseFrozenDiff = await parser();
    const diff = [
      "diff --git a/my file.txt b/my file.txt",
      "index 3367afd..3e75765 100644",
      "--- a/my file.txt\t",
      "+++ b/my file.txt\t",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const parsed = parseFrozenDiff(diff);
    const file = parsed.files[0];
    expect(file?.path).toBe("my file.txt");
    const added = (file?.hunks ?? [])
      .flatMap((hunk) => hunk.lines)
      .find((line) => line.type === "add");
    expect(added?.text).toBe("new");
  });

  it("decodes a quoted non-ASCII path and ignores the timestamp tab outside the quotes", async () => {
    const parseFrozenDiff = await parser();
    const diff = [
      'diff --git "a/you \\344\\275\\240.txt" "b/you \\344\\275\\240.txt"',
      "index 3367afd..3e75765 100644",
      '--- "a/you \\344\\275\\240.txt"\t',
      '+++ "b/you \\344\\275\\240.txt"\t',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const parsed = parseFrozenDiff(diff);
    expect(parsed.files.map((file) => file.path)).toEqual(["you 你.txt"]);
  });

  it("reads a binary path that itself contains a b/ segment", async () => {
    const parseFrozenDiff = await parser();
    const diff = [
      "diff --git a/foo b/bar.bin b/foo b/bar.bin",
      "index 20b5be9..88f3700 100644",
      "Binary files a/foo b/bar.bin and b/foo b/bar.bin differ",
      "",
    ].join("\n");
    const parsed = parseFrozenDiff(diff);
    expect(parsed.files).toEqual([
      expect.objectContaining({ path: "foo b/bar.bin", binary: true, hunks: [] }),
    ]);
  });

  it("reads a diff --git header when only the old path is C-quoted", async () => {
    const parseFrozenDiff = await parser();
    const diff = [
      'diff --git "a/quote\\"a.txt" b/plain.txt',
      "index 20b5be9..88f3700 100644",
      'Binary files "a/quote\\"a.txt" and b/plain.txt differ',
      "",
    ].join("\n");
    const parsed = parseFrozenDiff(diff);
    expect(parsed.files[0]).toEqual(
      expect.objectContaining({
        path: "plain.txt",
        oldPath: 'quote"a.txt',
        newPath: "plain.txt",
        binary: true,
      }),
    );
  });

  it("reads a diff --git header when only the new path is C-quoted", async () => {
    const parseFrozenDiff = await parser();
    const diff = [
      'diff --git a/other.txt "b/quote\\"b.txt"',
      "index 20b5be9..88f3700 100644",
      'Binary files a/other.txt and "b/quote\\"b.txt" differ',
      "",
    ].join("\n");
    const parsed = parseFrozenDiff(diff);
    expect(parsed.files[0]).toEqual(
      expect.objectContaining({
        path: 'quote"b.txt',
        oldPath: "other.txt",
        newPath: 'quote"b.txt',
        binary: true,
      }),
    );
  });

  it("keeps rename paths when git quotes only one side of diff --git", async () => {
    const parseFrozenDiff = await parser();
    const diff = [
      'diff --git "a/quote\\"a.txt" b/plain.txt',
      "similarity index 100%",
      'rename from "quote\\"a.txt"',
      "rename to plain.txt",
      'diff --git a/other.txt "b/quote\\"b.txt"',
      "similarity index 100%",
      "rename from other.txt",
      'rename to "quote\\"b.txt"',
      "",
    ].join("\n");
    const parsed = parseFrozenDiff(diff);
    expect(parsed.files.map((file) => ({ path: file.path, oldPath: file.oldPath }))).toEqual([
      { path: "plain.txt", oldPath: 'quote"a.txt' },
      { path: 'quote"b.txt', oldPath: "other.txt" },
    ]);
  });

  it("keeps a quotation mark that git C-quoted in the path", async () => {
    const parseFrozenDiff = await parser();
    const diff = [
      'diff --git "a/quote\\"name.txt" "b/quote\\"name.txt"',
      "index 3367afd..3e75765 100644",
      '--- "a/quote\\"name.txt"',
      '+++ "b/quote\\"name.txt"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const parsed = parseFrozenDiff(diff);
    expect(parsed.files.map((file) => file.path)).toEqual(['quote"name.txt']);
  });

  it.each(["\\b", "\\r", "\\a", "\\v", "\\f"])(
    "rejects a %s C escape instead of turning it into a different path",
    async (token) => {
      const parseFrozenDiff = await parser();
      const diff = [
        `diff --git "a/safe${token}.go" "b/safe${token}.go"`,
        "index 3367afd..3e75765 100644",
        `--- "a/safe${token}.go"`,
        `+++ "b/safe${token}.go"`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      expect(() => parseFrozenDiff(diff)).toThrow("Invalid repository-relative path");
    },
  );

  it("matches a real git-generated colorless diff byte-for-byte on hunk counts", async () => {
    const parseFrozenDiff = await parser();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-diff-"));
    roots.push(root);
    const repo = createSyntheticRepo(root);
    const parsed = parseFrozenDiff(repo.diff);
    expect(parsed.files.length).toBeGreaterThanOrEqual(6);
    const busy = parsed.files.find((file) => file.path === "src/busy.go");
    const hit = (busy?.hunks ?? [])
      .flatMap((hunk) => hunk.lines)
      .find((line) => line.text.includes(BUSY_SNIPPET));
    expect(hit?.newLine).toBe(repo.busyNewLine);
    expect(Buffer.byteLength(repo.diff, "utf8")).toBeGreaterThan(200);
    expect(repo.diffHash).toHaveLength(64);
  });
});
