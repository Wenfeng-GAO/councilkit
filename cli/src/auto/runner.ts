/**
 * Parallel autonomous runner (DESIGN §2, plan §"runner 语义"). Spawns a pool
 * of fully-autonomous subprocesses, each in an isolated cwd, with per-Attempt
 * timeout + process-group kill on timeout/SIGINT. Failed Attempts are tolerated
 * and the pool keeps draining; a transient EXIT failure (non-zero, <120s, not
 * aborted) is retried ONCE inside the worker (plan §"瞬态重试").
 *
 * The runner never goes through the Runtime Host — it is direct spawn only. A
 * `spawnImpl` injection point lets tests drive the whole flow with zero real
 * processes.
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { redact } from "../redact";
import { formatDurationMs } from "./duration";
import {
  type AttemptActivity,
  type AttemptSpec,
  DriverActivityCollector,
  FinalEventLineCollector,
  extractFinalOutput,
} from "./driver-commands";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STDOUT_CAP = 8 * 1024 * 1024;
const STDERR_CAP = 1 * 1024 * 1024;
/** Grace window between SIGTERM and the SIGKILL upgrade. The run path awaits this
 * window before resolving so the upgrade is actually delivered (or proven
 * unnecessary by ESRCH) — otherwise a fire-and-forget timer can be cancelled by
 * an earlier process.exit, leaving process-group descendants alive. */
const KILL_GRACE_MS = 2000;

/** A never-aborting signal for callers that don't pass one. */
const NEVER_ABORTED = new AbortController().signal;

export type AttemptStatus = "success" | "failure";

export interface AttemptFailure {
  code: string;
  message: string;
}

/** Normalized exit code (P1-4): a subprocess killed by timeout/abort is recorded
 * as `"killed"` even when the kernel reports exit 0 for a SIGTERM death — a
 * killed Attempt must never display as `exit 0`. Old numeric/null records stay
 * valid (the transcript schema accepts all three). */
export type AttemptExitCode = number | "killed" | null;

/** Summary result for one Attempt (or the Aggregator spawn, same shape). */
export interface AttemptResult {
  attemptId: string;
  agentId: string;
  agentName: string;
  driverId: string;
  modelId: string;
  status: AttemptStatus;
  /** Extracted final text on success; raw/empty on failure. */
  output: string;
  exitCode: AttemptExitCode;
  durationMs: number;
  workspace: string;
  failure?: AttemptFailure;
  /** Incremental process summary (P2-1); absent when the stream had no
   * recognizable events ("无过程数据"), never an error. */
  activity?: AttemptActivity;
  /** True when this result was carried over from a previous run by `--resume`
   * (P2-2): not spawned, not probed, no workspace created. */
  reused?: boolean;
  /** 1-based physical execution index for this Attempt (plan §"瞬态重试").
   * Absent on pre-retry transcripts (and on synthetic/cancelled results);
   * present on every real execution so transcript records can be paired. */
  attemptNumber?: number;
  /** When this result is the retried second execution, the `attemptNumber` of
   * the failed first try it replaced (`1`). Absent on a non-retried Attempt. */
  retryOf?: number;
  /** This fresh result follows a FAILED attempt in the run being resumed —
   * the appendix marks it 「上一轮失败,resume 重跑」 (reviewer finding). */
  resumedAfterFailure?: boolean;
}

export interface SpawnInput {
  executable: string;
  argv: string[];
  cwd: string;
  prompt: string;
  promptStdin: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  /** Driver id; when claude/kimi, `defaultSpawn` streams stdout line-by-line to
   * capture the final-event line whole (bypassing the head+tail cap). */
  driverId?: string;
}

export interface SpawnOutput {
  stdout: string;
  /** Drained stderr (capped) — always read so the child's pipe never blocks. */
  stderr?: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the child could not be spawned at all (e.g. executable vanished). */
  error?: string;
  /** Last complete final-event line captured during streaming (claude/kimi).
   * Present only when `defaultSpawn` ran a line collector; absent for fakes. */
  finalEventLine?: string | null;
  /** Incremental process summary captured during streaming (P2-1). Present only
   * when `defaultSpawn` observed recognizable events; absent for fakes and for
   * unrecognized output formats. */
  activity?: AttemptActivity;
}

