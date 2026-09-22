import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFindingVerifiedClosed } from "@shared/runtime/cli-ledger";
import { evaluateRepairGate } from "@shared/runtime/repair-gate";
import { repairPackageSchema } from "@shared/runtime/repair-package";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ExplainerHttpHost,
  createExplainerHttpHost,
} from "../../tests/host/review-explainer/http-helpers";
import {
  commitCandidate,
  fakeCliPath,
  makeSink,
  readLedger,
  reportOutput,
  runSyntheticReview,
  seedAgents,
} from "../../tests/review-explainer/cli-harness";
import {
  ASSERTION,
  FINDING,
  PR_URL,
  REPAIR_PACKAGE_REVIEW_FLAG,
  ROUTES,
  SELECTED_EXPORT_FLAG,
  prDecisionsPath,
} from "../../tests/review-explainer/contract";
import { seedReviewRun } from "../../tests/review-explainer/fixtures/seed-run";
import { required } from "../../tests/review-explainer/load-feature";
import { appendLanding, loadAgainstContext } from "../src/auto/ledger";
import { createRepairHandoff } from "../src/auto/repair-handoff";
import { runRepair } from "../src/commands/repair";

let home: string;
let host: ExplainerHttpHost | undefined;
const previousHome = process.env.COUNCILKIT_HOME;
const previousPath = process.env.PATH;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-explainer-pkg-"));
  process.env.COUNCILKIT_HOME = home;
  process.env.PATH = fakeCliPath(home, previousPath);
});
afterEach(async () => {
  await host?.close();
  host = undefined;
  if (previousHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = previousHome;
  if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
  else process.env.PATH = previousPath;
  rmSync(home, { recursive: true, force: true });
});

describe("A06 selected export and candidate verification through production CLI", () => {
  it("keeps the old explicit CLI export path available without --selected", async () => {
    const seeded = seedReviewRun(home, { legacy: true });
    const target = join(home, "legacy-repair.json");
    const original = readFileSync(join(seeded.runDir, "findings.json"), "utf8");
    await runRepair(["export", "--run", seeded.runId, "--out", target], makeSink());
    const pkg = repairPackageSchema.parse(JSON.parse(readFileSync(target, "utf8")));
    expect(pkg.findings.map((row) => row.id).sort()).toEqual(
      Object.values(FINDING)
        .filter((id) => id !== FINDING.freshSameFile)
        .sort(),
    );
    expect(readFileSync(join(seeded.runDir, "findings.json"), "utf8")).toBe(original);
  });

  it("real decision API → CLI export → durable task → candidate claim → --against retains selected assertions", async () => {
    const agents = seedAgents();
    const seeded = seedReviewRun(home, { legacy: true });
    host = await createExplainerHttpHost({ home });
    const decisionResponse = await fetch(`${host.baseUrl}${ROUTES.decisions(seeded.runId)}`, {
      method: "POST",
      headers: host.headers(),
      body: JSON.stringify({ findingId: FINDING.busy, decision: "will_fix", expectedRevision: 0 }),
    });
    expect(decisionResponse.status).toBe(200);
    const decisions = JSON.parse(readFileSync(prDecisionsPath(home, PR_URL), "utf8"));
    expect(decisions.items[FINDING.busy].decision).toBe("will_fix");
    const sourceBefore = readLedger(home, seeded.runId);
    expect(sourceBefore.findings.find((row) => row.id === FINDING.busy)?.status).toBe("open");

    const packagePath = join(home, "selected-repair.json");
    await runRepair(
      ["export", "--run", seeded.runId, SELECTED_EXPORT_FLAG, "--out", packagePath],
      makeSink(),
    );
    const packageBytes = readFileSync(packagePath, "utf8");
    const pkg = repairPackageSchema.parse(JSON.parse(packageBytes));
    expect(pkg.source).toEqual({ runId: seeded.runId, sha: seeded.repo.headSha, prUrl: PR_URL });
    expect(pkg.findings.map((row) => row.id)).toEqual([FINDING.busy]);
    expect(pkg.findings[0]?.evidence).toContain(ASSERTION.busy);
    expect(pkg.findings[0]?.evidence).toContain(ASSERTION.busyCounterexample);
    expect(pkg.findings[0]?.evidence).toContain(ASSERTION.busyExpected);
    expect(pkg.constraints.deferred.map((row) => row.id)).toContain(FINDING.stale);
    const httpPackage = await fetch(`${host.baseUrl}${ROUTES.repairPackage(seeded.runId)}`, {
      headers: host.headers(),
    });
    expect(httpPackage.status).toBe(200);
    expect((await httpPackage.json()).data).toEqual(pkg);

    // Production handoff persistence creates actual task input, not an in-memory helper assertion.
    const handoff = createRepairHandoff({
      runId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01",
      cycle: 1,
      body: pkg,
    });
    expect(JSON.parse(readFileSync(handoff.path, "utf8"))).toEqual(pkg);
    expect(handoff.sha256).toBe(
      createHash("sha256").update(readFileSync(handoff.path)).digest("hex"),
    );
    const candidateSha = commitCandidate(seeded.repo.repo, "synthetic builder claims completion");
    const receipt = {
      taskPackageSha256: handoff.sha256,
      candidateSha,
      claimedIds: [FINDING.busy],
      verified: false,
    };
    const receiptPath = join(home, "candidate-receipt.json");
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const consumed = JSON.parse(readFileSync(receiptPath, "utf8"));
    appendLanding(seeded.runDir, {
      at: new Date().toISOString(),
      clusterId: "user-selection",
      parentSha: seeded.repo.headSha,
      candidateSha: consumed.candidateSha,
      closed: [],
      claimed: consumed.claimedIds,
      pushed: false,
    });
    const claimed = required(
      loadAgainstContext(seeded.runDir, seeded.runId).findings.find(
        (row) => row.id === FINDING.busy,
      ),
    );
    expect(claimed.repairClaim?.candidateSha).toBe(candidateSha);
    expect(isFindingVerifiedClosed(claimed, candidateSha)).toBe(false);

    const reviewed = await runSyntheticReview({
      home,
      repo: seeded.repo.repo,
      agents,
      against: seeded.runId,
      extraArgs: [REPAIR_PACKAGE_REVIEW_FLAG, packagePath],
      output: (_input, aggregator) =>
        reportOutput(
          [],
          aggregator,
          [
            "## Finding Assessment\n```json",
            JSON.stringify(
              sourceBefore.findings.map((row) => ({
                findingId: row.id,
                candidateSha,
                outcome: row.id === FINDING.busy ? "still_open" : "not_evaluated",
                method: row.id === FINDING.busy ? "code_trace" : "not_evaluated",
                reason:
                  row.id === FINDING.busy
                    ? "Builder claim is not a fix; the same accepted-then-busy branch remains"
                    : "Outside selected repair acceptance",
                evidence:
                  row.id === FINDING.busy
                    ? "src/busy.go still returns busy after accepting"
                    : "No repair verification was requested for this unselected item",
                ...(row.id === FINDING.busy
                  ? { locations: [`src/busy.go:${seeded.repo.busyNewLine}`] }
                  : {}),
              })),
            ),
            "```",
          ].join("\n"),
        ),
    });
    expect(reviewed.ledger.againstRunId).toBe(seeded.runId);
    expect(reviewed.ledger.sha).toBe(candidateSha);
    for (const call of reviewed.calls.filter(
      (row) => row.prompt.startsWith("你是") || row.prompt.includes("对比汇总"),
    )) {
      // Frozen public prompt boundary: one JSON package under this section; other PR findings can appear elsewhere.
      const match = /## 修复任务验收\s*```json\s*([\s\S]*?)```/.exec(call.prompt);
      expect(
        match,
        "each reviewer and Aggregator must receive the actual selected task package",
      ).not.toBeNull();
      const task = JSON.parse(required(match?.[1], "repair acceptance JSON"));
      expect(task.source).toEqual(pkg.source);
      expect(task.findings).toEqual(pkg.findings);
      expect(task.findings.map((row: { id: string }) => row.id)).toEqual([FINDING.busy]);
    }
    expect(readFileSync(packagePath, "utf8")).toBe(packageBytes);
    const selected = required(reviewed.ledger.findings.find((row) => row.id === FINDING.busy));
    const undecided = required(reviewed.ledger.findings.find((row) => row.id === FINDING.stale));
    expect(isFindingVerifiedClosed(selected, candidateSha)).toBe(false);
    expect(undecided.status).not.toBe("accepted");
    expect(isFindingVerifiedClosed(undecided, candidateSha)).toBe(false);
    const gate = evaluateRepairGate({
      source: { runId: seeded.runId, prUrl: PR_URL, sha: seeded.repo.headSha },
      candidateSha,
      publishedSha: candidateSha,
      remoteHead: candidateSha,
      baseUnchanged: true,
      prOpen: true,
      squad: {
        taskId: "synthetic-task",
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        sha: candidateSha,
        gatePolicyHash: "fixture-policy",
      },
      review: {
        runId: reviewed.runId,
        incomplete: false,
        seatsAllSuccess: true,
        aggregatorComplete: true,
        artifactsOk: true,
        sha: candidateSha,
        evidenceComplete: true,
        uncoveredIds: [],
        aggregatorVerdict: "comment",
        findings: reviewed.ledger.findings,
      },
      policyHash: "fixture-policy",
      checkedAt: new Date().toISOString(),
      stage: "local_candidate",
    });
    expect(gate.passed).toBe(false);
    expect(gate.reasons.find((row) => row.code === "findings_open")?.evidence).toContain(
      FINDING.stale,
    );
  });
});
