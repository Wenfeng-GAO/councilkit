/**
 * Durable execution identity for one Attempt/Aggregator execution (B0,
 * docs/verification/2026-09-20-b0-execution-identity.md).
 *
 * The CLI transcript (runs/<runId>/transcript.jsonl) records only TERMINAL
 * records (`attempt.finished` / `aggregation.finished`) plus flow markers
 * (`review.started` / `review.resumed`); there is no started-record. Identity
 * is therefore DERIVED from durable record order:
 *
 *   executionRef = `<attemptId>#<generation>.<ordinal>`
 *
 * - generation: 1 + the number of `review.resumed` records that appear BEFORE
 *   this execution in the transcript. A resume continues the SAME run id and
 *   appends (never rewrites) history, so generation is stable across the
 *   atomic rewrite/append write pattern. Runs without any resume are always
 *   generation 1 (covers ideate and pre-resume review transcripts).
 * - ordinal: 1-based index of this execution's terminal record among terminal
 *   records of the SAME attemptId within the SAME generation.
 *
 * Mid-run (no terminal record yet for the current execution) the prospective
 * identity is `(totalResumes + 1, finishedInGeneration + 1)` — the ordinal the
 * terminal record WILL have once appended, so the ref is stable from running
 * through terminal as long as the execution leaves a durable record.
 *
 * Known degradation (documented in the B0 note): an execution that dies
 * WITHOUT any terminal record (e.g. SIGKILL/power loss) is indistinguishable
 * from the next execution in the same generation — both map to the same
 * prospective ref. Only a producer-side started-record would close this; this
 * module never fabricates identity beyond the durable-order rule.
 */
import type { CliRunAttemptLiveStatus } from "./cli-run-progress";

export const EXECUTION_REF_UNAVAILABLE_SUFFIX = "0.0";

export type ExecutionRole = "attempt" | "aggregator";

export type InflightExecutionStatus = "pending" | "queued" | "running";
export type TerminalExecutionStatus = "success" | "failure" | "cancelled";

export interface AttemptFailureInfo {
  code: string;
  message: string;
}

export type AttemptExecutionResolution =
  | {
      kind: "inflight";
      role: ExecutionRole;
      executionRef: string;
      executionStatus: InflightExecutionStatus;
    }
  | {
      kind: "terminal";
      role: ExecutionRole;
      executionRef: string;
      executionStatus: TerminalExecutionStatus;
      /** Durable final text; null on failure or when the record carried none. */
      output: string | null;
      failure: AttemptFailureInfo | null;
      /** Set when the current result is an explicit reuse (reusedAttemptIds):
       *  the executionRef of the source execution in the SAME run transcript. */
      reusedExecutionRef: string | null;
    }
  | {
      kind: "unavailable";
      role: ExecutionRole | null;
      executionRef: string;
      reason: "no-started-record" | "no-execution-record";
    }
  | { kind: "unknown-attempt" };

export function formatExecutionRef(attemptId: string, generation: number, ordinal: number): string {
  return `${attemptId}#${generation}.${ordinal}`;
}

/** Sentinel ref for transcripts whose identity cannot be recovered at all. */
export function unavailableExecutionRef(attemptId: string): string {
  return `${attemptId}#${EXECUTION_REF_UNAVAILABLE_SUFFIX}`;
}

const TERMINAL_LIVE: ReadonlySet<string> = new Set(["success", "failure", "cancelled"]);

/** Mirror of the runner's transient-EXIT retry window (runner.ts shouldRetry):
 *  only a non-zero EXIT under 120s is retried, and only once. `retryable` is
 *  NOT persisted on the transcript failure object, so a retryable=false EXIT
 *  failure may be conservatively reported as in-flight until the run reaches
 *  a terminal state (documented B0 degradation). */
const TRANSIENT_RETRY_MAX_DURATION_MS = 120_000;

const AGGREGATION_KEY = "aggregation.finished";