/** Injectable process-group kill (defaults to `process.kill(-pid, signal)`). */
export type KillProcessGroup = (negativePid: number, signal: NodeJS.Signals) => void;

/** Default kill: signal the whole process group via the negative pid. */
function defaultKillProcessGroup(negativePid: number, signal: NodeJS.Signals): void {
  process.kill(negativePid, signal);
}

/** Test injection point: a fake spawn replaces the real child_process spawn. */
export type SpawnImpl = (input: SpawnInput) => Promise<SpawnOutput>;

/** Injectable clock + interval handles (P2-1 heartbeat). Tests drive the
 * heartbeat with a fake clock; production uses the MONOTONIC
 * `performance.now()` — a wall-clock rollback (NTP slew) must never make a
 * long-running Attempt look like a sub-120s transient failure and trigger a
 * retry (reviewer finding). */
export interface RunnerTimers {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: RunnerTimers = {
  // Round to integer ms: the transcript schema requires nonnegative integers,
  // and performance.now() is fractional (reviewer finding's schema regression).
  now: () => Math.round(performance.now()),
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    // Never let a heartbeat keep the process alive on its own.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
};

/** Default human heartbeat cadence (P2-1): one "仍在运行" line every 30s. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface RunnerOptions {
  timeoutMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
  spawnImpl?: SpawnImpl;
  onAttemptStart?: (attemptId: string, agentName: string) => void;
  onAttemptFinish?: (result: AttemptResult) => void;
  /** Heartbeat cadence for `onHeartbeat` (defaults to 30s). */
  heartbeatIntervalMs?: number;
  /** Called once per heartbeat while an Attempt is still running. Not used for
   * the Aggregator spawn (aggregation is not an Attempt). */
  onHeartbeat?: (attemptId: string, agentName: string, elapsedMs: number) => void;
  timers?: RunnerTimers;
  /** Rebuild an Attempt's workspace to a pristine empty dir BEFORE the retry
   * spawn (reviewer finding: the retry reused the first try's dirty cwd, so a
   * codex leftover `.last-message.md` could pass a no-output second try off as
   * a real deliverable). Wired by the command layer to its fs-safe
   * delete-then-recreate path; absent for callers that don't own a workspace
   * (probe / Aggregator never retry, and tests can inject a fake). */
  rebuildWorkspaceBeforeRetry?: (spec: AttemptSpec) => void;
}

export interface RunAttemptsOutcome {
  results: AttemptResult[];
  /** True when the abort signal fired (SIGINT). */
  aborted: boolean;
}

/** Run a pool of Attempts with a shared cursor; results are written back in
 * original order. Tolerates per-Attempt failure; retries a transient EXIT
 * failure once (see `shouldRetry`). */
