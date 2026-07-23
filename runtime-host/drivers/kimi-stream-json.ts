import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@shared/runtime/contracts";
import type { ToolState } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import { sanitizeString } from "../logging";
import { type DriverProcess, createBoundedRing } from "../process/process-supervisor";
import { attachNdjsonSplitter, withDeadline } from "./ndjson";
import type {
  DriverDeps,
  DriverEvent,
  Emit,
  ExecuteInput,
  ParticipantDriver,
  PrewarmInput,
  PrewarmResult,
} from "./types";

/**
 * `kimi-stream-json` Driver: one short-lived `kimi -p <prompt> --output-format
 * stream-json` process PER TURN per Participant, with Participant-level session
 * ID continuity via `-S <session_id>` resume. This is a controlled exception to
 * the "one long-lived process per Participant" principle: the Kimi CLI exposes
 * no long-lived stdin mode (E1), so a turn is a fresh process that resumes the
 * CLI's own externally-persisted session. Verified live against kimi-code
 * (2026-07-22): `kimi provider list` (text) yields `Default model: kimi-code/k3`
 * with no secret fields; a turn emits exactly two final-only frames
 * `{"role":"assistant","content":"..."}` (authoritative) and
 * `{"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>"}`
 * — no streaming deltas, no usage, no effective-model echo (E7).
 *
 * The closed catalog is the verified coding-plan K3 set `["kimi-code/k3"]`.
 * Driver never reads `provider list --json` (its provider nodes carry OAuth/API
 * key fields — Host stays out of secrets); the text probe is diagnostic only,
 * execution always passes an explicit `-m`.
 *
 * Tool state from protocol evidence (D7, ADR-0012; E10 probe
 * /tmp/kimi-probe-tools.out): `kimi -p --output-format stream-json` DOES carry
 * tool telemetry — assistant frames with a `tool_calls` field and `role:"tool"`
 * frames — and a tooled turn's raw tool stdout leaks as bare non-JSON lines on
 * the stream (E10: ~720 bare lines vs 4 JSON frames). The driver maps the
 * terminal `toolState` from that evidence, aligned with the codex semantics
 * (none → active → completed / crash → unknown):
 *   - exit 0, NO tool frames AND NO off-protocol non-JSON lines → `"none"`
 *     (the protocol proves an assistant content frame with no tool activity —
 *     a discussion-shaped turn). A clean no-tool terminal is committable; the
 *     commit pipeline's `classifyCompleted` admits `none` and `completed` and
 *     discards only `unknown` (commit-execution.ts:64-81).
 *   - exit 0, tool frames OR role:"tool" frames present → `"completed"`
 *     (provable tool activity that completed normally — committable, same as
 *     codex's completed-tool turn).
 *   - exit 0, tool frames absent but off-protocol non-JSON stdout was seen
 *     (and no tool frames) → `"unknown"` (the stream was polluted in a way we
 *     cannot classify → discard, matching codex's crash-into-unknown path).
 *   - tool activity seen then the turn ended abnormally (non-zero exit,
 *     timeout, crash, cancel) → `"unknown"`.
 * The DISCUSSION_CONTRACT (cwd + empty `--skills-dir` + first-turn contract
 * text) keeps the discussion-shaped turn on the clean `"none"` path; if the
 * model elects to use a tool, the terminal honestly reports `"completed"`.
 *
 * No in-place retry: a resume-miss (exit≠0, stderr `Session … not found`)
 * bumps sessionEpoch and surfaces a retryable `not_dispatched` failure so the
 * upstream Round pauses and the next turn cold-rebases; the driver never
 * silently re-sends an incremental prompt into a fresh session.
 */

const DISCUSSION_CONTRACT = [
  "You are one Participant in a structured CouncilKit discussion.",
  "Stay in the persona given above and answer only the final instruction.",
  "Do not use tools; plain reasoned text is the whole deliverable.",
].join(" ");

const ENV_INHERIT = [
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
] as const;

/** Closed, verified coding-plan K3 catalog. */
const CATALOG = ["kimi-code/k3"] as const;
const CANONICAL_MODEL_ID = "kimi-code/k3";
const CONTEXT_WINDOW_TOKENS = 1_048_576;

/**
 * Conservative prompt-argv size guard (D2 E2BIG). macOS ARG_MAX ≈ 1MB; 200KB
 * is well under it and far beyond any legitimate discussion turn, so an
 * oversized prompt fails structurally before spawn instead of E2BIG-crashing.
 */
const PROMPT_MAX_BYTES = 200 * 1024;

/** Empty skills directory isolates the turn from user/project skills (D2). */
const SKILLS_DIR_NAME = "skills-empty";

/**
 * Bounded grace (F2/G1) the driver waits for stdout tail frames after the
 * process exit event but before the stdout pipe reports `end`. A Node child can
 * emit `exit` before its stdio pipes close; on a healthy fast-exit turn the
 * stdout pipe closes within a few ms and the turn settles from the full frames.
 * If the grace elapses WITHOUT stdout draining, the protocol stream is provably
 * incomplete (late tool_calls / role:"tool" / resume_hint / off-protocol lines
 * may still be in flight), so the turn is settled as an unknown interrupted
 * terminal rather than risk an erroneous clean completion (G1, D8). 1.5s is a
 * generous ceiling that still bounds the total settle latency.
 */
const EXIT_DRAIN_GRACE_MS = 1500;

/**
 * Bounded grace (H5) the driver waits for the stderr pipe to report `end`
 * after the process exit AND the stdout drain, before classifying a non-zero
 * exit. stderr is an independent pipe: the resume-miss text (`Session … not
 * found`) can land AFTER stdout EOF, and classifying from a partially-filled
 * ring would misreport a resume-miss (retryable not_dispatched) as a generic
 * DRIVER_CRASH, losing the automatic cold-rebase retry. This wait runs once,
 * only on the non-zero-exit path, and is timed separately from the stdout
 * drain grace above.
 */
