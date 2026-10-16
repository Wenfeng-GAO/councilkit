import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRepairBranchHints } from "../../runtime-host/repair-branch-hints";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveRepairBranchHints", () => {
  it("does not read frozen hints through an ancestor symlink", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ck-ancestor-hints-"));
    dirs.push(parent);
    const outside = join(parent, "outside");
    const runDir = join(outside, "runs", "abc");
    mkdirSync(runDir, { recursive: true });
    const body = "- source: `secret-feature`\n- target: `secret-base`\n";
    writeFileSync(join(runDir, "review-context.md"), body);
    writeFileSync(
      join(runDir, "invocation-manifest.v1.json"),
      `${JSON.stringify({ repoRealpath: outside })}\n`,
    );
    const managed = join(parent, "managed");
    symlinkSync(outside, managed);

    const hints = await resolveRepairBranchHints({
      runId: "abc",
      prUrl: null,
      env: { ...process.env, COUNCILKIT_HOME: managed },
    });

    expect(hints.sourceBranch).toBeNull();
    expect(hints.base).toBeNull();
    expect(readFileSync(join(runDir, "review-context.md"), "utf8")).toBe(body);
  });
});
