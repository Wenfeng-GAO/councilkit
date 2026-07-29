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
import { type AttemptSpec, extractFinalOutput } from "./driver-commands";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STDOUT_CAP = 8 * 1024 * 1024;
const STDERR_CAP = 1 * 1024 * 1024;
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
  for (let i = 0; i < specs.length; i++) {
    if (results[i] === undefined) {
      const spec = specs[i];
      results[i] = {
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
  });
  const durationMs = Date.now() - started;

  const extracted =
    out.error !== undefined
      ? null
      : extractFinalOutput(spec.driverId, out.stdout, spec.lastMessageFile);

  let failure: AttemptFailure | undefined;
  if (out.error !== undefined) {
    failure = { code: "SPAWN_ERROR", message: out.error };
  } else if (out.timedOut) {
    failure = { code: "TIMEOUT", message: `timed out after ${opts.timeoutMs}ms` };
  } else if (out.aborted) {
    failure = { code: "ABORTED", message: "aborted by cancellation signal" };
  } else if (out.exitCode !== 0) {
    failure = { code: "EXIT", message: `non-zero exit ${out.exitCode}` };
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
 * capped at 8MB (head+tail), stderr drained to a 1MB cap (head+tail) so the pipe
 * never blocks, timeout + abort both kill the group (SIGTERM → grace → SIGKILL).
 * The optional `spawnFn` lets tests drive this path with a fake ChildProcess. */
export function defaultSpawn(
  input: SpawnInput,
  spawnFn: typeof spawn = spawn,
): Promise<SpawnOutput> {
  return new Promise((resolveOutput) => {
    let settled = false;
    let killReason: "timeout" | "abort" | null = null;
    const stdoutColl = new CappedCollector(STDOUT_CAP, STDOUT_CAP / 2, STDOUT_CAP / 2);
    const stderrColl = new CappedCollector(STDERR_CAP, STDERR_CAP / 2, STDERR_CAP / 2);

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

    const finish = (out: SpawnOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      input.signal.removeEventListener("abort", onAbort);
      resolveOutput(out);
    };

    const killGroup = (reason: "timeout" | "abort"): void => {
      if (settled) return;
      killReason = reason;
      try {
        child.stdin?.destroy();
      } catch {
        // stdin already gone — best effort.
      }
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (!isESRCH(error)) throw error;
        }
        const pid = child.pid;
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if (!isESRCH(error)) {
              // Process gone — nothing more to do.
            }
          }
        }, KILL_GRACE_MS);
      }
    };

    const onAbort = (): void => killGroup("abort");
    const timeoutTimer = setTimeout(() => killGroup("timeout"), input.timeoutMs);
    input.signal.addEventListener("abort", onAbort, { once: true });

    // Drain BOTH pipes. stderr is collected (capped) but never left unread — an
    // unread pipe fills its kernel buffer and the child blocks on its next write.
    child.stdout?.on("data", (chunk: Buffer) => stdoutColl.feed(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrColl.feed(chunk));

    child.on("spawn", () => {
      // If the abort fired before the child existed, kill it now.
      if (input.signal.aborted) killGroup("abort");
      if (input.promptStdin && input.prompt.length > 0) {
        child.stdin?.write(input.prompt);
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
      finish({
        stdout: stdoutColl.toString(),
        stderr: stderrColl.toString(),
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