export async function runAttempts(
  specs: ReadonlyArray<AttemptSpec>,
  opts: RunnerOptions = {},
): Promise<RunAttemptsOutcome> {
  const results: (AttemptResult | undefined)[] = new Array(specs.length);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, opts.concurrency ?? Math.min(3, specs.length));
  let aborted = false;

  // Internal controller so a run-level failure (e.g. onAttemptFinish throwing on
  // a transcript write) can still KILL in-flight detached children before the
  // error propagates — otherwise the pool's other subprocesses outlive the run
  // and become orphans (reviewer finding: orphan-on-failure).
  const internal = new AbortController();
  const external = opts.signal ?? NEVER_ABORTED;
  const onExternalAbort = (): void => {
    aborted = true;
    internal.abort();
  };
  if (external.aborted) {
    aborted = true;
    internal.abort();
  } else {
    external.addEventListener("abort", onExternalAbort, { once: true });
  }

  const killInFlight = (): void => {
    aborted = true;
    internal.abort();
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) break;
      const i = cursor++;
      if (i >= specs.length) break;
      const spec = specs[i];
      opts.onAttemptStart?.(spec.attemptId, spec.agentName);
      let result: AttemptResult;
      try {
        result = await runSpecWithRetry(spec);
      } catch (error) {
        killInFlight();
        throw error;
      }
      results[i] = result;
    }
  };

  /** Run a single spec, retrying ONCE on a transient EXIT failure (plan §"瞬态
   * 重试"). Each physical execution triggers `onAttemptFinish` with a 1-based
   * `attemptNumber` (the retry carries `retryOf`); `results[i]` keeps only the
   * final result. The retry is layered HERE — not inside `runOne` — so the
   * probe and Aggregator (which use `spawnOnce` → `runOne` directly) are never
   * retried, and the per-execution callback can append each try to the transcript. */
  const runSpecWithRetry = async (spec: AttemptSpec): Promise<AttemptResult> => {
    const subOpts = { ...opts, timeoutMs, signal: internal.signal };
    const first = await runOne(spec, subOpts);
    const firstResult: AttemptResult = { ...first, attemptNumber: 1 };
    opts.onAttemptFinish?.(firstResult);
    if (shouldRetry(firstResult, internal.signal)) {
      // Rebuild a PRISTINE workspace before the retry spawn: the first try's
      // cwd now holds its leftovers (a stale checkout, codex's `.last-message.md`,
      // …) and reusing it would let a no-output second try piggyback on the
      // first try's artifacts and pass off stale bytes as a fresh deliverable
      // (reviewer finding). The command layer owns the workspace lifecycle, so
      // it injects the fs-safe delete-then-recreate path here; a throw propagates
      // through the worker's try/catch and kills the pool like any run failure.
      opts.rebuildWorkspaceBeforeRetry?.(spec);
      const second = await runOne(spec, subOpts);
      const secondResult: AttemptResult = { ...second, attemptNumber: 2, retryOf: 1 };
      opts.onAttemptFinish?.(secondResult);
      return secondResult;
    }
    return firstResult;
  };

  const workers = Array.from({ length: Math.min(concurrency, specs.length) }, () => worker());
  const outcomes = await Promise.allSettled(workers);
  external.removeEventListener("abort", onExternalAbort);

  const firstRejected = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
  if (firstRejected !== undefined) {
    throw firstRejected.reason;
  }

  // Any spec never claimed (because the run was aborted) is a cancelled failure.
  // These still get an onAttemptFinish callback so the transcript carries a
  // record for every attempt — including the never-started cancelled ones
  // (reviewer finding: cancelled attempts had no transcript entry).
  for (let i = 0; i < specs.length; i++) {
    if (results[i] === undefined) {
      const spec = specs[i];
      const cancelled: AttemptResult = {
        attemptId: spec.attemptId,
        agentId: spec.agentId,
        agentName: spec.agentName,
        driverId: spec.driverId,
        modelId: spec.modelId,
        status: "failure",
        output: "",
        exitCode: null,
        durationMs: 0,
        workspace: spec.cwd,
        failure: { code: "CANCELLED", message: "run aborted before this attempt started" },
      };
      results[i] = cancelled;
      // Mirror worker semantics: a finish-callback failure (e.g. transcript IO)
      // propagates so the caller surfaces it. The run is already aborted; there
      // is nothing left to kill.
      opts.onAttemptFinish?.(cancelled);
    }
  }
  return { results: results as AttemptResult[], aborted };
}

/** Transient-EXIT retry predicate (plan §"瞬态重试"): retry ONCE only when the
 * Attempt failed with a non-zero EXIT code in under 120s and the run is not
 * being aborted. TIMEOUT / NO_OUTPUT / SPAWN_ERROR / ABORTED never match
 * (SPAWN_ERROR included — the frozen brief restricts retry to EXIT; a fast
 * stream-level flake is accepted as a tolerable attempt failure for now and
 * is queued as a next-iteration candidate, see decisions D4).
 * DRIVER_UNREACHABLE is resolved at the command layer and never reaches the
 * runner. A second failure is final — there is never a third try. */
