/**
 * A regular file under an existing child of a symlinked directory must not be
 * read or created. Leaf lstat follows that ancestor.
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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSESSMENT_CORRECTIONS_FILE,
  loadAssessmentCorrections,
} from "../src/auto/assessment-correction";
import { readFindingGroupsFile } from "../src/auto/finding-groups";
import { readFindings } from "../src/auto/ledger";
import { readReviewRepairPackage } from "../src/auto/repair-acceptance";
import { REPAIR_JOURNAL_FILE, appendRepairJournal } from "../src/auto/repair-persist";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function escapedNested(fileName: string, body: string): { lexical: string; outsideFile: string } {
  const parent = mkdtempSync(join(tmpdir(), "ck-ancestor-read-"));
  dirs.push(parent);
  const outside = join(parent, "outside");
  const nested = join(outside, "nested");
  mkdirSync(nested, { recursive: true });
  const outsideFile = join(nested, fileName);
  writeFileSync(outsideFile, body);
  const managed = join(parent, "managed");
  symlinkSync(outside, managed);
  return { lexical: join(managed, "nested"), outsideFile };
}

describe("ancestor symlink reads and the repair journal", () => {
  it("does not create a repair journal in an existing directory reached through a symlink", () => {
    const { lexical, outsideFile } = escapedNested("keep.txt", "SECRET\n");

    expect(() => appendRepairJournal(lexical, { kind: "note" })).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(readFileSync(outsideFile, "utf8")).toBe("SECRET\n");
    expect(() => lstatSync(join(lexical, REPAIR_JOURNAL_FILE))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => lstatSync(join(dirname(outsideFile), REPAIR_JOURNAL_FILE))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("still appends a journal in a real directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ck-ancestor-read-"));
    dirs.push(parent);
    const runDir = join(parent, "run");
    mkdirSync(runDir);

    appendRepairJournal(runDir, { kind: "note" });

    expect(readFileSync(join(runDir, REPAIR_JOURNAL_FILE), "utf8")).toContain('"kind":"note"');
  });

  it("does not read findings through an ancestor symlink", () => {
    const { lexical, outsideFile } = escapedNested("findings.json", "SECRET\n");

    expect(() => readFindings(lexical)).toThrow(/is not a regular file/);
    expect(readFileSync(outsideFile, "utf8")).toBe("SECRET\n");
  });

  it("does not read finding groups through an ancestor symlink", () => {
    const body = `${JSON.stringify({
      version: 1,
      kind: "councilkit-finding-groups",
      source: {
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        sha: "a".repeat(40),
        findingsSha256: "b".repeat(64),
        againstRunId: null,
      },
      groups: [],
    })}\n`;
    const { lexical, outsideFile } = escapedNested("finding-groups.v1.json", body);

    expect(() => readFindingGroupsFile(join(lexical, "finding-groups.v1.json"))).toThrow(
      /not a regular file/,
    );
    expect(readFileSync(outsideFile, "utf8")).toBe(body);
  });

  it("does not read assessment corrections through an ancestor symlink", () => {
    const body = `${JSON.stringify({
      version: 1,
      kind: "councilkit-assessment-corrections",
      records: [],
    })}\n`;
    const { lexical, outsideFile } = escapedNested(ASSESSMENT_CORRECTIONS_FILE, body);

    expect(loadAssessmentCorrections(lexical)).toBeNull();
    expect(readFileSync(outsideFile, "utf8")).toBe(body);
  });

  it("does not read a repair package through an ancestor symlink", () => {
    const { lexical, outsideFile } = escapedNested("repair-package.json", "SECRET\n");

    expect(() =>
      readReviewRepairPackage({
        path: join(lexical, "repair-package.json"),
        findings: [],
      }),
    ).toThrow(/普通 JSON 文件/);
    expect(readFileSync(outsideFile, "utf8")).toBe("SECRET\n");
  });
});