const STDERR_DRAIN_GRACE_MS = 500;

type DriverState = "cold" | "ready" | "busy" | "closing" | "closed";

interface ActiveTurn {
  executionId: string;
  modelId: string;
  emit: Emit;
  coldStart: boolean;
  /** True once an authoritative assistant frame with non-empty content arrived. */
  sawAssistant: boolean;
  /**
   * Captured authoritative output. The LAST assistant frame carrying a
   * non-empty string `content` wins (E10: an assistant frame may carry only
   * `tool_calls`; a later assistant frame carries the final text). A
   * tool-call-only frame is tool activity, NOT output.
   */
  output: string;
  /** Resume hint captured this turn (null until the meta frame arrives). */
  resumeHint: string | null;
  /** True when any tool activity was observed (tool_calls / role:"tool"). */
  sawToolActivity: boolean;
  /** True when a non-JSON stdout line leaked onto the stream (E10). */
  sawOffProtocol: boolean;
  dispatchState: "not_dispatched" | "accepted" | "unknown";
  cancelling: boolean;
  settled: boolean;
  turnTimer?: NodeJS.Timeout;
  resolve(): void;
}

export function createKimiStreamJsonDriver(
  deps: DriverDeps,
): (participantId: string) => ParticipantDriver {
  const { supervisor, logger, timeouts, workRoot } = deps;

  return (participantId: string): ParticipantDriver => {
    let state: DriverState = "cold";
    let sessionEpoch = 0;
    /** Participant-level session ID for `-S` resume (null = cold start). */
    let sessionId: string | null = null;
    let activeTurn: ActiveTurn | null = null;
    let skillsDir = "";
    let persona: string | null = null;

    function diagnostic(kind: string, message: string, context?: Record<string, unknown>) {
      logger.diagnostic(`kimi.${kind}`, message, { participantId, ...context });
    }

    /**
     * Lifecycle check behind a function boundary: TypeScript's control-flow
     * narrowing does not invalidate `state` across `await`s, so inline
     * `state === "closing"` comparisons after an earlier narrowing check in
     * the same function would fail typecheck even though close() CAN flip the
     * state concurrently. The indirection keeps every check honest.
     */
    function isClosingOrClosed(): boolean {
      return state === "closing" || state === "closed";
    }

    async function ensureLayout(): Promise<void> {
      // Create the participant cwd and an empty skills dir under it once. The
      // driver layer owns the mkdir to mirror the claude/codex drivers and keep
      // the supervisor's cwd-existence check satisfied.
      await mkdir(join(workRoot, participantId), { recursive: true });
      skillsDir = join(workRoot, participantId, SKILLS_DIR_NAME);
      await mkdir(skillsDir, { recursive: true });
    }

    function clearTurnTimers(turn: ActiveTurn) {
      if (turn.turnTimer) clearTimeout(turn.turnTimer);
    }

    function emitTerminal(turn: ActiveTurn, event: DriverEvent) {
      clearTurnTimers(turn);
      if (activeTurn === turn) activeTurn = null;
      turn.settled = true;
      turn.emit(event);
      turn.resolve();
    }

    function failTurn(
      turn: ActiveTurn,
      error: ReturnType<typeof makeError>,
      toolState: ToolState = "unknown",
    ) {
      emitTerminal(turn, {
        type: "failed",
        error,
        dispatchState: turn.dispatchState,
        toolState,
        retryable: error.retryable,
      });
    }

    function interruptTurn(
      turn: ActiveTurn,
      reason: "user_cancelled" | "driver_crash" | "timeout" | "unknown",
      toolState: ToolState = "unknown",
    ) {
      emitTerminal(turn, {
        type: "interrupted",
        reason,
        dispatchState: turn.dispatchState,
        toolState,
      });
    }

    /**
     * Drop the in-memory session and bump the generation: the CLI's externally
     * persisted session can no longer be trusted as a strict append-only
     * continuation, so the reconciler cold-rebases on the next turn. The CLI's
     * own session files (under ~/.kimi-code) are never touched.
     */
    function invalidateSession(reason: string) {
      if (sessionId !== null) diagnostic("session_invalidated", reason, {});
      sessionId = null;
      sessionEpoch += 1;
    }

    let activeProcess: DriverProcess | null = null;
    /**
     * F4: the in-flight spawnDriver promise. cancel()/close() cover and await this
     * so a process that spawns after the turn was settled/driver closed is either
     * awaited-to-shutdown (still pending) or no-ops (already resolved). Null when
     * no spawn is outstanding.
     */
    let pendingSpawn: Promise<DriverProcess> | null = null;
    /**
     * F5: the in-flight provider-list probe process, tracked so close() reaps it
     * (it is NOT the per-turn activeProcess, so close() would otherwise miss it).
     * Null when no probe is outstanding.
     */
    let activeProbe: DriverProcess | null = null;
    /**
     * G2: the in-flight probe SPAWN promise, registered BEFORE the
     * `await supervisor.spawnDriver(...)` so close() covers that window too —
     * otherwise close() can return while a probe spawn is still pending and the
     * late probe process would be adopted (and could resurrect `ready`) after
     * the driver was closed. Null when no probe spawn is outstanding.
     */
    let pendingProbe: Promise<DriverProcess> | null = null;

    async function reapActiveProcess(reason: string): Promise<void> {
      const proc = activeProcess;
      activeProcess = null;
      if (proc) {
        await proc.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
      }
      void reason;
    }

    function onFrame(turn: ActiveTurn, message: Record<string, unknown>) {
      if (turn.settled) return;
      const role = typeof message.role === "string" ? message.role : "";
      if (role === "assistant") {
        // A tooled turn emits assistant frames carrying only `tool_calls`
        // (E10); a later assistant frame carries the final text `content`.
        // The LAST assistant frame with a NON-EMPTY string content is the
        // authoritative output; a tool-called-only frame is tool activity,
        // not output, and is never treated as the deliverable.
        const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        if (hasToolCalls) {
          turn.sawToolActivity = true;
        }
        const content = typeof message.content === "string" ? message.content : "";
        if (content.length > 0) {
          turn.output = content;
          turn.sawAssistant = true;
          // Bytes were provably accepted and answered by the model.
          turn.dispatchState = "accepted";
        }
        return;
      }
      if (role === "tool") {
        // role:"tool" frames carry tool result stdout (E10): provable tool
        // activity. They are NEVER output candidates.
        turn.sawToolActivity = true;
        return;
      }
      if (role === "meta") {
        const type = typeof message.type === "string" ? message.type : "";
        if (type === "session.resume_hint") {
          const sid = typeof message.session_id === "string" ? message.session_id : "";
          if (sid.length > 0) {
            turn.resumeHint = sid;
          }
          return;
        }
        // Open set: unknown meta types are ignored.
        diagnostic("unknown_meta", `ignored meta type=${type}`);
        return;
      }
      // Open set: unknown roles are ignored (never fatal).
      diagnostic("unknown_role", `ignored role=${role || "(none)"}`);
    }

    /**
     * Record a non-JSON stdout line (E10: tool raw stdout leaks as bare lines on
     * a tooled turn). It is off-protocol evidence — it does not fail the turn,
     * but it affects the terminal toolState mapping (F1/F6).
     */
    function noteOffProtocolLine(turn: ActiveTurn, line: string) {
      if (turn.settled) return;
      turn.sawOffProtocol = true;
      diagnostic("off_protocol_line", "non-JSON stdout line observed", {
        len: sanitizeString(line, 64),
      });
    }

    /**
     * Map the terminal toolState for a turn that completed with exit 0 and a
     * non-empty assistant frame (the success path). Per D7 / ADR-0012 (E10):
     *   - tool activity present (assistant.tool_calls / role:"tool") → "completed"
     *   - no tool activity, no off-protocol non-JSON lines → "none" (a clean
     *     discussion-shaped turn)
     *   - no tool activity but off-protocol non-JSON lines leaked → "unknown"
     *     (the stream was polluted in an unclassifiable way → discard path)
     * classifyCompleted commits both "none" and "completed"; only "unknown" is
     * discarded (commit-execution.ts:64-81).
     */
    function completedToolState(turn: ActiveTurn): ToolState {
      if (turn.sawToolActivity) return "completed";
      if (turn.sawOffProtocol) return "unknown";
      return "none";
    }

    function settleOnExit(turn: ActiveTurn, code: number | null, stderrText: string) {
      if (turn.settled) return;
      clearTurnTimers(turn);
      if (turn.cancelling) {
        // cancel() asked the process group to die; the exit confirms teardown.
        // The terminal is the user_cancelled interrupt (not the exit code),
        // and the session's reliable continuity ends here.
        activeTurn = null;
        invalidateSession("user_cancelled");
        emitTerminal(turn, {
          type: "interrupted",
          reason: "user_cancelled",
          dispatchState: turn.dispatchState,
          toolState: "unknown",
        });
        return;
      }
      if (code !== 0) {
        // resume-miss: the CLI cannot find the session it was told to resume.
        // Surface a retryable not_dispatched failure and invalidate the session
        // so the next turn cold-rebases; never re-send the incremental prompt.
        const lower = stderrText.toLowerCase();
        if (turn.coldStart === false && lower.includes("session") && lower.includes("not found")) {
          invalidateSession("resume_miss");
          emitTerminal(turn, {
            type: "failed",
            error: makeError(
              "DRIVER_CRASH",
              "stream",
              "Kimi session resume miss: the session is no longer resumable.",
              {
                driverId: "kimi-stream-json",
                executionId: turn.executionId,
                participantId,
                retryable: true,
              },
            ),
            dispatchState: "not_dispatched",
            toolState: "unknown",
            retryable: true,
          });
          return;
        }
        // Any other non-zero exit: the tooled agent process crashed.
        invalidateSession("nonzero_exit");
        failTurn(
          turn,
          makeError("DRIVER_CRASH", "stream", `kimi exited with code ${code ?? "null"}.`, {
            driverId: "kimi-stream-json",
            executionId: turn.executionId,
            participantId,
          }),
        );
        return;
      }
      // exit 0: settle by the captured frames.
      if (!turn.sawAssistant || turn.output.trim().length === 0) {
        invalidateSession("empty_output");
        failTurn(
          turn,
          makeError("EMPTY_OUTPUT", "stream", "Completed with empty normalized output.", {
            driverId: "kimi-stream-json",
            executionId: turn.executionId,
            participantId,
          }),
        );
        return;
      }
      // First turn must capture a usable resume hint; without it the Per-turn
      // resume model cannot work — treat as an incompatible protocol.
      if (turn.coldStart && (!turn.resumeHint || turn.resumeHint.length === 0)) {
        invalidateSession("missing_resume_hint");
        failTurn(
          turn,
          makeError(
            "INCOMPATIBLE_DRIVER",
            "stream",
            "First turn produced no session.resume_hint; per-turn resume is unavailable.",
            {
              driverId: "kimi-stream-json",
              executionId: turn.executionId,
              participantId,
            },
          ),
        );
        return;
      }
      // Adopt the hint as the participant's session (resume turn: it must match
      // the prior id; a divergence is a protocol break — invalidate + fail).
      if (turn.resumeHint) {
        if (turn.coldStart) {
          sessionId = turn.resumeHint;
        } else if (sessionId !== null && turn.resumeHint !== sessionId) {
          diagnostic("session_diverged", "resume hint differs from the held session id", {});
          invalidateSession("resume_hint_diverged");
          failTurn(
            turn,
            makeError(
              "INCOMPATIBLE_DRIVER",
              "stream",
              "Kimi returned a different session id on resume.",
              {
                driverId: "kimi-stream-json",
                executionId: turn.executionId,
                participantId,
              },
            ),
          );
          return;
        } else {
          sessionId = turn.resumeHint;
        }
      }
      // success: no generation bump (the Execution Session continuity holds).
      // toolState is mapped from the protocol evidence collected this turn
      // (F1, D7, ADR-0012/E10): none / completed / unknown.
      emitTerminal(turn, {
        type: "completed",
        output: turn.output,
        requestedModel: turn.modelId,
        // No effective-model echo in the protocol: the Host pinned the model
        // via an exact `-m` alias. ADR-0012 records this as CLI-alias evidence,
        // not a claim that no provider-side reroute exists.
        effectiveModel: turn.modelId,
        modelVerdict: "match",
        toolState: completedToolState(turn),
        dispatchState: "accepted",
        usage: null,
        finalSeq: 0, // registry re-stamps
      } as DriverEvent);
    }

    function buildArgv(input: ExecuteInput, renderedPrompt: string): string[] {
      const argv: string[] = [];
      if (!input.coldStart && sessionId) {
        argv.push("-S", sessionId);
      }
      argv.push("-m", input.modelId, "-p", renderedPrompt);
      argv.push("--output-format", "stream-json");
      argv.push("--skills-dir", skillsDir);
      return argv;
    }

    async function runTurn(input: ExecuteInput, emit: Emit): Promise<void> {
      // execute() guards on heldInstallation before calling runTurn; capture a
      // narrowed local for the spawn (TS cannot narrow across the closure).
      const installation = heldInstallation;
      if (!installation?.realpath) {
        emit({
          type: "failed",
          error: makeError(
            "DRIVER_CRASH",
            "dispatch",
            "kimi driver has no validated installation realpath",
            {
              driverId: "kimi-stream-json",
              executionId: input.executionId,
              participantId,
              retryable: true,
            },
          ),
          dispatchState: "not_dispatched",
          toolState: "unknown",
          retryable: true,
        });
        return;
      }
      // persona + DISCUSSION_CONTRACT prefix the FIRST turn only; a resume
      // turn sends just the reconciler-rendered incremental prompt. Kimi has
      // no --system-prompt flag, so the contract rides on the -p text.
      const renderedPrompt =
        input.coldStart && persona
          ? `${persona}\n\n${DISCUSSION_CONTRACT}\n\n${input.prompt}`
          : input.coldStart
            ? `${DISCUSSION_CONTRACT}\n\n${input.prompt}`
            : input.prompt;

      // E2BIG guard: fail structurally before spawn (D2).
      const promptBytes = Buffer.byteLength(renderedPrompt, "utf8");
      if (promptBytes > PROMPT_MAX_BYTES) {
        emit({
          type: "failed",
          error: makeError(
            "PROTOCOL_LIMIT",
            "dispatch",
            `Prompt is ${promptBytes} bytes; the kimi -p argv limit is ${PROMPT_MAX_BYTES} bytes.`,
            {
              driverId: "kimi-stream-json",
              executionId: input.executionId,
              participantId,
            },
          ),
          dispatchState: "not_dispatched",
          toolState: "unknown",
          retryable: false,
        });
        return;
      }

      state = "busy";
      emit({ type: "started", requestedModel: input.modelId } as DriverEvent);

      await new Promise<void>((resolvePromise) => {
        const turn: ActiveTurn = {
          executionId: input.executionId,
          modelId: input.modelId,
          emit,
          coldStart: input.coldStart,
          sawAssistant: false,
          output: "",
          resumeHint: null,
          sawToolActivity: false,
          sawOffProtocol: false,
          dispatchState: "not_dispatched",
          cancelling: false,
          settled: false,
          resolve: resolvePromise,
        };
        activeTurn = turn;

        const argv = buildArgv(input, renderedPrompt);
        const cwd = join(workRoot, participantId);
        const stderrRing = createBoundedRing(LIMITS.stderrRingBytes);
        const executable = installation.realpath;

        // F2: a Node child's `exit` event can fire BEFORE its stdio pipes
        // close, and the watchdog control channel + the forwarded stdout are
        // independent pipes. Track both processExit and stdoutEnded and only
        // settle once both are observed (with a bounded grace when exit lands
        // first), so late stdout tail frames (assistant / resume_hint) are not
        // dropped into an EMPTY_OUTPUT or resume-miss misclassification. stderr
        // is best-effort; its resume-miss text is read at settle from whatever
        // the bounded ring has captured.
        const drain = {
          processExit: false as boolean,
          exitCode: null as number | null,
          stdoutEnded: false as boolean,
          stderrEnded: false as boolean,
          settled: false as boolean,
          graceTimer: undefined as NodeJS.Timeout | undefined,
          stderrGraceTimer: undefined as NodeJS.Timeout | undefined,
        };
        // H2: this turn's spawned handle. The exit handler clears the shared
        // activeProcess as soon as the exit lands, but stdout may still be
        // draining — the handle must survive until the drain settles so the
        // drain-timeout grace (and the NDJSON limit path) can reap the process
        // group directly instead of calling a reap that finds nothing.
        let turnProcess: DriverProcess | null = null;

        function finishSettle(): void {
          if (drain.settled || turn.settled) return;
          drain.settled = true;
          if (drain.graceTimer) {
            clearTimeout(drain.graceTimer);
            drain.graceTimer = undefined;
          }
          if (drain.stderrGraceTimer) {
            clearTimeout(drain.stderrGraceTimer);
            drain.stderrGraceTimer = undefined;
          }
          // The process already exited; nothing is left to reap through it.
          turnProcess = null;
          if (activeTurn === turn) settleOnExit(turn, drain.exitCode, stderrRing.text());
        }

        function trySettle(reason: "exit" | "drained" | "stderr"): void {
          if (drain.settled || turn.settled) return;
          if (!drain.processExit) return;
          void reason;
          // stdout may lag the exit event; if it is still draining, arm a
          // bounded grace once (exit-first) and settle when the drain path runs.
          if (!drain.stdoutEnded) {
            if (!drain.graceTimer) {
              drain.graceTimer = setTimeout(() => {
                // Grace elapsed but the stdout pipe STILL has not drained. The
                // protocol stream is incomplete (G1, D8): tail frames —
                // assistant content, resume_hint, tool_calls, role:"tool", or
                // off-protocol non-JSON lines — may still be in flight, and we
                // can no longer prove the terminal toolState from partial
                // evidence. Do NOT take the normal completed-completion path
                // (which would risk an erroneous toolState=none that the commit
                // pipeline admits): settle as an unknown interrupted terminal,
                // invalidate the session, and reap the process group so a
                // late frame can never land into a settled turn.
                drain.graceTimer = undefined;
                if (!drain.settled && !turn.settled && activeTurn === turn) {
                  drain.settled = true;
                  clearTurnTimers(turn);
                  activeTurn = null;
                  invalidateSession("stream_drain_timeout");
                  emitTerminal(turn, {
                    type: "failed",
                    error: makeError(
                      "STREAM_DRAIN_TIMEOUT",
                      "stream",
                      "Process exited but stdout did not drain within the grace window; tail frames may have been lost.",
                      {
                        driverId: "kimi-stream-json",
                        executionId: turn.executionId,
                        participantId,
                        retryable: true,
                      },
                    ),
                    dispatchState: turn.dispatchState,
                    toolState: "unknown",
                    retryable: true,
                  });
                  // H2: the exit handler already cleared activeProcess, so
                  // reapActiveProcess would find nothing here. Shut down the
                  // handle this turn still holds — the wedged watchdog, its
                  // Host pipes and the supervisor record must not linger until
                  // a global shutdown (close() has already lost this handle).
                  const proc = turnProcess;
                  turnProcess = null;
                  if (proc) {
                    void proc.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
                  }
                }
              }, EXIT_DRAIN_GRACE_MS);
              drain.graceTimer.unref();
            }
            return;
          }
          // H5: on a NON-zero exit the stderr tail (the resume-miss text) can
          // still be in flight on its independent pipe even after stdout
          // drained. Wait a bounded grace for stderr `end` before classifying,
          // so a late `Session … not found` is not misread as a generic
          // DRIVER_CRASH. Skipped for cancels (teardown is already requested)
          // and for exit 0 (the classification does not consult stderr).
          if (drain.exitCode !== 0 && !turn.cancelling && !drain.stderrEnded) {
            if (!drain.stderrGraceTimer) {
              drain.stderrGraceTimer = setTimeout(() => {
                drain.stderrGraceTimer = undefined;
                diagnostic(
                  "stderr_drain_timeout",
                  "stderr did not end within the grace; classifying the non-zero exit from the captured ring",
                  {},
                );
                finishSettle();
              }, STDERR_DRAIN_GRACE_MS);
              drain.stderrGraceTimer.unref();
            }
            return;
          }
          finishSettle();
        }

        // F4: track the in-flight spawn so cancel()/close() can cover and wait
        // for it; the spawned process is rejected (immediately shut down) if the
        // turn was already settled or the driver is closing/closed by the time
        // the spawn resolves.
        const spawnPromise = supervisor.spawnDriver({
          participantId,
          executable,
          argv,
          cwd,
          envInherit: ENV_INHERIT,
          envSet: {},
        });
        pendingSpawn = spawnPromise;

        spawnPromise
          .then((spawned) => {
            pendingSpawn = null;
            // F4 race window: if cancel()/close() settled the turn or closed the
            // driver while the spawn was pending, never adopt this process — kill
            // it immediately and install no timers / no feeders.
            if (state === "closing" || state === "closed" || turn.settled || activeTurn !== turn) {
              void spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
              return;
            }
            activeProcess = spawned;
            turnProcess = spawned;
            spawned.stderr.on("data", (chunk: Buffer) => stderrRing.append(chunk.toString("utf8")));
            spawned.stderr.on("end", () => {
              // H5: stderr drained — a pending non-zero-exit classification
              // can now read the complete resume-miss evidence from the ring.
              drain.stderrEnded = true;
              trySettle("stderr");
            });
            attachNdjsonSplitter(spawned.stdout, {
              onLine(line) {
                let message: Record<string, unknown>;
                try {
                  message = JSON.parse(line) as Record<string, unknown>;
                } catch {
                  // F6/D7 (E10): a non-JSON line is tool raw stdout leaking onto
                  // the stream — off-protocol evidence that affects the terminal
                  // toolState, NOT a silent ignore.
                  if (activeTurn === turn) noteOffProtocolLine(turn, line);
                  return;
                }
                if (activeTurn === turn) onFrame(turn, message);
              },
              onLimitExceeded() {
                if (activeTurn === turn && !turn.settled) {
                  // H1: the splitter stops parsing permanently after the limit
                  // trip (no further onLine/onEnd), so this turn can never
                  // settle from frames — and the CLI process may keep running
                  // (even executing tools) after the Host emits the terminal,
                  // with the prompt possibly already persisted into the resume
                  // session. Invalidate the session FIRST (synchronously, so
                  // the next turn cold-rebases instead of resuming a poisoned
                  // session), fail the turn, then reap the process group via
                  // the handle this turn holds.
                  invalidateSession("protocol_limit");
                  failTurn(
                    turn,
                    makeError("PROTOCOL_LIMIT", "stream", "NDJSON line exceeded the 8 MiB limit.", {
                      driverId: "kimi-stream-json",
                      executionId: turn.executionId,
                      participantId,
                    }),
                  );
                  const proc = turnProcess ?? spawned;
                  turnProcess = null;
                  if (activeProcess === proc) activeProcess = null;
                  void proc.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
                }
              },
              onEnd() {
                // stdout drained: attempt to settle if the exit already happened.
                drain.stdoutEnded = true;
                trySettle("drained");
              },
            });
            spawned.events.once("exit", ({ code }: { code: number | null }) => {
              activeProcess = null;
              drain.processExit = true;
              drain.exitCode = code;
              trySettle("exit");
              if (state === "busy") state = "ready";
            });
            // Wait for watchdog supervision; a fast healthy turn may already be
            // exiting (per-turn fast-exit race, D2): the exit handler above
            // settles regardless, and waitSupervised rejecting on a pre-supervision
            // exit is tolerated rather than treated as a spawn failure.
            spawned.waitSupervised(timeouts.handshakeMs).catch((error: unknown) => {
              // The turn may have already settled via the exit path (fast-exit
              // race). Only fail if still outstanding.
              if (activeTurn === turn && !turn.settled) {
                const msg = error instanceof Error ? error.message : "supervised spawn failed";
                invalidateSession("spawn_failed");
                failTurn(
                  turn,
                  makeError("DRIVER_SPAWN_FAILED", "prewarm", msg, {
                    driverId: "kimi-stream-json",
                    executionId: turn.executionId,
                    participantId,
                    retryable: true,
                  }),
                );
              }
            });
            // Bytes left the Host into the CLI's argv; acceptance is unknown
            // until the assistant frame arrives.
            if (turn.dispatchState === "not_dispatched") turn.dispatchState = "unknown";

            // Turn timer (armed after spawn so a never-supervised spawn
            // still times out rather than hanging the execute promise). The
            // kimi protocol is final-only — it emits NO frames during
            // generation, so the streaming-style per-frame idle watchdog
            // (streamIdleMs) does not apply here; the turnMs absolute timer
            // is the only turn bound.
            turn.turnTimer = setTimeout(() => {
              // CK-RS-002: a turnMs armed after a pending spawn (or a callback
              // already queued on the event loop) must NOT preempt an in-flight
              // cancel()/close() — both set turn.cancelling, which owns the
              // user_cancelled terminal.
              if (activeTurn === turn && !turn.settled && !turn.cancelling) {
                // F3: synchronously invalidate the session BEFORE the terminal so
                // the next turn cold-rebases — the timed-out process may have
                // already accepted/persisted an unknown incremental prompt.
                invalidateSession("turn_timeout");
                interruptTurn(turn, "timeout");
                void reapActiveProcess("turn_timeout");
              }
            }, timeouts.turnMs);
          })
          .catch((error: unknown) => {
            pendingSpawn = null;
            if (activeTurn === turn && !turn.settled) {
              const msg = error instanceof Error ? error.message : "spawn failed";
              invalidateSession("spawn_threw");
              failTurn(
                turn,
                makeError("DRIVER_SPAWN_FAILED", "dispatch", msg, {
                  driverId: "kimi-stream-json",
                  executionId: turn.executionId,
                  participantId,
                  retryable: true,
                }),
              );
            }
            if (state === "busy") state = "ready";
          });
      });
    }

    let heldInstallation: PrewarmInput["installation"] | null = null;

    return {
      participantId,
      driverId: "kimi-stream-json",
      get sessionEpoch() {
        return sessionEpoch;
      },

      async prewarm(input: PrewarmInput): Promise<PrewarmResult> {
        if (input.spec.profile.driverId !== "kimi-stream-json") {
          throw Object.assign(new Error("profile driver mismatch"), {
            runtimeCode: "PROFILE_INVALID",
          });
        }
        heldInstallation = input.installation;
        if (!input.installation.realpath) {
          throw Object.assign(new Error("installation has no validated realpath"), {
            runtimeCode: "INSTALLATION_INVALID",
          });
        }
        persona = input.spec.personaPrompt ?? null;
        await ensureLayout();
        // H3: close() may have completed while ensureLayout yielded — never
        // proceed (towards the probe spawn) on a closing/closed driver. H4:
        // CANCELLED is the lifecycle label; a close-triggered failure must not
        // be misreported as AUTH_REQUIRED (which poisons readiness/diagnostics).
        if (isClosingOrClosed()) {
          throw Object.assign(new Error("kimi driver closed during prewarm"), {
            runtimeCode: "CANCELLED",
          });
        }

        // Closed-set model validation: the probe's placeholder model
        // (`__catalog__`) and any out-of-set Agent modelId both surface
        // MODEL_UNAVAILABLE carrying the served catalog — exactly the data the
        // choose-model repair path needs (same shape as codex).
        if (input.spec.modelId !== CANONICAL_MODEL_ID) {
          throw Object.assign(new Error(`model ${input.spec.modelId} is not in the kimi catalog`), {
            runtimeCode: "MODEL_UNAVAILABLE",
            catalog: [...CATALOG],
          });
        }

        // Prewarm probe: a short-lived `kimi provider list` (text) proving the
        // OAuth provider is configured and the default model is K3. It makes NO
        // model call. `provider list --json` is deliberately avoided: its
        // provider nodes carry OAuth/API-key fields that must not enter the Host
        // process. The text probe is diagnostic only; the parsed default line
        // is recorded, but execution always passes an explicit -m.
        const probeOk = await runProviderProbe(input.installation.realpath).catch((error) => {
          const msg = error instanceof Error ? error.message : "provider list failed";
          const runtimeCode =
            error instanceof Error ? (error as { runtimeCode?: string }).runtimeCode : undefined;
          // H4: preserve the lifecycle label — a failure caused by close()
          // (CANCELLED) must not be remapped to AUTH_REQUIRED.
          const code =
            runtimeCode === "HANDSHAKE_TIMEOUT"
              ? "HANDSHAKE_TIMEOUT"
              : runtimeCode === "CANCELLED"
                ? "CANCELLED"
                : "AUTH_REQUIRED";
          throw Object.assign(new Error(`kimi provider probe failed: ${msg}`), {
            runtimeCode: code,
          });
        });
        // The parsed default line is diagnostic only (recorded inside the
        // probe); execution always pins `-m kimi-code/k3`. No secret fields.
        void probeOk;
        // G2: a concurrent close() during the probe is terminal — never
        // resurrect `ready` on a closing/closed driver. H4: lifecycle label.
        if (isClosingOrClosed()) {
          throw Object.assign(new Error("kimi driver closed during prewarm"), {
            runtimeCode: "CANCELLED",
          });
        }
        state = "ready";

        return {
          canonicalModelId: CANONICAL_MODEL_ID,
          modelAliases: [],
          capability: {
            protocol: "kimi-stream-json",
            credentialMode: "installation-managed",
            providerProbe: "provider-list",
            sessionResume: true,
            outputMode: "final-only",
            modelSelection: "exact-cli-alias",
          },
          catalog: [...CATALOG],
        };
      },

      async execute(input: ExecuteInput, emit: Emit): Promise<void> {
        if (activeTurn) {
          throw Object.assign(new Error("participant busy"), { runtimeCode: "PARTICIPANT_BUSY" });
        }
        if (state === "closed") {
          // Post-close: never respawn (kimi policy). Surface one retryable
          // not_dispatched terminal so the Round pauses.
          emit({
            type: "failed",
            error: makeError("DRIVER_CRASH", "dispatch", "kimi driver is closed", {
              driverId: "kimi-stream-json",
              executionId: input.executionId,
              participantId,
              retryable: true,
            }),
            dispatchState: "not_dispatched",
            toolState: "unknown",
            retryable: true,
          });
          return;
        }
        if (!heldInstallation) {
          emit({
            type: "failed",
            error: makeError(
              "DRIVER_CRASH",
              "dispatch",
              "kimi driver has no held installation; prewarm required",
              {
                driverId: "kimi-stream-json",
                executionId: input.executionId,
                participantId,
                retryable: true,
              },
            ),
            dispatchState: "not_dispatched",
            toolState: "unknown",
            retryable: true,
          });
          return;
        }
        await runTurn(input, emit);
      },

      async cancel(executionId: string): Promise<void> {
        const turn = activeTurn;
        if (!turn || turn.executionId !== executionId) return;
        turn.cancelling = true;
        // CK-RS-002: clear the turnMs timer before awaiting the spawn / sending
        // SIGTERM, so a slow-exiting process cannot let the absolute turn timer
        // fire inside the cancel window and steal user_cancelled with a timeout.
        clearTurnTimers(turn);
        // F4: cover the pending-spawn window. Await the spawn promise so a
        // process that resolves while/after cancel runs is driven through the
        // normal cancel teardown below (SIGTERM → exit → user_cancelled
        // terminal) rather than spawned-and-left-running. A spawn that fails
        // resolves here and the catch-only path still hits the fallback.
        const pending = pendingSpawn;
        if (pending) {
          await pending.catch(() => undefined);
          pendingSpawn = null;
        }
        const proc = activeProcess;
        if (proc) {
          proc.kill("SIGTERM", timeouts.interruptGraceMs);
          // The watchdog escalates to SIGKILL after the grace window; wait for
          // the process exit. settleOnExit handles the user_cancelled terminal.
          const deadline = Date.now() + timeouts.interruptGraceMs + 1500;
          while (activeProcess === proc && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 30));
          }
          if (activeProcess === proc) {
            proc.kill("SIGKILL");
            // Wait a little longer for the exit handler to settle after SIGKILL.
            const killDeadline = Date.now() + timeouts.shutdownGraceMs + 500;
            while (activeProcess === proc && Date.now() < killDeadline) {
              await new Promise((r) => setTimeout(r, 30));
            }
          }
        }
        // Fallback: if no exit event ever settled the turn (e.g. the process
        // vanished before the watchdog reported an exit), emit the terminal
        // here so the execute promise never hangs.
        if (activeTurn === turn && !turn.settled) {
          invalidateSession("user_cancelled");
          interruptTurn(turn, "user_cancelled");
        }
      },

      async close(): Promise<void> {
        state = "closing";
        const turn = activeTurn;
        if (turn && !turn.settled) {
          turn.cancelling = true;
        }
        // F4: wait for any pending spawn to resolve so a process spawned-but-
        // not-yet-supervised is shut down rather than adopted/leaked after
        // close. The spawn-then handler sees state === "closing" and rejects.
        const pending = pendingSpawn;
        if (pending) {
          await pending
            .then((spawned) => spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined))
            .catch(() => undefined);
          pendingSpawn = null;
        }
        const proc = activeProcess;
        activeProcess = null;
        if (proc) {
          await proc.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        }
        // F5: reap the provider-list probe too — it is not the activeProcess,
        // so close() would otherwise leave a hung probe (and its watchdog/CLI
        // processes) behind.
        const probe = activeProbe;
        activeProbe = null;
        if (probe) {
          await probe.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        }
        // G2: cover a still-PENDING probe spawn — wait for it to resolve and
        // shut the late process down immediately, so close() never returns
        // while a probe is about to be adopted behind its back. (The probe's
        // own post-spawn closing/closed check is the second line of defense;
        // shutdown is idempotent, mirroring the F4 pending-spawn pattern.)
        const pendingProbeSpawn = pendingProbe;
        if (pendingProbeSpawn) {
          await pendingProbeSpawn
            .then((spawned) => spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined))
            .catch(() => undefined);
          pendingProbe = null;
        }
        activeTurn = null;
        invalidateSession("close");
        state = "closed";
      },

      capabilityState() {
        if (state === "ready" || state === "busy") return "ready";
        return "checking";
      },

      contextWindowTokens() {
        return CONTEXT_WINDOW_TOKENS;
      },
    };

    /**
     * Run `kimi provider list` (text) as a short-lived supervised probe and
     * parse the `Default model:` line. Returns null defaultModel if the line is
     * absent (the probe still proves OAuth config exists). Throws on non-zero
     * exit (auth/provider unavailable) or on a deadline over the whole command
     * life (F5: a hung OAuth-interactive probe must not block readiness/close
     * forever, and the probe handle is reaped by close()). Never parses or
     * returns secret fields.
     */
    async function runProviderProbe(executable: string): Promise<{
      defaultModel: string | null;
    }> {
      const cwd = join(workRoot, participantId);
      await mkdir(cwd, { recursive: true });
      // H3: the LAST lifecycle check before spawning — there must be no await
      // between this check and the pendingProbe registration below, so close()
      // can never return and then have a probe process spawn behind its back.
      // H4: CANCELLED is the lifecycle label, not AUTH_REQUIRED.
      if (isClosingOrClosed()) {
        throw Object.assign(new Error("kimi driver closed before the provider probe"), {
          runtimeCode: "CANCELLED",
        });
      }
      // G2: register the pending spawn BEFORE the await so close() can cover
      // the window; a probe that resolves after close() is shut down, never
      // adopted.
      const spawnPromise = supervisor.spawnDriver({
        participantId: `${participantId}-probe`,
        executable,
        argv: ["provider", "list"],
        cwd,
        envInherit: ENV_INHERIT,
        envSet: {},
      });
      pendingProbe = spawnPromise;
      let spawned: DriverProcess;
      try {
        spawned = await spawnPromise;
      } finally {
        if (pendingProbe === spawnPromise) pendingProbe = null;
      }
      // G2: close() ran while the probe spawn was pending. Never adopt the
      // process — shut it down and fail the probe instead of probing (and
      // potentially resurrecting `ready` on) a closing/closed driver.
      if (isClosingOrClosed()) {
        await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        throw Object.assign(new Error("kimi driver closed during the provider probe"), {
          runtimeCode: "CANCELLED", // H4: lifecycle label, not an auth failure
        });
      }
      activeProbe = spawned;
      let output = "";
      const ring = createBoundedRing(LIMITS.stderrRingBytes);
      spawned.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      spawned.stderr.on("data", (chunk: Buffer) => ring.append(chunk.toString("utf8")));
      // F5: an absolute deadline over the whole probe life reuses ndjson's
      // withDeadline. handshakeMs already bounds supervision; this bounds the
      // exit wait so a hung OAuth/interactive probe cannot block indefinitely.
      const PROBE_DEADLINE_MS = Math.max(timeouts.handshakeMs, 8000);
      const exited = new Promise<number | null>((resolvePromise) => {
        spawned.events.once("exit", ({ code }: { code: number | null }) => resolvePromise(code));
        // waitSupervised rejects on a pre-supervision exit; the exit listener
        // above resolves either way. A supervised-but-hung probe is caught by
        // the outer deadline.
        spawned.waitSupervised(timeouts.handshakeMs).catch(() => {
          /* handled by deadline / exit path */
        });
      });
      let exitCode: number | null;
      let timedOut = false;
      try {
        exitCode = await withDeadline(
          exited,
          PROBE_DEADLINE_MS,
          () => new Error("HANDSHAKE_TIMEOUT"),
        );
      } catch (error) {
        timedOut = true;
        exitCode = null;
        void error;
      }
      // F5: always reap the probe process on every path — shutdown before
      // surfacing the error so a timed-out/hung probe is never leaked.
      await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
      if (activeProbe === spawned) activeProbe = null;
      if (timedOut) {
        // Map an OAuth/interactive hang to HANDSHAKE_TIMEOUT (clean shutdown
        // already done). Distinguished from an AUTH_REQUIRED exit failure.
        throw Object.assign(new Error("kimi provider probe timed out (OAuth hang?)"), {
          runtimeCode: "HANDSHAKE_TIMEOUT",
        });
      }
      // H4: a close()-caused probe termination (creating-TTL sweep /
      // controller-close / host closeAll) SIGTERMs the in-flight probe, yielding
      // exitCode=null and landing here. It must be labelled CANCELLED, never
      // AUTH_REQUIRED, so teardown diagnostics/readiness are not poisoned with a
      // spurious auth failure. Mirrors the spawn-side guard (L1124-1129).
      if (isClosingOrClosed()) {
        throw Object.assign(new Error("kimi driver closed during the provider probe"), {
          runtimeCode: "CANCELLED", // H4: lifecycle label, not an auth failure
        });
      }
      if (exitCode !== 0) {
        throw Object.assign(new Error(`provider list exited with code ${exitCode ?? "null"}`), {
          runtimeCode: "AUTH_REQUIRED",
        });
      }
      const match = output.match(/Default model:\s*(\S+)/);
      const defaultModel = match ? (match[1] ?? null) : null;
      if (defaultModel && defaultModel !== CANONICAL_MODEL_ID) {
        diagnostic("default_model_drift", "kimi default model differs from the K3 closed set", {
          // sanitized diagnostic only; the model alias is not a secret.
          default: sanitizeString(defaultModel, 64),
        });
      }
      // The default line is diagnostic; execution always pins -m kimi-code/k3.
      return { defaultModel };
    }
  };
}
