import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewWorkspace } from "@host/review-explainer/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { FINDING } from "../../review-explainer/contract";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";

describe("review workspace cited line ranges", () => {
  const homes: string[] = [];
  const oldHome = process.env.COUNCILKIT_HOME;

  afterEach(() => {
    if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
    else process.env.COUNCILKIT_HOME = oldHome;
    for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a start-end citation when the start line is inside the frozen diff", () => {
    const home = mkdtempSync(join(tmpdir(), "ck-anchor-range-"));
    homes.push(home);
    process.env.COUNCILKIT_HOME = home;
    const seeded = seedReviewRun(home);
    const start = seeded.repo.busyNewLine;
    const end = start + 2;
    const contextStart = seeded.repo.busyContextLine;
    const ledgerPath = join(seeded.runDir, "findings.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      findings: Array<{ id: string; text: string }>;
    };
    const row = ledger.findings.find((finding) => finding.id === FINDING.busy);
    if (!row) throw new Error("missing busy finding");
    row.text = `src/busy.go:${start}-${end} in the hunk. src/busy.go:${contextStart}-${contextStart + 2} outside the hunk.`;
    writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);

    const workspace = reviewWorkspace(seeded.runId);
    const finding = workspace.findings.find((item) => item.id === FINDING.busy);
    const resolved = finding?.anchors.find(
      (anchor) => anchor.status === "resolved" && anchor.line === start,
    );
    const context = finding?.anchors.find(
      (anchor) => anchor.status === "context" && anchor.line === contextStart,
    );

    expect(resolved).toMatchObject({
      path: "src/busy.go",
      side: "new",
      line: start,
      endLine: end,
    });
    expect(context).toMatchObject({
      path: "src/busy.go",
      side: "new",
      line: contextStart,
      endLine: contextStart + 2,
    });
  });
});