interface FinishedEntry {
  /** Counter key: attemptId for attempt.finished, AGGREGATION_KEY for aggregation.finished. */
  key: string;
  index: number;
  generation: number;
  ordinal: number;
  status: "success" | "failure";
  output: string | null;
  failure: AttemptFailureInfo | null;
  attemptNumber: number | null;
  durationMs: number;
  exitCode: unknown;
}

interface Roster {
  attemptIds: ReadonlySet<string>;
  aggregatorAttemptId: string | null;
}

export function resolveAttemptExecution(input: {
  records: readonly unknown[];
  attemptId: string;
  /** Progress-row status (status.json overlay merged with transcript); null
   *  when the run has no progress row for this attempt. */
  liveStatus: CliRunAttemptLiveStatus | null;
  /** True while the run may still append records (detail.status running /
   *  awaiting_orchestrator). */
  runActive: boolean;
}): AttemptExecutionResolution {
  const { records, attemptId, liveStatus, runActive } = input;

  let roster: Roster | null = null;
  let resumes = 0;
  let lastResume: { index: number; reusedAttemptIds: ReadonlySet<string> } | null = null;
  const finished: FinishedEntry[] = [];
  // Per-attempt ordinal counters scoped to a generation (reset when the
  // generation advances between records of the same attempt).
  const counters = new Map<string, { generation: number; count: number }>();

  for (let index = 0; index < records.length; index++) {
    const rec = records[index];
    if (rec === null || typeof rec !== "object") continue;
    const row = rec as Record<string, unknown>;
    const kind = typeof row.kind === "string" ? row.kind : "";
    if (kind === "review.started" || kind === "ideate.started") {
      roster = parseRoster(row);
    } else if (kind === "review.resumed") {
      resumes += 1;
      const reused = Array.isArray(row.reusedAttemptIds)
        ? row.reusedAttemptIds.filter((id): id is string => typeof id === "string")
        : [];
      lastResume = { index, reusedAttemptIds: new Set(reused) };
    } else if (kind === "attempt.finished" || kind === "aggregation.finished") {
      // `aggregation.finished` always carries attemptId in current CLI output;
      // tolerate a legacy/absent field by keying aggregation records on the
      // kind alone (a run has exactly one Aggregator).
      const recAttemptId = typeof row.attemptId === "string" ? row.attemptId : null;
      const key = kind === "aggregation.finished" ? AGGREGATION_KEY : recAttemptId;
      if (key === null) continue;
      const status = row.status === "success" || row.status === "failure" ? row.status : null;
      if (status === null) continue;
      const generation = resumes + 1;
      const counter = counters.get(key);
      const ordinal =
        counter !== undefined && counter.generation === generation ? counter.count + 1 : 1;
      counters.set(key, { generation, count: ordinal });
      finished.push({
        key,
        index,
        generation,
        ordinal,
        status,
        output: typeof row.output === "string" ? row.output : null,
        failure: parseFailure(row.failure),
        attemptNumber: typeof row.attemptNumber === "number" ? row.attemptNumber : null,
        durationMs: typeof row.durationMs === "number" ? row.durationMs : Number.POSITIVE_INFINITY,
        exitCode: row.exitCode,
      });
    }
  }

  if (roster === null) {
    return {
      kind: "unavailable",
      role: null,
      executionRef: unavailableExecutionRef(attemptId),
      reason: "no-started-record",
    };
  }

  const role: ExecutionRole | null =
    roster.aggregatorAttemptId !== null && attemptId === roster.aggregatorAttemptId
      ? "aggregator"
      : roster.attemptIds.has(attemptId)
        ? "attempt"
        : null;
  if (role === null) return { kind: "unknown-attempt" };

  const key = role === "aggregator" ? AGGREGATION_KEY : attemptId;
  const mine = finished.filter((entry) => entry.key === key);
  const lastFinished = mine.length > 0 ? (mine[mine.length - 1] as FinishedEntry) : null;

  // Explicit reuse: named in the LAST review.resumed's reusedAttemptIds with
  // no later terminal record of its own. The source execution always lives in
  // THIS run's transcript — a resume continues the same run id.
  const reused =
    role === "attempt" &&
    lastResume !== null &&
    lastResume.reusedAttemptIds.has(attemptId) &&
    (lastFinished === null || lastFinished.index < lastResume.index);

  if (reused && lastFinished !== null && lastFinished.status === "success") {
    const ref = formatExecutionRef(attemptId, lastFinished.generation, lastFinished.ordinal);
    return terminalFromEntry(attemptId, role, lastFinished, ref);
  }

  const recordCurrent =
    lastFinished !== null && (lastResume === null || lastFinished.index > lastResume.index);

  if (recordCurrent && lastFinished !== null) {
    if (runActive && isPossibleRetryAwaiting(lastFinished)) {
      // The first try failed transiently and the retry is (presumed) running:
      // the current execution is the retry — never serve the failed try.
      return {
        kind: "inflight",
        role,
        executionRef: formatExecutionRef(
          attemptId,
          lastFinished.generation,
          lastFinished.ordinal + 1,
        ),
        executionStatus: "running",
      };
    }
    return terminalFromEntry(attemptId, role, lastFinished, null);
  }

  // No current terminal record: never ran, rerun pending after a resume, or
  // the execution died without leaving one.
  const prospectiveGeneration = resumes + 1;
  const counter = counters.get(key);
  const prospectiveOrdinal =
    counter !== undefined && counter.generation === prospectiveGeneration ? counter.count + 1 : 1;
  const liveTerminal = liveStatus !== null && TERMINAL_LIVE.has(liveStatus);
  if (runActive && !liveTerminal) {
    const status: InflightExecutionStatus =
      liveStatus === "queued" || liveStatus === "running" || liveStatus === "pending"
        ? liveStatus
        : "pending";
    return {
      kind: "inflight",
      role,
      executionRef: formatExecutionRef(attemptId, prospectiveGeneration, prospectiveOrdinal),
      executionStatus: status,
    };
  }
  return {
    kind: "unavailable",
    role,
    executionRef: formatExecutionRef(attemptId, prospectiveGeneration, prospectiveOrdinal),
    reason: "no-execution-record",
  };
}