function shouldRetry(result: AttemptResult, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (result.failure?.code !== "EXIT") return false;
  if (typeof result.exitCode !== "number" || result.exitCode === 0) return false;
  return result.durationMs < 120_000;
}

/** Run a single AttemptSpec (used by the Aggregator spawn). */
export async function spawnOnce(
  spec: AttemptSpec,
  opts: RunnerOptions = {},
): Promise<AttemptResult> {
  return runOne(spec, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal ?? NEVER_ABORTED,
    spawnImpl: opts.spawnImpl,
  });
}

async function runOne(
  spec: AttemptSpec,
  opts: {
    timeoutMs: number;
    signal: AbortSignal;
    spawnImpl?: SpawnImpl;
    heartbeatIntervalMs?: number;
    onHeartbeat?: (attemptId: string, agentName: string, elapsedMs: number) => void;
    timers?: RunnerTimers;
  },
): Promise<AttemptResult> {
  const timers = opts.timers ?? defaultTimers;
  const started = timers.now();
  const spawnFn = opts.spawnImpl ?? defaultSpawn;

  // Human heartbeat (P2-1): a "仍在运行" line every heartbeatIntervalMs while
  // the Attempt runs. Always cleared in finally so a finished Attempt never
  // heartbeats again and the timer cannot leak.
  let heartbeat: unknown;
  if (opts.onHeartbeat !== undefined) {
    const intervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    heartbeat = timers.setInterval(() => {
      opts.onHeartbeat?.(spec.attemptId, spec.agentName, timers.now() - started);
    }, intervalMs);
  }

  let out: SpawnOutput;
  try {
    out = await spawnFn({
      executable: spec.executable,
      argv: spec.argv,
      cwd: spec.cwd,
      prompt: spec.prompt,
      promptStdin: spec.promptStdin,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      driverId: spec.driverId,
    });
  } finally {
    if (heartbeat !== undefined) timers.clearInterval(heartbeat);
  }
  // Clamp at zero: even with a monotonic clock, a fake/injected timer may jump
  // backwards; a negative durationMs would violate the transcript's
  // nonnegative schema and break --resume parsing (reviewer finding).
  const durationMs = Math.max(0, timers.now() - started);

  const extracted =
    out.error !== undefined
      ? null
      : extractFinalOutput(spec.driverId, out.stdout, spec.lastMessageFile, out.finalEventLine);

  let failure: AttemptFailure | undefined;
  if (out.error !== undefined) {
    failure = { code: "SPAWN_ERROR", message: out.error };
  } else if (out.timedOut) {
    failure = { code: "TIMEOUT", message: `timed out after ${formatDurationMs(opts.timeoutMs)}` };
  } else if (out.aborted) {
    failure = { code: "ABORTED", message: "aborted by cancellation signal" };
  } else if (out.exitCode !== 0) {
    failure = { code: "EXIT", message: formatExitFailure(out.exitCode, out.stderr) };
  } else if (extracted === null || extracted.trim().length === 0) {
    failure = { code: "NO_OUTPUT", message: "no final output extracted from driver" };
  }

  return {
    attemptId: spec.attemptId,
    agentId: spec.agentId,
    agentName: spec.agentName,
    driverId: spec.driverId,
    modelId: spec.modelId,
    status: failure === undefined ? "success" : "failure",
    output: extracted ?? "",
    // Normalize a timeout/abort kill to "killed" (P1-4): a child reaped with
    // exit 0 after SIGTERM must not display as a clean exit.
    exitCode: out.timedOut || out.aborted ? "killed" : out.exitCode,
    durationMs,
    workspace: spec.cwd,
    failure,
    activity: out.activity,
  };
}

/** Bounded byte collector with head+tail retention. The final output of every
 * driver lives at the *end* of its stream (claude `{"type":"result"}`, kimi last
 * assistant line, codex tail), so a naive prefix-only cap would discard exactly
 * the bytes we need to extract. We keep the first `headCap` bytes and the last
 * `tailCap` bytes, marking the elided middle. */
