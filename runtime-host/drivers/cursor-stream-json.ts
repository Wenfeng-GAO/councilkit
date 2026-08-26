import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@shared/runtime/contracts";
import type { ToolState } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import { sanitizeString } from "../logging";
import { type DriverProcess, createBoundedRing } from "../process/process-supervisor";
import { withDeadline } from "./ndjson";
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
 * `cursor-stream-json` Driver: one short-lived `cursor-agent --print`
 * process per turn. Prompt is stdin (measured 2026-08-26). Session
 * continuity uses `--resume <session_id>` from the previous turn's
 * `{"type":"result","session_id"}`.
 *
 * Catalog probe: `cursor-agent models`. First entry is `auto` (account
 * default). Requested `auto` / `default` / `configured` omit `--model`.
 *
 * Discussion turns use `--mode ask` (read-only). Credentials stay
 * installation-managed (`cursor-agent login` or CURSOR_API_KEY).
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
  "CURSOR_API_KEY",
  "CURSOR_API_ENDPOINT",
] as const;

export const CURSOR_FALLBACK_CATALOG = ["auto"] as const;
export const CURSOR_FALLBACK_CANONICAL = "auto";
const CONTEXT_WINDOW_TOKENS = 1_000_000;
const STDOUT_CAP = LIMITS.executionBufferBytes;
const EXIT_DRAIN_GRACE_MS = 1500;
const STDERR_DRAIN_GRACE_MS = 500;

type DriverState = "cold" | "ready" | "busy" | "closing" | "closed";

interface ActiveTurn {
  executionId: string;
  modelId: string;
  emit: Emit;
  coldStart: boolean;
  stdout: string;
  dispatchState: "not_dispatched" | "accepted" | "unknown";
  cancelling: boolean;
  settled: boolean;
  turnTimer?: NodeJS.Timeout;
  resolve: () => void;
}

export interface CursorJsonResult {
  text: string;
  sessionId: string | null;
  effectiveModel: string | null;
}

export function isCursorDefaultModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id === "auto" || id === "default" || id === "configured";
}

export function parseCursorModelsText(text: string): { catalog: string[]; canonical: string | null } {
  const catalog: string[] = [];
  let canonical: string | null = null;
  for (const line of text.split("\n")) {
    const item = /^([A-Za-z0-9][A-Za-z0-9._:+@-]*)\s+-\s+/.exec(line.trim());
    if (!item?.[1] || catalog.includes(item[1])) continue;
    catalog.push(item[1]);
    if (canonical === null && /\(default\)/i.test(line)) canonical = item[1];
  }
  if (canonical === null && catalog.includes("auto")) canonical = "auto";
  if (canonical && !catalog.includes(canonical)) catalog.unshift(canonical);
  return { catalog, canonical };
}

export function parseCursorJsonResult(stdout: string): CursorJsonResult | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  let last: CursorJsonResult | null = null;
  for (const line of trimmed.split("\n")) {
    const parsed = parseCursorResultObject(line.trim());
    if (parsed !== null) last = parsed;
  }
  if (last !== null) return last;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return parseCursorResultObject(trimmed.slice(start, end + 1));
}

function parseCursorResultObject(raw: string): CursorJsonResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== "result") return null;
  if (rec.subtype !== undefined && rec.subtype !== "success") return null;
  if (rec.is_error === true) return null;
  const text = typeof rec.result === "string" ? rec.result : "";
  const sessionId =
    typeof rec.session_id === "string" && rec.session_id.length > 0 ? rec.session_id : null;
  const effectiveModel = typeof rec.model === "string" && rec.model.length > 0 ? rec.model : null;
  return { text, sessionId, effectiveModel };
}

export function cursorModelVerdict(
  requested: string,
  effective: string | null,
): "match" | "mismatch" | "unknown" {
  if (isCursorDefaultModel(requested)) return "match";
  if (effective === null || effective.length === 0) return "unknown";
  if (effective === requested) return "match";
  return "mismatch";
}

function looksLikeAuthFailure(text: string): boolean {
  return /not logged in|please (?:run )?.*login|unauthoriz|AUTH_REQUIRED|api key/i.test(text);
}

