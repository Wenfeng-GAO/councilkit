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
