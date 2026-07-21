import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import { sanitizeString } from "../logging";
import { type DriverProcess, createBoundedRing } from "../process/process-supervisor";
import { attachNdjsonSplitter } from "./ndjson";
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
 * Tool observability: `-p` mode makes kimi a tooled coding agent with no
 * zero-tools switch (E4); the protocol carries no tool telemetry. The driver
 * therefore reports the honest `toolState: "unknown"` — never a fabricated
 * "none" — and mitigates with a dedicated cwd, an empty `--skills-dir`, and a
 * DISCUSSION_CONTRACT instruction (D2 / ADR-0012).
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

type DriverState = "cold" | "ready" | "busy" | "closing" | "closed";

interface ActiveTurn {
  executionId: string;
  modelId: string;
  emit: Emit;
  coldStart: boolean;
  /** True once the authoritative assistant frame arrived. */
  sawAssistant: boolean;
  /** Captured authoritative output (final-only). */
  output: string;
  /** Resume hint captured this turn (null until the meta frame arrives). */
  resumeHint: string | null;
  dispatchState: "not_dispatched" | "accepted" | "unknown";
  cancelling: boolean;
  settled: boolean;
  idleTimer?: NodeJS.Timeout;
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

    async function ensureLayout(): Promise<void> {
      // Create the participant cwd and an empty skills dir under it once. The
      // driver layer owns the mkdir to mirror the claude/codex drivers and keep
      // the supervisor's cwd-existence check satisfied.
      await mkdir(join(workRoot, participantId), { recursive: true });
      skillsDir = join(workRoot, participantId, SKILLS_DIR_NAME);
      await mkdir(skillsDir, { recursive: true });
    }

    function clearTurnTimers(turn: ActiveTurn) {
      if (turn.idleTimer) clearTimeout(turn.idleTimer);
      if (turn.turnTimer) clearTimeout(turn.turnTimer);
    }

    function emitTerminal(turn: ActiveTurn, event: DriverEvent) {
      clearTurnTimers(turn);
      if (activeTurn === turn) activeTurn = null;
      turn.settled = true;
      turn.emit(event);
      turn.resolve();
    }

    function failTurn(turn: ActiveTurn, error: ReturnType<typeof makeError>) {
      emitTerminal(turn, {
        type: "failed",
        error,
        dispatchState: turn.dispatchState,
        toolState: "unknown",
        retryable: error.retryable,
      });
    }