class CappedCollector {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;
  truncated = false;

  constructor(
    private readonly cap: number,
    private readonly headCap: number,
    private readonly tailCap: number,
  ) {}

  feed(buf: Buffer): void {
    this.total += buf.length;
    let rest: Buffer | undefined;
    if (this.headBytes < this.headCap) {
      const room = this.headCap - this.headBytes;
      if (buf.length <= room) {
        this.head.push(buf);
        this.headBytes += buf.length;
      } else {
        this.head.push(buf.subarray(0, room));
        this.headBytes = this.headCap;
        rest = buf.subarray(room);
      }
    } else {
      rest = buf;
    }
    if (rest !== undefined) {
      this.tail.push(rest);
      this.tailBytes += rest.length;
      while (this.tailBytes > this.tailCap) {
        if (this.tail.length === 1) {
          // A single chunk larger than the tail cap: keep only its last tailCap
          // bytes (the most recent bytes are what we want at the tail).
          const only = this.tail[0];
          this.tail[0] = only.subarray(only.length - this.tailCap);
          this.tailBytes = this.tail[0].length;
          break;
        }
        const dropped = this.tail.shift() as Buffer;
        this.tailBytes -= dropped.length;
      }
    }
    if (this.total > this.cap) this.truncated = true;
  }

  toString(): string {
    if (!this.truncated) {
      return Buffer.concat([...this.head, ...this.tail]).toString("utf8");
    }
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    const omitted = this.total - this.headBytes - this.tailBytes;
    return `${head}\n[truncated ${omitted} bytes]\n${tail}`;
  }
}

/** Default real spawn: detached process group, stdin prompt delivery, stdout
 * capped at 8MB (head+tail) plus a streaming final-event line collector for
 * claude/kimi, stderr drained to a 1MB cap (head+tail) so the pipe never blocks,
 * timeout + abort both kill the group (SIGTERM → grace → SIGKILL). The optional
 * `spawnFn` lets tests drive this path with a fake ChildProcess; `killFn` lets
 * tests assert the kill sequence without touching the real `process.kill`. */
