/**
 * Report case-filter fixtures for the E2E Host home (report-case-filters.spec.ts).
 *
 * Pure filesystem seeding, exported so both the Playwright host-entry and a
 * reader-level sanity check can reproduce the exact same corpus:
 *   PR 901 review: old failed + new completed (complete evidence)
 *   PR 912 squad : old completed + new running
 *   PR 913 squad : awaiting orchestration
 *   PR 914 squad : interrupted
 *   repair-only   : completed, business verdict open
 *   repair-only   : completed BUT businessResult=needs_attention (dual axis)
 *   PR 916 mixed  : completed review + failed squad
 *   PR 999 review : failed junk, listed in archived-runs.json (never listed)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ARCHIVED_JUNK_RUN_ID = "ck-review-10000000-0000-4000-8000-00000000aa01";

export const REPORT_CASE_FIXTURE_IDS = [
  "ck-review-10000000-0000-4000-8000-00000000a001",
  "ck-review-10000000-0000-4000-8000-00000000a002",
  "ck-squad-10000000-0000-4000-8000-00000000b001",
  "ck-squad-10000000-0000-4000-8000-00000000b002",
  "ck-squad-10000000-0000-4000-8000-00000000c001",
  "ck-squad-10000000-0000-4000-8000-00000000d001",
  "ck-repair-10000000-0000-4000-8000-00000000e001",
  "ck-repair-20000000-0000-4000-8000-00000000e002",
  "ck-review-10000000-0000-4000-8000-00000000f001",
  "ck-squad-10000000-0000-4000-8000-00000000f002",
  ARCHIVED_JUNK_RUN_ID,
] as const;

export function seedReportCaseFixtures(home: string, nowIso: string): void {
  const cleanSha = `f139${"0".repeat(36)}`; // 40 hex chars matched by findings + evidence
  const live = (status: string, phase: string) =>
    `${JSON.stringify({
      version: 1,
      status,
      progress: { phase, attempts: [], updatedAt: nowIso },
      pipeline: null,
    })}\n`;
  const reviewRun = (runId: string, startedAt: string, pr: string, end: unknown | null) => {
    const dir = join(home, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const records = [
      JSON.stringify({ kind: "review.started", version: 1, runId, startedAt, task: { pr } }),
      ...(end === null ? [] : [JSON.stringify(end)]),
    ];
    writeFileSync(join(dir, "transcript.jsonl"), `${records.join("\n")}\n`);
  };
  const reviewFinished = (status: string, endedAt: string) => ({
    kind: "review.finished",
    version: 1,
    status,
    endedAt,
    incomplete: false,
    failure: null,
  });
  const squadRun = (runId: string, startedAt: string, title: string, end: unknown | null) => {
    const dir = join(home, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const records = [
      JSON.stringify({
        kind: "squad.started",
        version: 1,
        runId,
        startedAt,
        task: { taskId: title },
      }),
      ...(end === null ? [] : [JSON.stringify(end)]),
    ];
    writeFileSync(join(dir, "transcript.jsonl"), `${records.join("\n")}\n`);
  };
  const findings = (runId: string) =>
    `${JSON.stringify({
      version: 1,
      runId,
      extractedAt: nowIso,
      sha: cleanSha,
      againstRunId: null,
      againstRange: null,
      findings: [],
    })}\n`;
  const standing = (runId: string, status: string, phase: string) => {
    const dir = join(home, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), live(status, phase));
  };

  const PR_901_URL = "https://github.com/e2e-case/pr901/pull/901";
  const PR_916_URL = "https://github.com/e2e-case/pr916/pull/916";
  // PR 901: old failed + new completed —— old failure must not pollute the case.
  reviewRun(
    "ck-review-10000000-0000-4000-8000-00000000a001",
    "2026-09-20T01:00:00.000Z",
    PR_901_URL,
    reviewFinished("failed", "2026-09-20T01:05:00.000Z"),
  );
  const a2 = "ck-review-10000000-0000-4000-8000-00000000a002";
  reviewRun(
    a2,
    "2026-09-21T02:00:00.000Z",
    PR_901_URL,
    reviewFinished("completed", "2026-09-21T02:05:00.000Z"),
  );
  writeFileSync(join(home, "runs", a2, "findings.json"), findings(a2));
  // PR 912: old completed squad + new running squad.
  squadRun(
    "ck-squad-10000000-0000-4000-8000-00000000b001",
    "2026-09-20T01:00:00.000Z",
    "20260920-pr912-fix",
    {
      kind: "squad.finished",
      version: 1,
      status: "completed",
      endedAt: "2026-09-20T03:00:00.000Z",
    },
  );
  squadRun(
    "ck-squad-10000000-0000-4000-8000-00000000b002",
    "2026-09-21T02:00:00.000Z",
    "20260921-pr912-fix",
    null,
  );
  standing("ck-squad-10000000-0000-4000-8000-00000000b002", "running", "attempts");
  // PR 913: squad awaiting orchestration.
  squadRun(
    "ck-squad-10000000-0000-4000-8000-00000000c001",
    "2026-09-21T02:00:00.000Z",
    "20260921-pr913-wait",
    null,
  );
  standing("ck-squad-10000000-0000-4000-8000-00000000c001", "awaiting_orchestrator", "proposing");
  // PR 914: squad interrupted —— never dressed up as done.
  squadRun(
    "ck-squad-10000000-0000-4000-8000-00000000d001",
    "2026-09-21T02:00:00.000Z",
    "20260921-pr914-break",
    null,
  );
  standing("ck-squad-10000000-0000-4000-8000-00000000d001", "interrupted", "debating");
  // Repair-only case: belongs to 工程班, completed, done.
  standing("ck-repair-10000000-0000-4000-8000-00000000e001", "completed", "repair-finalizing");
  // Repair dual-axis counter-example: run status completed but the business
  // verdict is needs_attention — execution finished, the case did not.
  const na = "ck-repair-20000000-0000-4000-8000-00000000e002";
  standing(na, "completed", "repair-finalizing");
  writeFileSync(
    join(home, "runs", na, "repair.json"),
    `${JSON.stringify({
      version: 1,
      businessResult: "needs_attention",
      reasonCode: "tests_still_failing",
      sourceRunId: null,
      lastError: "verify suites are still red",
      outerUsed: 3,
      outerMax: 10,
      grantId: "ck-grant-fixture",
    })}\n`,
  );
  // PR 916: mixed —— completed review + failed squad.
  const f1 = "ck-review-10000000-0000-4000-8000-00000000f001";
  reviewRun(
    f1,
    "2026-09-20T01:00:00.000Z",
    PR_916_URL,
    reviewFinished("completed", "2026-09-20T01:05:00.000Z"),
  );
  writeFileSync(join(home, "runs", f1, "findings.json"), findings(f1));
  squadRun(
    "ck-squad-10000000-0000-4000-8000-00000000f002",
    "2026-09-21T02:00:00.000Z",
    "20260921-pr916-fix",
    { kind: "squad.finished", version: 1, status: "failed", endedAt: "2026-09-21T02:30:00.000Z" },
  );
  // Archived junk case: PR 999 is old garbage, listed in archived-runs.json.
  reviewRun(
    ARCHIVED_JUNK_RUN_ID,
    "2026-09-19T01:00:00.000Z",
    "https://github.com/e2e-case/pr999/pull/999",
    reviewFinished("failed", "2026-09-19T01:05:00.000Z"),
  );
  writeFileSync(
    join(home, "runs", ARCHIVED_JUNK_RUN_ID, "report.md"),
    "# Archived Junk Review\n\ndirect detail read must still work\n",
  );
  writeFileSync(
    join(home, "archived-runs.json"),
    `${JSON.stringify({ version: 1, runIds: [ARCHIVED_JUNK_RUN_ID] })}\n`,
  );
}

export const LOST_EXECUTION_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000348";
export const COMPLETED_REVIEW_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000351";
export const LOST_EXECUTION_PR = "https://github.com/acme/payments/pull/348";
export const COMPLETED_REVIEW_PR = "https://github.com/acme/payments/pull/351";

/** Stale review (lost local execution) plus a finished review, for the interruption e2e. */
export function seedLostExecutionFixtures(home: string): void {
  const sha = "c4e8b1a09f6d3e2c1b0a9876543210fedcba9876";
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const interruptedDir = join(home, "runs", LOST_EXECUTION_RUN_ID);
  mkdirSync(interruptedDir, { recursive: true });
  const seat = {
    attemptId: "attempt-security",
    agentId: "sec",
    agentName: "review-security",
    driverId: "grok-stream-json",
    modelId: "grok-4.6",
  };
  const aggregator = {
    attemptId: "aggregator",
    agentId: "adv",
    agentName: "review-adversarial",
    driverId: "grok-stream-json",
    modelId: "grok-4.6",
  };
  writeFileSync(
    join(interruptedDir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "review.started",
      version: 1,
      runId: LOST_EXECUTION_RUN_ID,
      startedAt: "2026-10-16T07:40:00.000Z",
      task: { pr: LOST_EXECUTION_PR },
      attempts: [seat],
      aggregator,
    })}\n${JSON.stringify({
      kind: "attempt.finished",
      version: 1,
      attemptId: "attempt-security",
      agentName: "review-security",
      driverId: "grok-stream-json",
      status: "success",
      output: "支付回调超时后仍把订单标成已支付。",
      exitCode: 0,
      durationMs: 42000,
    })}\n`,
  );
  writeFileSync(
    join(interruptedDir, "status.json"),
    `${JSON.stringify({
      version: 1,
      status: "running",
      progress: {
        phase: "aggregating",
        updatedAt: staleAt,
        attempts: [
          {
            ...seat,
            role: "attempt",
            status: "success",
            durationMs: 42000,
            lastActivity: null,
          },
          {
            ...aggregator,
            role: "aggregator",
            status: "running",
            durationMs: 8000,
            lastActivity: "汇总支付回调路径",
          },
        ],
      },
      pipeline: null,
    })}\n`,
  );
  writeFileSync(
    join(interruptedDir, "findings.json"),
    `${JSON.stringify({
      version: 1,
      runId: LOST_EXECUTION_RUN_ID,
      extractedAt: staleAt,
      sha,
      againstRunId: null,
      againstRange: null,
      findings: [
        {
          id: "pay-timeout",
          severity: "major",
          status: "open",
          title: "支付回调超时后仍把订单标成已支付",
          text: "超时分支在收到渠道失败之前写入了 paid，用户会被多扣一次。",
          source: "consensus",
          reviewer: "review-security",
          files: ["src/pay.ts"],
        },
        {
          id: "pay-log",
          severity: "nit",
          status: "open",
          title: "回调日志带了完整卡号",
          text: "失败日志把 PAN 打进了 info。",
          source: "unique",
          reviewer: "review-security",
          files: ["src/pay-log.ts"],
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(interruptedDir, "report.md"),
    [
      "# Autonomous Review Report",
      "",
      "---",
      "",
      "## 概览",
      "",
      "安全席已经看完支付回调。汇总还没写完，本地执行服务就断开了。",
      "主要问题是超时后仍把订单标成已支付。",
      "",
    ].join("\n"),
  );

  const completedDir = join(home, "runs", COMPLETED_REVIEW_RUN_ID);
  mkdirSync(completedDir, { recursive: true });
  writeFileSync(
    join(completedDir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "review.started",
      version: 1,
      runId: COMPLETED_REVIEW_RUN_ID,
      startedAt: "2026-10-15T09:00:00.000Z",
      task: { pr: COMPLETED_REVIEW_PR },
      attempts: [seat],
      aggregator,
    })}\n${JSON.stringify({
      kind: "attempt.finished",
      version: 1,
      attemptId: "attempt-security",
      agentName: "review-security",
      driverId: "grok-stream-json",
      status: "success",
      output: "支付幂等键已经补上。",
      exitCode: 0,
      durationMs: 60000,
    })}\n${JSON.stringify({
      kind: "review.finished",
      version: 1,
      status: "completed",
      endedAt: "2026-10-15T09:18:00.000Z",
      incomplete: false,
      failure: null,
    })}\n`,
  );
  writeFileSync(
    join(completedDir, "status.json"),
    `${JSON.stringify({
      version: 1,
      status: "completed",
      progress: {
        phase: "done",
        updatedAt: "2026-10-15T09:18:00.000Z",
        attempts: [
          { ...seat, role: "attempt", status: "success", durationMs: 60000, lastActivity: null },
          {
            ...aggregator,
            role: "aggregator",
            status: "success",
            durationMs: 20000,
            lastActivity: null,
          },
        ],
      },
      pipeline: null,
    })}\n`,
  );
  writeFileSync(
    join(completedDir, "findings.json"),
    `${JSON.stringify({
      version: 1,
      runId: COMPLETED_REVIEW_RUN_ID,
      extractedAt: "2026-10-15T09:18:00.000Z",
      sha,
      againstRunId: null,
      againstRange: null,
      findings: [
        {
          id: "idem-note",
          severity: "nit",
          status: "open",
          title: "幂等键注释还写着旧渠道名",
          text: "注释仍提到已下线的渠道，不影响正确性。",
          source: "unique",
          reviewer: "review-maintainability",
          files: ["src/idempotency.ts"],
        },
      ],
    })}\n`,
  );
  writeFileSync(
    join(completedDir, "report.md"),
    [
      "# Autonomous Review Report",
      "",
      "---",
      "",
      "## 概览",
      "",
      "支付幂等键已经补上。本轮没有新的阻塞项，只剩一处过期注释。",
      "",
      "## 结论",
      "",
      "approve",
      "",
    ].join("\n"),
  );
}
