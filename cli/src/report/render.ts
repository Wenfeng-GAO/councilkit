import { errors } from "../errors";
import type { CompletedTurn, CouncilSnapshot, RunFailure } from "../run/types";
/**
 * Report rendering (plan-a §7). Two paths:
 *  - success: a deterministic header (Run/Council/Reporter/Participants/Status)
 *    followed by the Reporter's nine-section Markdown output. The header is
 *    deterministic so the live smoke can confirm both agents were included even
 *    if the model omits a name; the nine business sections stay model-authored.
 *  - partial: a zero-model-call template rendered from the transcript when a
 *    Run stopped before the Reporter completed, prominently flagged INCOMPLETE.
 *
 * The canonical `runs/<run-id>/report.md` is ALWAYS written; `--out` adds an
 * atomic copy to a user path (its failure makes the command non-zero but the
 * canonical artifact is preserved — plan-a §11 跨文件落盘).
 *
 * No browser-only vocabulary (Room/Facilitator/Convergence/Decision Report) —
 * only Driver Selection/Council/Reporter/Run (CONTEXT.md).
 */
import { atomicWriteFile } from "../store/atomic-write";

const INCOMPLETE_BANNER =
  "> INCOMPLETE RUN — discussion stopped before the Reporter completed. " +
  "What follows is a deterministic partial report built from the persisted transcript; " +
  "no consensus is fabricated and the Reporter did not produce a final summary.";

export interface SuccessReportInput {
  runId: string;
  startedAt: string;
  endedAt: string;
  council: CouncilSnapshot;
  reporterName: string;
  /** Ordered participant names (for the deterministic header). */
  participantNames: ReadonlyArray<string>;
  /** The Reporter's completed Markdown output. */
  reporterOutput: string;
}

export interface PartialReportInput {
  runId: string;
  startedAt: string;
  endedAt: string;
  council: CouncilSnapshot;
  reporterName: string;
  participantNames: ReadonlyArray<string>;
  /** Persisted ordinary turns, in completion order. */
  completedTurns: ReadonlyArray<CompletedTurn>;
  failure: RunFailure;
}

function header(opts: {
  runId: string;
  startedAt: string;
  endedAt: string;
  council: CouncilSnapshot;
  reporterName: string;
  participantNames: ReadonlyArray<string>;
  status: "complete" | "incomplete";
}): string {
  const participants = opts.participantNames.join(", ");
  return [
    "# Council Report",
    "",
    `- Run: ${opts.runId}`,
    `- Council: ${opts.council.name} (${opts.council.id})`,
    `- Topic: ${opts.council.topic}`,
    `- Reporter: ${opts.reporterName}`,
    `- Participants: ${participants}`,
    `- Status: ${opts.status}`,
    `- Started: ${opts.startedAt}`,
    `- Ended: ${opts.endedAt}`,
    "",
  ].join("\n");
}

/** Render the success report. The Reporter output is appended verbatim after a
 * section separator. */
export function renderSuccessReport(input: SuccessReportInput): string {
  const head = header({
    runId: input.runId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    council: input.council,
    reporterName: input.reporterName,
    participantNames: input.participantNames,
    status: "complete",
  });
  const body = input.reporterOutput.trim();
  return body.length > 0
    ? `${head}---\n\n${body}\n`
    : `${head}---\n\n_(Reporter produced no body.)_\n`;
}

/** Render the deterministic partial report (zero model calls). Lists council
 * metadata, every persisted ordinary speech, the failure phase, and next
 * diagnostics — never a fabricated consensus or Reporter conclusion. */
export function renderPartialReport(input: PartialReportInput): string {
  const head = header({
    runId: input.runId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    council: input.council,
    reporterName: input.reporterName,
    participantNames: input.participantNames,
    status: "incomplete",
  });
  const lines: string[] = [head, INCOMPLETE_BANNER, ""];
  if (input.completedTurns.length === 0) {
    lines.push(
      "## Completed speeches",
      "",
      "_No ordinary turn completed before the run stopped._",
      "",
    );
  } else {
    lines.push("## Completed speeches", "");
    for (const turn of input.completedTurns) {
      lines.push(
        `### Round ${turn.round} — ${turn.agentName} (participant ${turn.participantId})`,
        "",
        turn.output,
        "",
      );
    }
  }
  lines.push(
    "## Failure",
    "",
    `- Phase: ${input.failure.phase}`,
    `- Code: ${input.failure.code}`,
    `- Message: ${input.failure.message}`,
    "",
    "## Next diagnostics",
    "",
    "- Inspect `transcript.jsonl` for the persisted turns and the `run.finished` record.",
    "- Re-run with a fresh Run id after resolving the failure (V1.1 has no `--resume`).",
    "",
  );
  return lines.join("\n");
}

/** Assert a rendered report is non-empty Markdown (plan-a §7). */
export function assertNonEmptyMarkdown(markdown: string): void {
  if (markdown.trim().length === 0) {
    throw errors.io("rendered report is empty");
  }
}

/** Atomically write the canonical report.md to the run dir. */
export function writeCanonicalReport(path: string, markdown: string): void {
  try {
    atomicWriteFile(path, markdown);
  } catch (cause) {
    throw errors.io(`failed to write canonical report: ${ioName(cause)}`, { cause: ioName(cause) });
  }
}

/** Atomically copy the report to a user `--out` path. Failure is surfaced as an
 * IO error (exit 5) but the canonical artifact is already preserved. */
export function writeReportCopy(outPath: string, markdown: string): void {
  try {
    atomicWriteFile(outPath, markdown);
  } catch (cause) {
    throw errors.io(`failed to write --out report copy: ${ioName(cause)}`, {
      cause: ioName(cause),
    });
  }
}

function ioName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return "IOFailure";
}
