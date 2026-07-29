import { assertNonEmptyMarkdown, writeCanonicalReport, writeReportCopy } from "../report/render";
/**
 * review report rendering (DESIGN §4, plan §"文件清单"/§"ReviewOutcome"). The
 * canonical `runs/<run-id>/report.md` is a deterministic header → aggregation
 * body → `## Appendix: per-attempt outputs`. Failed Attempts appear in the
 * appendix as `failed: <reason>` and are never cited in the aggregation body.
 *
 * Reuses `report/render.ts` write/assert helpers (unchanged) for the canonical
 * write + `--out` copy, so durability semantics match the `run` command.
 */
import type { AttemptResult } from "./runner";
import type { ReviewTask } from "./templates/review";

/** Render the no-synthesis banner by the REAL reason synthesis is absent, so
 * the body never contradicts the header. The header already labels the run
 * (interrupted / failed / complete); the banner must agree: an interrupted run
 * was never finished, an all-attempts-failed run never started an Aggregator,
 * and only an aggregation-failed run actually had the Aggregator fail (reviewer
 * finding: the banner always said "Aggregator failed" even when SIGINT fired
 * during Attempts or every Attempt failed and no Aggregator ever ran). */
function incompleteBanner(input: ReviewReportInput): string {
  if (input.status === "interrupted") {
    return (
      "> INCOMPLETE — the run was interrupted before a synthesis could be " +
      "produced. What follows is the deterministic header plus each Attempt's " +
      "raw deliverable in the appendix; no consensus is fabricated."
    );
  }
  // status === "failed": first distinguish "stopped before the Aggregator
  // could start" (run-level cause, e.g. transcript IO) — this must come BEFORE
  // the every-Attempt-failed check, because a mid-run failure can leave some
  // Attempts never started and none succeeded, without the cause being
  // "every Attempt failed" (reviewer finding: banner misreported coverage).
  if (
    input.aggregation === null &&
    input.failurePhase !== "aggregation" &&
    input.failurePhase !== "attempts"
  ) {
    return (
      "> INCOMPLETE — the run stopped before the Aggregator could start " +
      `(${input.reason?.trim() || "see transcript"}). What follows is the ` +
      "deterministic header plus each Attempt's raw deliverable in the appendix; " +
      "no consensus is fabricated."
    );
  }
  // Distinguish every-Attempt-failed (no Aggregator ran) from an Aggregator
  // that ran but produced no usable output.
  const anySuccess = input.attempts.some((a) => a.status === "success");
  if (!anySuccess) {
    return (
      "> INCOMPLETE — every Attempt failed, so no Aggregator was run. What " +
      "follows is the deterministic header plus each Attempt's failure in the " +
      "appendix; no consensus is fabricated."
    );
  }
  return (
    "> INCOMPLETE — the Aggregator failed to produce a synthesis. What follows " +
    "is the deterministic header plus each Attempt's raw deliverable in the " +
    "appendix; no consensus is fabricated."
  );
}

export interface ReviewReportMeta {
  attemptId: string;
  agentId: string;
  agentName: string;
  driverId: string;
  modelId: string;
}

export interface ReviewReportInput {
  runId: string;
  startedAt: string;
  endedAt: string;
  task: ReviewTask;
  /** All Attempt results, in order. */
  attempts: ReadonlyArray<AttemptResult>;
  aggregator: ReviewReportMeta;
  /** The Aggregator spawn's result (null if aggregation was skipped). */
  aggregation: AttemptResult | null;
  /** Run status — drives the report's Status line (completed/partial/failed/interrupted). */
  status: "completed" | "failed" | "interrupted";
  incomplete: boolean;
  /** Why the run is interrupted/failed (printed as a Reason line in the header). */
  reason?: string;
  /** The failure phase (attempts / aggregation / transcript / …) — lets the
   * banner distinguish "Aggregator ran and failed" from "never started". */
  failurePhase?: string;
}

/** Render the full Markdown report. */
export function renderReviewReport(input: ReviewReportInput): string {
  const head = renderHeader(input);
  const body =
    input.aggregation?.status === "success" && input.aggregation.output.trim().length > 0
      ? input.aggregation.output.trim()
      : "";
  const sections: string[] = [head];
  if (body.length > 0) {
    sections.push("---", "", body, "");
  } else {
    sections.push(incompleteBanner(input), "");
  }
  sections.push(renderAppendix(input));
  return sections.join("\n");
}

function renderHeader(input: ReviewReportInput): string {
  const lines: string[] = [];
  lines.push("# Autonomous Review Report", "");
  lines.push(`- Run: ${input.runId}`);
  lines.push(`- Task: ${taskLine(input.task)}`);
  const focus = input.task.focus?.trim();
  if (focus && focus.length > 0) lines.push(`- Focus: ${focus}`);
  lines.push(
    `- Aggregator: ${input.aggregator.agentName} (${input.aggregator.driverId}/${input.aggregator.modelId})`,
  );
  lines.push("- Attempts:");
  for (const a of input.attempts) {
    const mark = a.status === "success" ? "ok" : `failed:${a.failure?.code ?? "unknown"}`;
    lines.push(
      `  - ${a.agentName} (${a.driverId}/${a.modelId}) — ${mark} — exit ${a.exitCode ?? "n/a"} — ${a.durationMs}ms`,
    );
  }
  lines.push(`- Status: ${statusLabel(input)}`);
  if (input.reason && input.reason.trim().length > 0) {
    lines.push(`- Reason: ${input.reason.trim()}`);
  }
  lines.push(`- Started: ${input.startedAt}`);
  lines.push(`- Ended: ${input.endedAt}`);
  lines.push("");
  return lines.join("\n");
}

/** Distinguish completed / partial (incomplete success) / failed / interrupted
 * in the report header — an interrupted run must not read as merely "incomplete". */
function statusLabel(input: ReviewReportInput): string {
  if (input.status === "interrupted") return "interrupted";
  if (input.status === "failed") return "failed";
  return input.incomplete ? "partial" : "complete";
}

function renderAppendix(input: ReviewReportInput): string {
  const lines: string[] = ["## Appendix: per-attempt outputs", ""];
  if (input.attempts.length === 0) {
    lines.push("_(no attempts ran.)_", "");
    return lines.join("\n");
  }
  for (const a of input.attempts) {
    lines.push(`### ${a.agentName} (${a.driverId}/${a.modelId})`, "");
    if (a.status === "success" && a.output.trim().length > 0) {
      lines.push(a.output.trim(), "");
    } else {
      lines.push(
        `failed: ${a.failure?.code ?? "unknown"} — ${a.failure?.message ?? "no output"}`,
        "",
      );
    }
  }
  return lines.join("\n");
}

function taskLine(task: ReviewTask): string {
  if (task.pr && task.pr.trim().length > 0) return `review PR ${task.pr.trim()}`;
  if (task.task && task.task.trim().length > 0) return task.task.trim();
  return "(unspecified)";
}

/** Validate + write the canonical report.md. */
export function writeCanonicalReviewReport(path: string, markdown: string): void {
  assertNonEmptyMarkdown(markdown);
  writeCanonicalReport(path, markdown);
}

/** Atomic copy to `--out`; the canonical artifact is already preserved. */
export function writeReviewReportCopy(outPath: string, markdown: string): void {
  writeReportCopy(outPath, markdown);
}