export function defaultSpawn(
  input: SpawnInput,
  spawnFn: typeof spawn = spawn,
  killFn: KillProcessGroup = defaultKillProcessGroup,
): Promise<SpawnOutput> {
  return new Promise((resolveOutput) => {
    let settled = false;
    let killReason: "timeout" | "abort" | "stream" | null = null;
    let killInitiated = false;
    let killPromise: Promise<void> = Promise.resolve();
    const stdoutColl = new CappedCollector(STDOUT_CAP, STDOUT_CAP / 2, STDOUT_CAP / 2);
    const stderrColl = new CappedCollector(STDERR_CAP, STDERR_CAP / 2, STDERR_CAP / 2);
    const lineColl =
      input.driverId === "claude-stream-json" || input.driverId === "kimi-stream-json"
        ? new FinalEventLineCollector(input.driverId)
        : null;
    // Incremental process observer (P2-1): fed with the same stdout chunks, so
    // tool events are counted even when the 8MB head+tail cap elides the middle
    // of the stream. Unknown driver ids simply never match an event shape.
    const activityColl =
      input.driverId !== undefined ? new DriverActivityCollector(input.driverId) : null;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(input.executable, input.argv, {
        cwd: input.cwd,
        env: process.env,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolveOutput({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        aborted: false,
        error: errMsg(error),
      });
      return;
    }

    // Resolve only after the kill upgrade window has elapsed (when a kill was
    // initiated), so the SIGKILL is actually delivered — or proven unnecessary
    // by ESRCH — before the caller can process.exit and cancel the pending timer.
    const finish = (out: SpawnOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(drainTimer);
      input.signal.removeEventListener("abort", onAbort);
      // Flush the activity collector's trailing line and attach the summary to
      // every settle path (success, error, timeout) — a killed Attempt still
      // carries the process data gathered before the kill.
      activityColl?.end();
      const activity = activityColl?.summary();
      const finalOut = activity === undefined ? out : { ...out, activity };
      if (killInitiated) {
        killPromise.then(() => resolveOutput(finalOut));
      } else {
        resolveOutput(finalOut);
      }
    };

    const killGroup = (reason: "timeout" | "abort" | "stream"): void => {
      if (settled) return;
      // Re-entry guard: only the FIRST kill sequence runs. A second entry
      // (e.g. abort after timeout) must not replace or confuse the in-flight
      // TERM→grace→KILL promise — and in particular must not SIGTERM again,
      // get ESRCH, and leave the stale SIGKILL aimed at a reused PGID.
      if (killInitiated) return;
      killReason = reason;
      killInitiated = true;
      try {
        child.stdin?.destroy();
      } catch {
        // stdin already gone — best effort.
      }
      if (child.pid !== undefined) {
        const pid = child.pid;
        let termDelivered = true;
        try {
          killFn(-pid, "SIGTERM");
        } catch {
          // ESRCH proves the group is already gone; EPERM (or anything else)
          // means we cannot kill it — but THROWING here would escape a
          // timer/AbortSignal callback as an uncaught exception and crash the
          // CLI with no ReviewOutcome (reviewer finding). Either way there is
          // nothing more to attempt.
          termDelivered = false;
        }
        if (termDelivered) {
          killPromise = new Promise<void>((resolveKill) => {
            setTimeout(() => {
              try {
                killFn(-pid, "SIGKILL");
              } catch {
                // best effort — group already gone or not killable.
              } finally {
                resolveKill();
              }
            }, KILL_GRACE_MS);
          });
        } else if (reason !== "stream") {
          // The TERM is undeliverable and the leader may keep running — NOTHING
          // else will settle this spawn (no close, no later cleanup: the
          // re-entry guard blocks them), so it would hang forever (reviewer
          // finding). Settle now with the reason's classification. The "stream"
          // reason is excluded: onStreamError settles right after us WITH the
          // real error, and settling here first would drop it behind the
          // settled guard (second finding).
          finish({
            stdout: stdoutColl.toString(),
            stderr: stderrColl.toString(),
            finalEventLine: lineColl?.lastLine ?? undefined,
            exitCode: null,
            timedOut: reason === "timeout",
            aborted: reason === "abort",
          });
        }
      }
    };

    const onAbort = (): void => killGroup("abort");
    const timeoutTimer = setTimeout(() => killGroup("timeout"), input.timeoutMs);
    input.signal.addEventListener("abort", onAbort, { once: true });

    // A stream error (e.g. EPIPE when the child died before we finished writing
    // the prompt) must never crash the CLI as an unhandled 'error' on stdin /
    // stdout / stderr. Treat it as a spawn-level failure and clean up normally.
    const onStreamError = (error: Error): void => {
      // A stream error (e.g. EPIPE when the child died before we finished
      // writing the prompt) means the pipe is gone but the child may still be
      // running. Kill the whole process group via the same TERM→grace→KILL
      // path as timeout/abort BEFORE settling — otherwise the child outlives
      // its pipes and becomes an orphan (reviewer finding: a stream-error
      // finish cleaned the listeners but never signaled the group). killGroup
      // is a no-op when already settled (e.g. a late error after close).
      killGroup("stream");
      finish({
        stdout: stdoutColl.toString(),
        stderr: stderrColl.toString(),
        exitCode: null,
        timedOut: killReason === "timeout",
        aborted: killReason === "abort",
        error: errMsg(error),
      });
    };
    child.stdout?.on("error", onStreamError);
    child.stderr?.on("error", onStreamError);
    child.stdin?.on("error", onStreamError);

    // Drain BOTH pipes. stderr is collected (capped) but never left unread — an
    // unread pipe fills its kernel buffer and the child blocks on its next write.
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutColl.feed(chunk);
      lineColl?.feed(chunk);
      activityColl?.feed(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => stderrColl.feed(chunk));

    child.on("spawn", () => {
      // If the abort fired before the child existed, kill it now.
      if (input.signal.aborted) killGroup("abort");
      if (input.promptStdin && input.prompt.length > 0) {
        try {
          child.stdin?.write(input.prompt);
        } catch (error) {
          onStreamError(error as Error);
          return;
        }
      }
      child.stdin?.end();
    });

    child.on("error", (error) => {
      finish({
        stdout: stdoutColl.toString(),
        stderr: stderrColl.toString(),
        exitCode: null,
        timedOut: false,
        aborted: false,
        error: errMsg(error),
      });
    });

    /** Start the TERM→grace→KILL cleanup for a NATURALLY ended leader (once).
     * Bound to `exit` (fires when the leader process exits) rather than only
     * `close`: background children that inherited the stdio pipes would
     * otherwise hold `close` off until the turn timeout — a fast EXIT would be
     * misread as TIMEOUT and skip the retry (reviewer finding). Kill errors
     * (EPERM included) are ALL swallowed: throwing inside an EventEmitter
     * callback would crash the CLI without any ReviewOutcome (second finding).
     * killInitiated is set ONLY when the TERM was actually delivered —
     * otherwise the re-entry guard would block a later timeout/abort killGroup
     * and leave the child running (third finding). */
    let naturalCleanupRan = false;
    /** The leader's exit code/signal when `exit` fires — needed to settle
     * immediately if the cleanup TERM is undeliverable (see below). */
    let leaderExitCode: number | null = null;
    const cleanupGroupOnNaturalEnd = (): void => {
      if (naturalCleanupRan || killInitiated) return;
      naturalCleanupRan = true;
      if (child.pid === undefined) return;
      const pid = child.pid;
      let termDelivered = true;
      try {
        killFn(-pid, "SIGTERM");
      } catch {
        // ESRCH / EPERM / anything — best effort, never throw here.
        termDelivered = false;
      }
      if (termDelivered) {
        killInitiated = true;
        killPromise = new Promise<void>((resolveKill) => {
          setTimeout(() => {
            try {
              killFn(-pid, "SIGKILL");
            } catch {
              // best effort — group already gone or not killable.
            } finally {
              resolveKill();
            }
          }, KILL_GRACE_MS);
        });
      }
    };
    /** Bounded drain: after the leader exits, `close` normally follows quickly
     * — but descendants that inherited the pipes (possibly in another PGID)
     * can hold them forever (reviewer finding). Give the pipes DRAIN_GRACE_MS
     * to flush the final event, then settle with the leader's code. This also
     * covers the EPERM case WITHOUT settling before the drain (second
     * finding). */
    const DRAIN_GRACE_MS = 3_000;
    const settleAfterDrain = (): void => {
      lineColl?.end();
      finish({
        stdout: stdoutColl.toString(),
        stderr: stderrColl.toString(),
        finalEventLine: lineColl?.lastLine ?? undefined,
        exitCode: leaderExitCode,
        // Preserve a real timeout/abort — clobbering it would misreport a
        // TIMEOUT as EXIT and could even satisfy the retry predicate
        // (reviewer finding).
        timedOut: killReason === "timeout",
        aborted: killReason === "abort",
      });
    };
    let drainTimer: NodeJS.Timeout;
    // `exit` = leader process ended (kill stragglers so pipes can close, and
    // bound the drain); `close` = stdio drained (settle the result first).
    child.on("exit", (code) => {
      leaderExitCode = code ?? null;
      cleanupGroupOnNaturalEnd();
      if (!settled) {
        drainTimer = setTimeout(settleAfterDrain, DRAIN_GRACE_MS);
        (drainTimer as { unref?: () => void }).unref?.();
      }
    });

    child.on("close", (code) => {
      cleanupGroupOnNaturalEnd();
      // Flush the collector's trailing bytes: the final NDJSON line may end
      // without a newline, and skipping it would leave lastLine stale
      // (reviewer finding: no EOF handling in the line collector).
      lineColl?.end();
      finish({
        stdout: stdoutColl.toString(),
        stderr: stderrColl.toString(),
        finalEventLine: lineColl?.lastLine ?? undefined,
        exitCode: code ?? null,
        timedOut: killReason === "timeout",
        aborted: killReason === "abort",
      });
    });
  });
}

function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  // Surface node's system-error code when available (e.g. ENOENT from spawn).
  const code = (error as { code?: string })?.code;
  return code ?? String(error);
}

