import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFindingBlocking } from "@shared/runtime/cli-ledger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExplainerHttpHost } from "../../tests/host/review-explainer/http-helpers";
import {
  BUSY_REPORT_LINE,
  NEW_REPORT_LINE,
  commitCandidate,
  fakeCliPath,
  readLedger,
  runSyntheticReview,
  seedAgents,
} from "../../tests/review-explainer/cli-harness";
import {
  ANTCODE_PR_URL,
  ASSERTION,
  FINDING,
  MODULES,
  OTHER_ANTCODE_PR_URL,
  OTHER_PR_URL,
  PR_URL,
  ROUTES,
} from "../../tests/review-explainer/contract";
import { writePrDecisionFile } from "../../tests/review-explainer/fixtures/seed-run";
import { createSyntheticRepo } from "../../tests/review-explainer/fixtures/synthetic-repo";
import { importFeature, requireExport, required } from "../../tests/review-explainer/load-feature";

let home: string;
const previousHome = process.env.COUNCILKIT_HOME;
const previousPath = process.env.PATH;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-explainer-skip-"));
  process.env.COUNCILKIT_HOME = home;
  process.env.PATH = fakeCliPath(home, previousPath);
});
afterEach(() => {
  if (previousHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = previousHome;
  if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
  else process.env.PATH = previousPath;
  rmSync(home, { recursive: true, force: true });
});

function expectSkipInjected(run: Awaited<ReturnType<typeof runSyntheticReview>>) {
  const seats = run.calls.filter(
    (row) => row.prompt.startsWith("你是") && !row.prompt.includes("对比汇总"),
  );
  const aggregates = run.calls.filter((row) => row.prompt.includes("对比汇总"));
  expect(seats).toHaveLength(2);
  expect(aggregates).toHaveLength(1);
  for (const { prompt } of [...seats, ...aggregates]) {
    expect(prompt).toContain(FINDING.busy);
    expect(prompt).toContain(ASSERTION.busy);
    expect(prompt).toMatch(/跳过|不要求模型再次验证|do not re-verify/i);
  }
  // Fake reviewers deliberately report both IDs; omission alone cannot make this test pass.
  const skipped = run.ledger.findings.find((row) => row.id === FINDING.busy);
  expect(skipped?.status).toBe("accepted");
  expect(skipped?.acceptedReason).toBeTruthy();
  expect(isFindingBlocking(required(skipped), run.ledger.sha)).toBe(false);
  const fresh = run.ledger.findings.find((row) => row.id === FINDING.freshSameFile);
  expect(fresh?.status).toBe("open");
  expect(isFindingBlocking(required(fresh), run.ledger.sha)).toBe(true);
}

describe("A05 PR decision consumption by real CLI orchestration", () => {
  it("exposes an explicit skip formatter without changing the original assertion", async () => {
    const mod = await importFeature<Record<string, unknown>>(MODULES.skipPrompt);
    const format = requireExport<(input: Record<string, unknown>) => string>(
      mod,
      "formatSkipListForPrompt",
      MODULES.skipPrompt,
    );
    const prompt = format({
      prUrl: PR_URL,
      items: [{ id: FINDING.busy, decision: "wont_fix", originalAssertion: ASSERTION.busy }],
    });
    expect(prompt).toContain(FINDING.busy);
    expect(prompt).toContain(ASSERTION.busy);
    expect(prompt).toMatch(/跳过|do not re-verify/i);
  });

  it.each([PR_URL, `${ANTCODE_PR_URL}?tab=commit#discussion`])(
    "fresh then actual --against retain skips despite repeated model output: %s",
    async (prUrl) => {
      const agents = seedAgents();
      const repo = createSyntheticRepo(join(home, "src")).repo;
      const canonical = prUrl.startsWith(ANTCODE_PR_URL) ? ANTCODE_PR_URL : PR_URL;
      writePrDecisionFile(home, canonical, {
        [FINDING.busy]: { decision: "wont_fix", originalAssertion: ASSERTION.busy },
      });
      const fresh = await runSyntheticReview({ home, repo, agents, prUrl });
      const sha = commitCandidate(repo, "next candidate");
      const against = await runSyntheticReview({
        home,
        repo,
        agents,
        prUrl: canonical,
        against: fresh.runId,
      });
      expect(against.ledger.againstRunId).toBe(fresh.runId);
      expect(against.ledger.sha).toBe(sha);
      expectSkipInjected(fresh);
      expectSkipInjected(against);
    },
  );

  it.each([
    [PR_URL, OTHER_PR_URL],
    [ANTCODE_PR_URL, OTHER_ANTCODE_PR_URL],
  ])("isolates decisions from %s when reviewing %s", async (sourcePr, targetPr) => {
    const agents = seedAgents();
    const repo = createSyntheticRepo(join(home, "src")).repo;
    writePrDecisionFile(home, sourcePr, {
      [FINDING.busy]: { decision: "wont_fix", originalAssertion: ASSERTION.busy },
    });
    const run = await runSyntheticReview({
      home,
      repo,
      agents,
      prUrl: targetPr,
      lines: [BUSY_REPORT_LINE],
    });
    expect(run.ledger.findings.find((row) => row.id === FINDING.busy)?.status).toBe("open");
    for (const { prompt } of run.calls.filter(
      (row) => row.prompt.startsWith("你是") && !row.prompt.includes("对比汇总"),
    )) {
      expect(prompt).not.toContain(ASSERTION.busy);
    }
  });

  it("a materially new assertion reusing the same ID remains open", async () => {
    const agents = seedAgents();
    const repo = createSyntheticRepo(join(home, "src")).repo;
    writePrDecisionFile(home, PR_URL, {
      [FINDING.busy]: {
        decision: "wont_fix",
        originalAssertion: ASSERTION.busy,
        assertionVersion: 1,
      },
    });
    const run = await runSyntheticReview({
      home,
      repo,
      agents,
      lines: [`- [major] \`${FINDING.busy}\` — ${ASSERTION.newBusyMechanism} src/busy.go:23`],
    });
    const changed = run.ledger.findings.find((row) =>
      row.text.includes(ASSERTION.newBusyMechanism),
    );
    expect(changed).toBeDefined();
    expect(changed?.status).toBe("open");
    expect(isFindingBlocking(required(changed), run.ledger.sha)).toBe(true);
  });

  it.each(["undecided", "will_fix"])(
    "a PR-level %s overrides accepted already inherited into a child Run",
    async (decision) => {
      const agents = seedAgents();
      const repo = createSyntheticRepo(join(home, "src")).repo;
      writePrDecisionFile(home, PR_URL, {
        [FINDING.busy]: { decision: "wont_fix", originalAssertion: ASSERTION.busy },
      });
      const parent = await runSyntheticReview({ home, repo, agents });
      commitCandidate(repo, "child inherits skip");
      const child = await runSyntheticReview({ home, repo, agents, against: parent.runId });
      expect(
        readLedger(home, child.runId).findings.find((row) => row.id === FINDING.busy)?.status,
      ).toBe("accepted");
      const host = await createExplainerHttpHost({ home });
      try {
        const response = await fetch(`${host.baseUrl}${ROUTES.decisions(parent.runId)}`, {
          method: "POST",
          headers: host.headers(),
          body: JSON.stringify({ findingId: FINDING.busy, decision, expectedRevision: 1 }),
        });
        expect(response.status).toBe(200);
        // Do not edit the child's ledger to fake a revocation. Its inherited state stays historical.
        expect(
          readLedger(home, child.runId).findings.find((row) => row.id === FINDING.busy)?.status,
        ).toBe("accepted");
        commitCandidate(repo, "after explicit decision");
        const next = await runSyntheticReview({
          home,
          repo,
          agents,
          against: child.runId,
          lines: [BUSY_REPORT_LINE, NEW_REPORT_LINE],
        });
        const restored = next.ledger.findings.find((row) => row.id === FINDING.busy);
        expect(restored?.status).toBe("open");
        expect(isFindingBlocking(required(restored), next.ledger.sha)).toBe(true);
        const initialPrompts = next.calls.filter(
          (row) => row.prompt.startsWith("你是") && !row.prompt.includes("对比汇总"),
        );
        for (const { prompt } of initialPrompts) {
          expect(prompt).toContain(FINDING.busy);
          expect(prompt).not.toMatch(new RegExp(`${FINDING.busy}[^\\n]*\\[accepted\\]`));
        }
      } finally {
        await host.close();
      }
    },
  );
});