export function createCursorStreamJsonDriver(deps: DriverDeps) {
  const { supervisor, logger, timeouts, workRoot } = deps;

  return (participantId: string): ParticipantDriver => {
    let state: DriverState = "cold";
    let sessionEpoch = 0;
    let sessionId: string | null = null;
    let persona: string | null = null;
    let catalog: string[] = [...CURSOR_FALLBACK_CATALOG];
    let canonical = CURSOR_FALLBACK_CANONICAL;
    let activeTurn: ActiveTurn | null = null;
    let activeProcess: DriverProcess | null = null;
    let pendingSpawn: Promise<DriverProcess> | null = null;
    let activeProbe: DriverProcess | null = null;
    let pendingProbe: Promise<DriverProcess> | null = null;
    let heldInstallation: PrewarmInput["installation"] | null = null;

    function diagnostic(event: string, message: string, extra: Record<string, unknown> = {}): void {
      logger.warn("cursor.driver", {
        event,
        message: sanitizeString(message),
        participantId,
        ...extra,
      });
    }

    function isClosingOrClosed(): boolean {
      return state === "closing" || state === "closed";
    }

    function clearTurnTimers(turn: ActiveTurn): void {
      if (turn.turnTimer) {
        clearTimeout(turn.turnTimer);
        turn.turnTimer = undefined;
      }
    }

    function invalidateSession(reason: string): void {
      if (sessionId !== null) diagnostic("session_invalidated", reason, {});
      sessionId = null;
      sessionEpoch += 1;
    }

    function emitTerminal(turn: ActiveTurn, event: DriverEvent): void {
      if (turn.settled) return;
      clearTurnTimers(turn);
      turn.settled = true;
      if (activeTurn === turn) activeTurn = null;
      if (state === "busy") state = "ready";
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

    async function reapActiveProcess(): Promise<void> {
      const proc = activeProcess;
      activeProcess = null;
      if (proc) await proc.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
    }

    async function ensureLayout(): Promise<string> {
      const cwd = join(workRoot, participantId);
      await mkdir(cwd, { recursive: true });
      return cwd;
    }

    function modelAllowed(modelId: string): boolean {
      if (isCursorDefaultModel(modelId)) return true;
      return catalog.includes(modelId);
    }

    async function runModelsProbe(executable: string): Promise<void> {
      if (isClosingOrClosed()) {
        throw Object.assign(new Error("cursor driver closed during prewarm"), {
          runtimeCode: "CANCELLED",
        });
      }
      const cwd = await ensureLayout();
      const spawnPromise = supervisor.spawnDriver({
        participantId: `${participantId}:probe`,
        executable,
        argv: ["models"],
        cwd,
        envInherit: ENV_INHERIT,
        envSet: {},
      });
      pendingProbe = spawnPromise;
      const spawned = await spawnPromise;
      pendingProbe = null;
      if (isClosingOrClosed()) {
        await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        throw Object.assign(new Error("cursor driver closed during prewarm"), {
          runtimeCode: "CANCELLED",
        });
      }
      activeProbe = spawned;
      const stdoutRing = createBoundedRing(64 * 1024);
      const stderrRing = createBoundedRing(LIMITS.stderrRingBytes);
      spawned.stdout.on("data", (chunk: Buffer) => stdoutRing.append(chunk.toString("utf8")));
      spawned.stderr.on("data", (chunk: Buffer) => stderrRing.append(chunk.toString("utf8")));
      try {
        const code = await withDeadline(
          new Promise<number | null>((resolve) => {
            spawned.events.once("exit", ({ code: exitCode }: { code: number | null }) => {
              resolve(exitCode);
            });
          }),
          timeouts.handshakeMs,
          () =>
            Object.assign(new Error("cursor models probe timed out"), {
              runtimeCode: "HANDSHAKE_TIMEOUT",
            }),
        );
        const stdout = stdoutRing.text();
        const stderr = stderrRing.text();
        if (code !== 0 || looksLikeAuthFailure(`${stdout}\n${stderr}`)) {
          throw Object.assign(new Error("cursor models probe failed (login required?)"), {
            runtimeCode: "AUTH_REQUIRED",
          });
        }
        const parsed = parseCursorModelsText(stdout);
        if (parsed.catalog.length > 0) catalog = parsed.catalog;
        if (parsed.canonical) canonical = parsed.canonical;
      } finally {
        activeProbe = null;
        await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
      }
    }

    function settleOnExit(turn: ActiveTurn, exitCode: number | null, stderr: string): void {
      if (turn.settled) return;
      if (turn.cancelling) {
        interruptTurn(turn, "user_cancelled");
        return;
      }
      if (exitCode !== 0) {
        invalidateSession("nonzero_exit");
        const auth = looksLikeAuthFailure(`${turn.stdout}\n${stderr}`);
        failTurn(
          turn,
          makeError(
            auth ? "AUTH_REQUIRED" : "DRIVER_CRASH",
            "stream",
            auth
              ? "Cursor Agent CLI is not logged in."
              : `cursor-agent exited with code ${exitCode ?? "null"}.`,
            {
              driverId: "cursor-stream-json",
              executionId: turn.executionId,
              participantId,
              retryable: !auth,
            },
          ),
        );
        return;
      }
      const parsed = parseCursorJsonResult(turn.stdout);
      if (parsed === null || parsed.text.trim().length === 0) {
        invalidateSession("empty_output");
        failTurn(
          turn,
          makeError("EMPTY_OUTPUT", "stream", "Completed with empty normalized output.", {
            driverId: "cursor-stream-json",
            executionId: turn.executionId,
            participantId,
          }),
        );
        return;
      }
      if (turn.coldStart && (parsed.sessionId === null || parsed.sessionId.length === 0)) {
        invalidateSession("missing_session");
        failTurn(
          turn,
          makeError(
            "INCOMPATIBLE_DRIVER",
            "stream",
            "First turn produced no session_id; per-turn resume is unavailable.",
            { driverId: "cursor-stream-json", executionId: turn.executionId, participantId },
          ),
        );
        return;
      }
      if (parsed.sessionId) {
        if (turn.coldStart) {
          sessionId = parsed.sessionId;
        } else if (sessionId !== null && parsed.sessionId !== sessionId) {
          invalidateSession("session_diverged");
          failTurn(
            turn,
            makeError(
              "INCOMPATIBLE_DRIVER",
              "stream",
              "Cursor returned a different session id on resume.",
              {
                driverId: "cursor-stream-json",
                executionId: turn.executionId,
                participantId,
              },
            ),
          );
          return;
        } else {
          sessionId = parsed.sessionId;
        }
      }
      emitTerminal(turn, {
        type: "completed",
        output: parsed.text,
        requestedModel: turn.modelId,
        effectiveModel: parsed.effectiveModel ?? turn.modelId,
        modelVerdict: cursorModelVerdict(turn.modelId, parsed.effectiveModel),
        toolState: "none",
        dispatchState: "accepted",
        usage: null,
        finalSeq: 0,
      } as DriverEvent);
    }

    async function runTurn(input: ExecuteInput, emit: Emit): Promise<void> {
      const installation = heldInstallation;
      if (!installation?.realpath) {
        emit({
          type: "failed",
          error: makeError(
            "DRIVER_CRASH",
            "dispatch",
            "cursor driver has no validated installation realpath",
            {
              driverId: "cursor-stream-json",
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
      const cwd = await ensureLayout();
      const renderedPrompt =
        input.coldStart && persona
          ? `${persona}\n\n${DISCUSSION_CONTRACT}\n\n${input.prompt}`
          : input.coldStart
            ? `${DISCUSSION_CONTRACT}\n\n${input.prompt}`
            : input.prompt;

      state = "busy";
      emit({ type: "started", requestedModel: input.modelId } as DriverEvent);

      await new Promise<void>((resolvePromise) => {
        const turn: ActiveTurn = {
          executionId: input.executionId,
          modelId: input.modelId,
          emit,
          coldStart: input.coldStart,
          stdout: "",
          dispatchState: "not_dispatched",
          cancelling: false,
          settled: false,
          resolve: resolvePromise,
        };
        activeTurn = turn;

        const argv: string[] = ["--print", "--output-format", "json", "--mode", "ask", "--trust"];
        if (!input.coldStart && sessionId) argv.push("--resume", sessionId);
        if (!isCursorDefaultModel(input.modelId)) argv.push("--model", input.modelId);
        argv.push("--workspace", cwd);

        const stderrRing = createBoundedRing(LIMITS.stderrRingBytes);
        const drain = {
          processExit: false,
          exitCode: null as number | null,
          stdoutEnded: false,
          stderrEnded: false,
          settled: false,
          graceTimer: undefined as NodeJS.Timeout | undefined,
          stderrGraceTimer: undefined as NodeJS.Timeout | undefined,
        };
        let turnProcess: DriverProcess | null = null;

        function finishSettle(): void {
          if (drain.settled || turn.settled) return;
          drain.settled = true;
          if (drain.graceTimer) clearTimeout(drain.graceTimer);
          if (drain.stderrGraceTimer) clearTimeout(drain.stderrGraceTimer);
          turnProcess = null;
          if (activeTurn === turn) settleOnExit(turn, drain.exitCode, stderrRing.text());
        }

        function trySettle(): void {
          if (drain.settled || turn.settled || !drain.processExit) return;
          if (!drain.stdoutEnded) {
            if (!drain.graceTimer) {
              drain.graceTimer = setTimeout(() => {
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
                      "Process exited but stdout did not drain within the grace window.",
                      {
                        driverId: "cursor-stream-json",
                        executionId: turn.executionId,
                        participantId,
                        retryable: true,
                      },
                    ),
                    dispatchState: turn.dispatchState,
                    toolState: "unknown",
                    retryable: true,
                  });
                  const proc = turnProcess;
                  turnProcess = null;
                  if (proc) void proc.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
                }
              }, EXIT_DRAIN_GRACE_MS);
              drain.graceTimer.unref();
            }
            return;
          }
          if (drain.exitCode !== 0 && !turn.cancelling && !drain.stderrEnded) {
            if (!drain.stderrGraceTimer) {
              drain.stderrGraceTimer = setTimeout(() => {
                drain.stderrGraceTimer = undefined;
                finishSettle();
              }, STDERR_DRAIN_GRACE_MS);
              drain.stderrGraceTimer.unref();
            }
            return;
          }
          finishSettle();
        }

        const spawnPromise = supervisor.spawnDriver({
          participantId,
          executable: installation.realpath,
          argv,
          cwd,
          envInherit: ENV_INHERIT,
          envSet: {},
        });
        pendingSpawn = spawnPromise;
        spawnPromise
          .then((spawned) => {
            pendingSpawn = null;
            if (state === "closing" || state === "closed" || turn.settled || activeTurn !== turn) {
              void spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
              return;
            }
            activeProcess = spawned;
            turnProcess = spawned;
            spawned.stdin.write(renderedPrompt, (error) => {
              if (error && activeTurn === turn && !turn.settled) {
                invalidateSession("stdin_write_failed");
                failTurn(
                  turn,
                  makeError("DRIVER_SPAWN_FAILED", "dispatch", error.message, {
                    driverId: "cursor-stream-json",
                    executionId: turn.executionId,
                    participantId,
                    retryable: true,
                  }),
                );
                return;
              }
              spawned.closeStdin();
            });
            spawned.stdout.on("data", (chunk: Buffer) => {
              const next = turn.stdout + chunk.toString("utf8");
              turn.stdout = next.length > STDOUT_CAP ? next.slice(next.length - STDOUT_CAP) : next;
              if (turn.dispatchState === "not_dispatched") turn.dispatchState = "unknown";
            });
            spawned.stdout.on("end", () => {
              drain.stdoutEnded = true;
              trySettle();
            });
            spawned.stderr.on("data", (chunk: Buffer) => stderrRing.append(chunk.toString("utf8")));
            spawned.stderr.on("end", () => {
              drain.stderrEnded = true;
              trySettle();
            });
            spawned.events.once("exit", ({ code }: { code: number | null }) => {
              activeProcess = null;
              drain.processExit = true;
              drain.exitCode = code;
              trySettle();
              if (state === "busy") state = "ready";
            });
            spawned.waitSupervised(timeouts.handshakeMs).catch((error: unknown) => {
              if (activeTurn === turn && !turn.settled) {
                const msg = error instanceof Error ? error.message : "supervised spawn failed";
                invalidateSession("spawn_failed");
                failTurn(
                  turn,
                  makeError("DRIVER_SPAWN_FAILED", "prewarm", msg, {
                    driverId: "cursor-stream-json",
                    executionId: turn.executionId,
                    participantId,
                    retryable: true,
                  }),
                );
              }
            });
            turn.turnTimer = setTimeout(() => {
              if (activeTurn === turn && !turn.settled && !turn.cancelling) {
                invalidateSession("turn_timeout");
                interruptTurn(turn, "timeout");
                void reapActiveProcess();
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
                  driverId: "cursor-stream-json",
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

    return {
      participantId,
      driverId: "cursor-stream-json",
      get sessionEpoch() {
        return sessionEpoch;
      },

      async prewarm(input: PrewarmInput): Promise<PrewarmResult> {
        if (input.spec.profile.driverId !== "cursor-stream-json") {
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
        if (isClosingOrClosed()) {
          throw Object.assign(new Error("cursor driver closed during prewarm"), {
            runtimeCode: "CANCELLED",
          });
        }
        await runModelsProbe(input.installation.realpath).catch((error) => {
          const runtimeCode =
            error instanceof Error ? (error as { runtimeCode?: string }).runtimeCode : undefined;
          if (runtimeCode === "HANDSHAKE_TIMEOUT" || runtimeCode === "CANCELLED") throw error;
          if (runtimeCode === "AUTH_REQUIRED") throw error;
          throw Object.assign(
            new Error(error instanceof Error ? error.message : "cursor models probe failed"),
            {
              runtimeCode: "AUTH_REQUIRED",
            },
          );
        });
        if (isClosingOrClosed()) {
          throw Object.assign(new Error("cursor driver closed during prewarm"), {
            runtimeCode: "CANCELLED",
          });
        }
        if (input.spec.modelId !== "__catalog__" && !modelAllowed(input.spec.modelId)) {
          throw Object.assign(
            new Error(`model ${input.spec.modelId} is not in the cursor catalog`),
            {
              runtimeCode: "MODEL_UNAVAILABLE",
              catalog: [...catalog],
            },
          );
        }
        state = "ready";
        return {
          canonicalModelId: canonical,
          modelAliases: [],
          capability: {
            protocol: "cursor-stream-json",
            credentialMode: "installation-managed",
            providerProbe: "cursor-agent-models",
            sessionResume: true,
            outputMode: "final-only",
            modelSelection: "cursor-auto-or-exact",
          },
          catalog: [...catalog],
        };
      },

      async execute(input: ExecuteInput, emit: Emit): Promise<void> {
        if (activeTurn) {
          throw Object.assign(new Error("participant busy"), { runtimeCode: "PARTICIPANT_BUSY" });
        }
        if (state === "closed") {
          emit({
            type: "failed",
            error: makeError("DRIVER_CRASH", "dispatch", "cursor driver is closed", {
              driverId: "cursor-stream-json",
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
              "cursor driver has no held installation; prewarm required",
              {
                driverId: "cursor-stream-json",
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
        clearTurnTimers(turn);
        invalidateSession("cancelled");
        const pending = pendingSpawn;
        await reapActiveProcess();
        if (pending) {
          const spawned = await pending.catch(() => null);
          if (spawned) await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        }
        if (!turn.settled) interruptTurn(turn, "user_cancelled");
      },

      async close(): Promise<void> {
        state = "closing";
        const turn = activeTurn;
        if (turn) {
          turn.cancelling = true;
          clearTurnTimers(turn);
          invalidateSession("closed");
        }
        const pending = pendingSpawn;
        const probePending = pendingProbe;
        await reapActiveProcess();
        if (activeProbe) {
          const probe = activeProbe;
          activeProbe = null;
          await probe.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        }
        if (pending) {
          const spawned = await pending.catch(() => null);
          if (spawned) await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        }
        if (probePending) {
          const spawned = await probePending.catch(() => null);
          if (spawned) await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        }
        if (turn && !turn.settled) interruptTurn(turn, "user_cancelled");
        state = "closed";
      },

      contextWindowTokens() {
        return CONTEXT_WINDOW_TOKENS;
      },
      capabilityState() {
        if (state === "closed" || state === "closing") return "incompatible";
        if (state === "cold") return "checking";
        return "ready";
      },
    };
  };
}