    function interruptTurn(
      turn: ActiveTurn,
      reason: "user_cancelled" | "driver_crash" | "timeout" | "unknown",
    ) {
      emitTerminal(turn, {
        type: "interrupted",
        reason,
        dispatchState: turn.dispatchState,
        toolState: "unknown",
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

    function armIdleTimer(turn: ActiveTurn) {
      if (turn.idleTimer) clearTimeout(turn.idleTimer);
      turn.idleTimer = setTimeout(() => {
        failTurn(
          turn,
          makeError("STREAM_IDLE_TIMEOUT", "stream", "No protocol frames within the idle limit.", {
            driverId: "kimi-stream-json",
            executionId: turn.executionId,
            participantId,
          }),
        );
        // No process to kill yet here: the watchdog escalation is owned by the
        // turn timer + cancel path. The idle timer only fails the turn; the
        // spawn reap is handled below via the activeProcess shutdown.
        void reapActiveProcess("idle_timeout");
      }, timeouts.streamIdleMs);
    }

    let activeProcess: DriverProcess | null = null;

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
      armIdleTimer(turn); // any frame resets the idle window
      const role = typeof message.role === "string" ? message.role : "";
      if (role === "assistant") {
        const content = typeof message.content === "string" ? message.content : "";
        // final-only: the assistant frame IS the authoritative full output; no
        // deltas are emitted (the protocol has none).
        turn.output = content;
        turn.sawAssistant = true;
        // Bytes were provably accepted and answered by the model.
        turn.dispatchState = "accepted";
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
      emitTerminal(turn, {
        type: "completed",
        output: turn.output,
        requestedModel: turn.modelId,
        // No effective-model echo in the protocol: the Host pinned the model
        // via an exact `-m` alias. ADR-0012 records this as CLI-alias evidence,
        // not a claim that no provider-side reroute exists.
        effectiveModel: turn.modelId,
        modelVerdict: "match",
        toolState: "unknown",
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

        supervisor
          .spawnDriver({
            participantId,
            executable,
            argv,
            cwd,
            envInherit: ENV_INHERIT,
            envSet: {},
          })
          .then((spawned) => {
            activeProcess = spawned;
            spawned.stderr.on("data", (chunk: Buffer) => stderrRing.append(chunk.toString("utf8")));
            attachNdjsonSplitter(spawned.stdout, {
              onLine(line) {
                let message: Record<string, unknown>;
                try {
                  message = JSON.parse(line) as Record<string, unknown>;
                } catch {
                  diagnostic("bad_json", "non-JSON stdout line", {});
                  return;
                }
                if (activeTurn === turn) onFrame(turn, message);
              },
              onLimitExceeded() {
                if (activeTurn === turn && !turn.settled) {
                  failTurn(
                    turn,
                    makeError("PROTOCOL_LIMIT", "stream", "NDJSON line exceeded the 8 MiB limit.", {
                      driverId: "kimi-stream-json",
                      executionId: turn.executionId,
                      participantId,
                    }),
                  );
                }
              },
              onEnd() {
                // stdout closed: the process is exiting; the exit handler settles.
              },
            });
            spawned.events.once("exit", ({ code }: { code: number | null }) => {
              activeProcess = null;
              if (activeTurn === turn && !turn.settled) {
                settleOnExit(turn, code, stderrRing.text());
              }
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

            // Turn + idle timers (armed after spawn so a never-supervised spawn
            // still times out rather than hanging the execute promise).
            turn.turnTimer = setTimeout(() => {
              if (activeTurn === turn && !turn.settled) {
                interruptTurn(turn, "timeout");
                void reapActiveProcess("turn_timeout").then(() => {
                  invalidateSession("turn_timeout");
                });
              }
            }, timeouts.turnMs);
            armIdleTimer(turn);
          })
          .catch((error: unknown) => {
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
          throw Object.assign(new Error(`kimi provider probe failed: ${msg}`), {
            runtimeCode: "AUTH_REQUIRED",
          });
        });
        // The parsed default line is diagnostic only (recorded inside the
        // probe); execution always pins `-m kimi-code/k3`. No secret fields.
        void probeOk;
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
        const proc = activeProcess;
        activeProcess = null;
        if (proc) {
          await proc.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
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
     * exit (auth/provider unavailable). Never parses or returns secret fields.
     */
    async function runProviderProbe(executable: string): Promise<{
      defaultModel: string | null;
    }> {
      const cwd = join(workRoot, participantId);
      await mkdir(cwd, { recursive: true });
      const spawned = await supervisor.spawnDriver({
        participantId: `${participantId}-probe`,
        executable,
        argv: ["provider", "list"],
        cwd,
        envInherit: ENV_INHERIT,
        envSet: {},
      });
      let output = "";
      const ring = createBoundedRing(LIMITS.stderrRingBytes);
      spawned.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      spawned.stderr.on("data", (chunk: Buffer) => ring.append(chunk.toString("utf8")));
      const exitCode = await new Promise<number | null>((resolvePromise) => {
        spawned.events.once("exit", ({ code }: { code: number | null }) => resolvePromise(code));
        spawned.waitSupervised(timeouts.handshakeMs).catch(() => {
          // timeout: if the process is still alive, the exit handler will still
          // fire after the shutdown below; resolve via the exit path only.
        });
      }).catch(() => null);
      // Always reap the probe process; never leak a CLI process.
      await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
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
