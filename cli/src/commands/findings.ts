import { readCliRun } from "@shared/runtime/cli-runs-index";
import { normalizeReviewPr } from "@shared/runtime/review-case";
import type { FindingDecision } from "@shared/runtime/review-explainer/contracts";
import { loadPrDecisions, upsertPrDecision } from "@shared/runtime/review-explainer/pr-decisions";
import { readFindings, writeFindings } from "../auto/ledger";
/**
 * `councilkit findings accept --run <id> --id <findingId> --reason "..."`
 * Record an explicit "won't fix" decision on the ledger. Absence from a later
 * report is not an accept.
 */
import { errors } from "../errors";
import type { OutputSink } from "../output";
import { resolvePaths } from "../store/paths";
import { parseFlags } from "./parse";

const RUN_ID_PATTERN = /^ck-review-[0-9a-fA-F-]+$/;

export interface FindingsAcceptOutcome {
  runId: string;
  findingId: string;
  status: "accepted";
  reason: string;
}

export async function runFindings(argv: string[], out: OutputSink): Promise<void> {
  const sub = argv[0];
  if (sub === "decide") return runFindingDecision(argv.slice(1), out);
  if (sub !== "accept") {
    throw errors.usage(
      sub === undefined
        ? "findings requires a subcommand: accept|decide"
        : `unknown findings subcommand "${sub}" (accept|decide)`,
    );
  }
  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        run: { type: "string" },
        id: { type: "string" },
        reason: { type: "string" },
      },
      allowPositionals: 0,
    },
    argv.slice(1),
  );
  const runId = (values.run as string | undefined)?.trim() ?? "";
  const findingId = (values.id as string | undefined)?.trim() ?? "";
  const reason = (values.reason as string | undefined)?.trim() ?? "";
  if (!RUN_ID_PATTERN.test(runId)) {
    throw errors.usage("--run <ck-review-…> is required");
  }
  if (findingId.length === 0) {
    throw errors.usage("--id <finding-id> is required");
  }
  if (reason.length === 0) {
    throw errors.usage("--reason <text> is required");
  }
  const runDir = resolvePaths().runDir(runId);
  const file = readFindings(runDir);
  if (!file) {
    throw errors.usage(`run ${runId} has no findings.json`);
  }
  const row = file.findings.find((item) => item.id === findingId);
  if (!row) {
    throw errors.usage(`finding ${findingId} is not in ${runId}`);
  }
  const prUrl = readCliRun(runId)?.reviewEvidence?.prUrl;
  if (prUrl && normalizeReviewPr(prUrl)) {
    const decisions = loadPrDecisions(prUrl);
    upsertPrDecision({
      prUrl,
      finding: row,
      decision: "wont_fix",
      expectedRevision: decisions.revision,
      sourceRunId: runId,
      reason,
    });
  }
  const next = {
    ...file,
    findings: file.findings.map((item) =>
      item.id === findingId
        ? {
            ...item,
            status: "accepted" as const,
            acceptedReason: reason,
            acceptedAt: new Date().toISOString(),
          }
        : item,
    ),
  };
  writeFindings(runDir, next);
  const outcome: FindingsAcceptOutcome = {
    runId,
    findingId,
    status: "accepted",
    reason,
  };
  await out.finish(outcome, () => `accepted ${findingId} on ${runId}\n  ${reason}`);
}

/** Same PR-level decision authority as the browser; no duplicated per-Run choice file. */
async function runFindingDecision(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        run: { type: "string" },
        id: { type: "string" },
        decision: { type: "string" },
        revision: { type: "string" },
      },
      allowPositionals: 0,
    },
    argv,
  );
  const runId = typeof values.run === "string" ? values.run.trim() : "";
  const findingId = typeof values.id === "string" ? values.id.trim() : "";
  const decision = values.decision;
  if (!RUN_ID_PATTERN.test(runId) || !findingId) throw errors.usage("--run and --id are required");
  if (!["undecided", "will_fix", "wont_fix"].includes(String(decision))) {
    throw errors.usage("--decision must be undecided, will_fix or wont_fix");
  }
  const ledger = readFindings(resolvePaths().runDir(runId));
  const finding = ledger?.findings.find((row) => row.id === findingId);
  if (!finding) throw errors.usage("finding is not in this review run");
  const prUrl = readCliRun(runId)?.reviewEvidence?.prUrl;
  if (!prUrl || !normalizeReviewPr(prUrl))
    throw errors.usage("decide requires a supported PR review");
  try {
    const stored = loadPrDecisions(prUrl);
    const revision = values.revision === undefined ? stored.revision : Number(values.revision);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw errors.usage("--revision must be a nonnegative integer");
    const updated = upsertPrDecision({
      prUrl,
      finding,
      decision: decision as FindingDecision,
      expectedRevision: revision,
      sourceRunId: runId,
    });
    await out.finish(
      { runId, findingId, decision, revision: updated.revision },
      () => `${findingId}: ${decision} (revision ${updated.revision})`,
    );
  } catch (error) {
    throw errors.usage(error instanceof Error ? error.message : "cannot save finding decision");
  }
}