/** Max stderr bytes attached to an EXIT failure message. Keeps the transcript
 * and outcome readable while surfacing the real error instead of just
 * "non-zero exit N" — the driver's stderr is the only durable diagnostic for a
 * crash/usage failure (reviewer finding: runOne discarded the collected stderr). */
const STDERR_TAIL_BYTES = 2 * 1024;

function formatExitFailure(exitCode: number | null, stderr?: string): string {
  const base = `non-zero exit ${exitCode}`;
  if (stderr === undefined) return base;
  const tail = stderrTail(stderr);
  return tail.length === 0 ? base : `${base}\n${tail}`;
}

/** Last ≤2KB of stderr (trimmed), prefixed with an ellipsis when truncated.
 * Before persisting to transcript/report, run it through secret `redact` and
 * strip ANSI/control characters — a driver's stderr can carry credential-shaped
 * strings or terminal escape sequences that would otherwise land on disk or
 * corrupt the Markdown report structure (reviewer finding). */
function stderrTail(stderr: string): string {
  // Strip ANSI/control chars FIRST (an escape sequence could split a credential
  // so redact cannot see it), THEN redact the reassembled text — otherwise a
  // credential hidden as "councilkit<ESC>[31m_session=…" would survive into
  // transcript/report (reviewer finding). \r is stripped too: it can overwrite
  // a terminal line or smuggle raw control into the Markdown report.
  const cleaned = stderr
    // CSI sequences (ESC [ parameter-bytes(0x30-0x3F) intermediate-bytes
    // (0x20-0x2F) final-byte(0x40-0x7E)) — digits/semicolons alone would leave
    // private-parameter or intermediate-byte CSI payloads printable (reviewer
    // finding).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches ANSI CSI escape sequences in untrusted driver stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // OSC/DCS/SOS/PM/APC (ESC ] P X ^ _ … terminated by BEL or ST): drop the
    // WHOLE sequence including its printable payload — an OSC payload can carry
    // ";"-separated text that would otherwise survive and break credential
    // redaction (reviewer finding: only CSI was removed).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches ANSI OSC/DCS/SOS/PM/APC string sequences in untrusted driver stderr
    .replace(/\u001b[\]PX^_][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, "")
    // C1 string sequences (DCS U+0090, SOS U+0098, OSC U+009D, PM U+009E,
    // APC U+009F … terminated by BEL or ST U+009C): drop the whole sequence —
    // otherwise the introducer/terminator are stripped by the C1 class below
    // while the printable payload survives and can split a credential
    // (reviewer finding).
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches C1 string sequences in untrusted driver stderr
      /[\u0090\u0098\u009d\u009e\u009f][^\u0007\u001b\u009c]*(?:\u0007|\u009c|\u001b\\)?/g,
      "",
    )
    // C1 single-byte CSI (U+009B + same parameter/intermediate/final shape):
    // without this the introducer is stripped by the C1 class below while its
    // parameter bytes stay printable and can split a credential (reviewer
    // finding).
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    // Any remaining ESC sequence in ECMA-48 shape: ESC + intermediate bytes
    // (0x20-0x2F)* + one final byte (0x30-0x7E). Covers ISO-2022 designation
    // sequences like ESC ( B that a two-byte rule would leave a printable tail
    // on (reviewer finding).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches remaining ECMA-48 ESC sequences in untrusted driver stderr
    .replace(/\u001b[\x20-\x2f]*[\x30-\x7e]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately strips C0/C1 control chars and DEL (except \n and \t) from untrusted stderr
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\u009f]/g, "");
  const redacted = redact(cleaned) as string;
  const trimmed = redacted.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= STDERR_TAIL_BYTES) return trimmed;
  return `…${trimmed.slice(trimmed.length - STDERR_TAIL_BYTES)}`;
}
