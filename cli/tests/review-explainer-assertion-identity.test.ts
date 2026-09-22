import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertPrDecision } from "@shared/runtime/review-explainer/pr-decisions";
import { describe, expect, it } from "vitest";
import { PR_URL } from "../../tests/review-explainer/contract";
import { extractFindingsFromReport } from "../src/auto/ledger";
import { projectPrDecisions } from "../src/auto/pr-decisions";

describe("A05 persisted undecorated assertions remain bounded through the CLI ledger", () => {
  it("real extraction → persisted skip → same-ID successor with another mechanism remains open", () => {
    const home = mkdtempSync(join(tmpdir(), "ck-skip-new-mechanism-"));
    try {
      const extract = (text: string) =>
        extractFindingsFromReport({
          markdown: [
            "# Autonomous Review Report",
            "",
            "---",
            "## Overview",
            "fixture",
            "## Consensus findings",
            `- [major] ${text}`,
            "## Unique findings",
            "",
            "## Disagreements",
            "",
            "## Verdict",
            "comment",
          ].join("\n"),
          runId: "ck-review-11111111-1111-4111-8111-111111111111",
          extractedAt: "2026-09-23T00:00:00.000Z",
          sha: "a".repeat(40),
        });
      const original = extract("Shutdown may return before releasing a lease. src/session.ts:12");
      expect(original.findings).toHaveLength(1);
      const finding = original.findings[0];
      if (!finding) throw new Error("Missing original fixture finding");
      const decision = upsertPrDecision({
        home,
        prUrl: PR_URL,
        finding,
        decision: "wont_fix",
        expectedRevision: 0,
      });
      const successor = extract(
        `\`${finding.id}\` — ${finding.text} New mechanism: after restart, an unrelated session can delete the active lease.`,
      );
      expect(successor.findings).toHaveLength(1);
      expect(successor.findings[0]?.id).toBe(finding.id);
      const projected = projectPrDecisions(successor, decision);
      expect(projected.findings[0]?.text).toContain("New mechanism: after restart");
      expect(projected.findings[0]?.status).toBe("open");
      expect(projected.findings[0]?.acceptedReason).toBeUndefined();
      expect(projected.findings[0]?.acceptedAt).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