function terminalFromEntry(
  attemptId: string,
  role: ExecutionRole,
  entry: FinishedEntry,
  reusedExecutionRef: string | null,
): AttemptExecutionResolution {
  const failure = entry.status === "failure" ? entry.failure : null;
  const cancelled =
    failure !== null && (failure.code === "CANCELLED" || failure.code === "ABORTED");
  return {
    kind: "terminal",
    role,
    executionRef: formatExecutionRef(attemptId, entry.generation, entry.ordinal),
    executionStatus: entry.status === "success" ? "success" : cancelled ? "cancelled" : "failure",
    output: entry.status === "success" ? entry.output : null,
    failure,
    reusedExecutionRef,
  };
}

function isPossibleRetryAwaiting(entry: FinishedEntry): boolean {
  if (entry.status !== "failure") return false;
  // Only the first try can be retried; a retried second try is final.
  if (entry.attemptNumber !== 1) return false;
  if (entry.failure?.code !== "EXIT") return false;
  if (typeof entry.exitCode !== "number" || entry.exitCode === 0) return false;
  return entry.durationMs < TRANSIENT_RETRY_MAX_DURATION_MS;
}

function parseFailure(value: unknown): AttemptFailureInfo | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.code !== "string" || row.code.length === 0) return null;
  return { code: row.code, message: typeof row.message === "string" ? row.message : "" };
}

function parseRoster(row: Record<string, unknown>): Roster {
  const attemptIds = new Set<string>();
  const collect = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const id = (item as Record<string, unknown>).attemptId;
      if (typeof id === "string" && id.length > 0) attemptIds.add(id);
    }
  };
  collect(row.attempts);
  // ideate.started splits its roster across proposals/debates.
  collect(row.proposals);
  collect(row.debates);
  let aggregatorAttemptId: string | null = null;
  if (row.aggregator !== null && typeof row.aggregator === "object") {
    const id = (row.aggregator as Record<string, unknown>).attemptId;
    if (typeof id === "string" && id.length > 0) aggregatorAttemptId = id;
  }
  return { attemptIds, aggregatorAttemptId };
}
