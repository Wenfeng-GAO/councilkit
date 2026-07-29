/**
 * Parallel autonomous runner (DESIGN §2, plan §"runner 语义"). Spawns a pool
 * of fully-autonomous subprocesses, each in an isolated cwd, with per-Attempt
 * timeout + process-group kill on timeout/SIGINT. Failed Attempts are tolerated
 * (never retried) and the pool keeps draining.
 *
 * The runner never goes through the Runtime Host — it is direct spawn only. A
 * `spawnImpl` injection point lets tests drive the whole flow with zero real
 * processes.
 */
import { spawn } from "node:child_process";
import { redact } from "../redact";
import { type AttemptSpec, FinalEventLineCollector, extractFinalOutput } from "./driver-commands";

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
  exitCode: number | null;
  durationMs: number;
  workspace: string;
  failure?: AttemptFailure;
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
}

/** Injectable process-group kill (defaults to `process.kill(-pid, signal)`). */
export type KillProcessGroup = (negativePid: number, signal: NodeJS.Signals) => void;

/** Default kill: signal the whole process group via the negative pid. */
function defaultKillProcessGroup(negativePid: number, signal: NodeJS.Signals): void {
  process.kill(negativePid, signal);
}

/** Test injection point: a fake spawn replaces the real child_process spawn. */
export type SpawnImpl = (input: SpawnInput) => Promise<SpawnOutput>;

export interface RunnerOptions {
  timeoutMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
  spawnImpl?: SpawnImpl;
  onAttemptStart?: (attemptId: string, agentName: string) => void;
  onAttemptFinish?: (result: AttemptResult) => void;
}

export interface RunAttemptsOutcome {
  results: AttemptResult[];
  /** True when the abort signal fired (SIGINT). */
  aborted: boolean;
}

/** Run a pool of Attempts with a shared cursor; results are written back in
 * original order. Tolerates per-Attempt failure; never retries. */
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
        result = await runOne(spec, { ...opts, timeoutMs, signal: internal.signal });
      } catch (error) {
        killInFlight();
        throw error;
      }
      try {
        opts.onAttemptFinish?.(result);
      } catch (error) {
        // A finish callback (e.g. transcript persistence) failed. Kill every
        // in-flight child via the internal abort, then propagate the error.
        killInFlight();
        throw error;
      }
      results[i] = result;
    }
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
  opts: { timeoutMs: number; signal: AbortSignal; spawnImpl?: SpawnImpl },
): Promise<AttemptResult> {
  const started = Date.now();
  const spawnFn = opts.spawnImpl ?? defaultSpawn;
  const out = await spawnFn({
    executable: spec.executable,
    argv: spec.argv,
    cwd: spec.cwd,
    prompt: spec.prompt,
    promptStdin: spec.promptStdin,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    driverId: spec.driverId,
  });
  const durationMs = Date.now() - started;

  const extracted =
    out.error !== undefined
      ? null
      : extractFinalOutput(spec.driverId, out.stdout, spec.lastMessageFile, out.finalEventLine);

  let failure: AttemptFailure | undefined;
  if (out.error !== undefined) {
    failure = { code: "SPAWN_ERROR", message: out.error };
  } else if (out.timedOut) {
    failure = { code: "TIMEOUT", message: `timed out after ${opts.timeoutMs}ms` };
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
    exitCode: out.exitCode,
    durationMs,
    workspace: spec.cwd,
    failure,
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
      input.signal.removeEventListener("abort", onAbort);
      if (killInitiated) {
        killPromise.then(() => resolveOutput(out));
      } else {
        resolveOutput(out);
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
        } catch (error) {
          if (!isESRCH(error)) throw error;
          // ESRCH proves the process group is already gone: skip the grace
          // wait AND the SIGKILL — killing a possibly-reused PGID could hit an
          // unrelated process group (reviewer finding).
          termDelivered = false;
        }
        if (termDelivered) {
          killPromise = new Promise<void>((resolveKill) => {
            setTimeout(() => {
              try {
                killFn(-pid, "SIGKILL");
              } catch (error) {
                if (!isESRCH(error)) {
                  // Unexpected — nothing more we can do; best effort.
                }
              } finally {
                resolveKill();
              }
            }, KILL_GRACE_MS);
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

    child.on("close", (code) => {
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

function isESRCH(error: unknown): boolean {
  return (error as { code?: string })?.code === "ESRCH";
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
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // OSC/DCS/SOS/PM/APC (ESC ] P X ^ _ … terminated by BEL or ST): drop the
    // WHOLE sequence including its printable payload — an OSC payload can carry
    // ";"-separated text that would otherwise survive and break credential
    // redaction (reviewer finding: only CSI was removed).
    .replace(/\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    // C1 string sequences (DCS U+0090, SOS U+0098, OSC U+009D, PM U+009E,
    // APC U+009F … terminated by BEL or ST U+009C): drop the whole sequence —
    // otherwise the introducer/terminator are stripped by the C1 class below
    // while the printable payload survives and can split a credential
    // (reviewer finding).
    .replace(/[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u009c)/g, "")
    // C1 single-byte CSI (U+009B + same parameter/intermediate/final shape):
    // without this the introducer is stripped by the C1 class below while its
    // parameter bytes stay printable and can split a credential (reviewer
    // finding).
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    // Any remaining two-byte escape (ESC + one char)
    .replace(/\u001b./g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately strips C0/C1 control chars and DEL (except \n and \t) from untrusted stderr
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\u009f]/g, "");
  const redacted = redact(cleaned) as string;
  const trimmed = redacted.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= STDERR_TAIL_BYTES) return trimmed;
  return `…${trimmed.slice(trimmed.length - STDERR_TAIL_BYTES)}`;
}
