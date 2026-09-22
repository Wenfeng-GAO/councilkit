import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ASSERTION, FINDING, PR_URL, RUN_ID, prDecisionsPath } from "../contract";
import { type SyntheticRepo, createSyntheticRepo } from "./synthetic-repo";

const EXTRACTED = "2026-09-23T00:00:00.000Z";

export interface SeededReview {
  home: string;
  runId: string;
  runDir: string;
  repo: SyntheticRepo;
  prUrl: string;
}

function ledgerFinding(input: {
  id: string;
  title: string;
  text: string;
  files: string[];
  severity?: "critical" | "major" | "minor" | "nit";
}): Record<string, unknown> {
  return {
    id: input.id,
    severity: input.severity ?? "major",
    status: "open",
    title: input.title,
    text: input.text,
    source: "consensus",
    reviewer: "review-correctness",
    files: input.files,
  };
}

export function writeFrozenIdentity(
  runDir: string,
  repo: SyntheticRepo,
  prUrl: string,
  legacy = false,
): void {
  writeFileSync(join(runDir, "review-context.diff"), repo.diff, { encoding: "utf8", mode: 0o600 });
  writeFileSync(
    join(runDir, "review-context.md"),
    [
      "# Frozen review context",
      "",
      `- head: \`${repo.headSha}\``,
      "- source: `HEAD`",
      "- target: `HEAD~1`",
      `- base: \`${repo.baseSha}\``,
      `- merge-base: \`${repo.mergeBaseSha}\``,
      `- colorless diff sha256: \`${repo.diffHash}\``,
      "- verified CLI: `gh pr diff --color=never <url>`",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  if (legacy) return;
  mkdirSync(join(runDir, "review-explainer"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(runDir, "review-explainer", "identity.json"),
    `${JSON.stringify({
      version: 1,
      prUrl,
      headSha: repo.headSha,
      baseSha: repo.baseSha,
      mergeBaseSha: repo.mergeBaseSha,
      diffHash: repo.diffHash,
      repoPath: repo.repo,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function seedReviewRun(
  home: string,
  opts: { runId?: string; prUrl?: string; legacy?: boolean; repo?: SyntheticRepo } = {},
): SeededReview {
  const runId = opts.runId ?? RUN_ID;
  const prUrl = opts.prUrl ?? PR_URL;
  const runDir = join(home, "runs", runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const repo = opts.repo ?? createSyntheticRepo(join(home, "src"));
  writeFrozenIdentity(runDir, repo, prUrl, opts.legacy);
  writeFileSync(
    join(runDir, "invocation-manifest.v1.json"),
    JSON.stringify({
      version: 1,
      kind: "councilkit-invocation-manifest",
      runId,
      task: { pr: prUrl },
      repoRealpath: repo.repo,
      reviewedSha: repo.headSha,
      timeoutMs: 60000,
      concurrency: 1,
      agents: [
        {
          id: "a",
          name: "review-correctness",
          driverId: "kimi-stream-json",
          modelId: "kimi-code/k3",
          options: {},
        },
      ],
      aggregator: { id: "a", driverId: "kimi-stream-json", modelId: "kimi-code/k3" },
      tools: [],
    }),
  );

  const findings = [
    ledgerFinding({
      id: FINDING.busy,
      title: "prompt accepted then busy",
      text: `${ASSERTION.busy} Counterexample: ${ASSERTION.busyCounterexample} Expected: ${ASSERTION.busyExpected} Primary new-side src/busy.go:${repo.busyNewLine}; related unchanged context src/busy.go:${repo.busyContextLine}.`,
      files: ["src/busy.go"],
    }),
    ledgerFinding({
      id: FINDING.stale,
      title: "stale generation commits late",
      text: `${ASSERTION.stale} src/recovery.go:${repo.staleNewLine}`,
      files: ["src/recovery.go"],
    }),
    ledgerFinding({
      id: FINDING.dup,
      title: "duplicate error string",
      text: `Optional extract of a repeated error string. Does not change behavior. src/recovery.go:${repo.dupNewLine}`,
      files: ["src/recovery.go"],
      severity: "nit",
    }),
    ledgerFinding({
      id: FINDING.deleted,
      title: "deleted leftover cleanup",
      text: `Deleted-file finding must stay on the old side: src/deleted.go:${repo.deletedOldLine}.`,
      files: ["src/deleted.go"],
    }),
    ledgerFinding({
      id: FINDING.unanchored,
      title: "missing location",
      text: "Refers to src/missing.go:999 which is not in the frozen diff.",
      files: ["src/missing.go"],
    }),
  ];

  writeFileSync(
    join(runDir, "findings.json"),
    `${JSON.stringify({
      version: 1,
      runId,
      extractedAt: EXTRACTED,
      sha: repo.headSha,
      againstRunId: null,
      againstRange: null,
      findings,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const report = [
    "# Autonomous Review Report",
    "",
    "## 概览",
    "Synthetic explainer fixture. Not PR 128.",
    "",
    "## 共识发现",
    `- [major] src/busy.go:${repo.busyNewLine} — prompt accepted then busy`,
    `- [major] src/recovery.go:${repo.staleNewLine} — stale generation commits late`,
    `- [nit] src/recovery.go:${repo.dupNewLine} — duplicate error string`,
    `- [major] src/deleted.go:${repo.deletedOldLine} — deleted leftover cleanup`,
    "- [minor] src/missing.go:999 — missing location",
    "",
    "## 独有发现",
    "",
    "## 分歧",
    "",
    "## 结论",
    "comment",
    "",
  ].join("\n");
  writeFileSync(join(runDir, "report.md"), report, { encoding: "utf8", mode: 0o600 });

  const started = {
    kind: "review.started",
    version: 1,
    runId,
    startedAt: EXTRACTED,
    task: { pr: prUrl },
    attempts: [
      {
        attemptId: "attempt-0",
        agentId: "a",
        agentName: "review-correctness",
        driverId: "kimi-stream-json",
        modelId: "kimi-code/k3",
      },
    ],
    aggregator: {
      attemptId: "aggregator",
      agentId: "a",
      agentName: "review-correctness",
      driverId: "kimi-stream-json",
      modelId: "kimi-code/k3",
    },
  };
  const finished = {
    kind: "review.finished",
    version: 1,
    status: "completed",
    endedAt: EXTRACTED,
    incomplete: false,
  };
  writeFileSync(
    join(runDir, "transcript.jsonl"),
    `${JSON.stringify(started)}\n${JSON.stringify(finished)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    join(runDir, "status.json"),
    `${JSON.stringify({
      version: 1,
      status: "completed",
      progress: {
        phase: "done",
        attempts: [
          {
            attemptId: "attempt-0",
            agentName: "review-correctness",
            driverId: "kimi-stream-json",
            modelId: "kimi-code/k3",
            role: "attempt",
            status: "success",
            durationMs: 10,
            lastActivity: null,
          },
          {
            attemptId: "aggregator",
            agentName: "review-correctness",
            driverId: "kimi-stream-json",
            modelId: "kimi-code/k3",
            role: "aggregator",
            status: "success",
            durationMs: 10,
            lastActivity: null,
          },
        ],
        updatedAt: EXTRACTED,
      },
      pipeline: null,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { home, runId, runDir, repo, prUrl };
}

export function writePrDecisionFile(
  home: string,
  prUrl: string,
  items: Record<
    string,
    { decision: string; originalAssertion: string; aliases?: string[]; assertionVersion?: number }
  >,
  revision = 1,
): string {
  const path = prDecisionsPath(home, prUrl);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    kind: "councilkit-pr-decisions",
    prUrl,
    revision,
    items: Object.fromEntries(
      Object.entries(items).map(([id, row]) => [
        id,
        {
          findingId: id,
          decision: row.decision,
          identity: { kind: "stable-id", value: id },
          aliases: (row.aliases ?? []).map((alias) => ({ id: alias, basis: "explicit" })),
          originalAssertion: row.originalAssertion,
          assertionVersion: row.assertionVersion ?? 1,
          assertionHash: createHash("sha256").update(row.originalAssertion).digest("hex"),
          decidedAt: EXTRACTED,
          sourceRunId: RUN_ID,
          audit: { event: "user_clicked", reason: "user explicitly clicked the decision" },
        },
      ]),
    ),
  };
  writeFileSync(path, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}
