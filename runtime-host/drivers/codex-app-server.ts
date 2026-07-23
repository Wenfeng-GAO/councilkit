import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DispatchState, ToolState } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import { sanitizeString } from "../logging";
import type { DriverProcess } from "../process/process-supervisor";
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
 * `codex-app-server` Driver: one long-lived `codex app-server --listen
 * stdio://` process per Participant, one ephemeral thread per Execution
 * Session. Compatibility is capability-based (initialize, account/read,
 * model/list, thread/turn, stream, interrupt) with open-set parsing — unknown
 * fields and notifications are ignored, never fatal; there is no version
 * allowlist. Verified live against codex-cli 0.144.5.
 *
 * Dispatch semantics (ADR-0007): a turn is `not_dispatched` only until the
 * request bytes are accepted by the OS; after write it is `unknown` until the
 * server response confirms acceptance. `accepted`/`unknown` never auto-retry.
 */

const ENV_INHERIT = ["HOME", "PATH", "LANG", "TERM", "TMPDIR", "USER", "LOGNAME"] as const;

const TEXT_ITEM_TYPES = new Set(["agentMessage"]);
/** Non-text items become sanitized activity events and drive tool state. */
const ACTIVITY_ITEM_TYPES: Record<string, "tool" | "command" | "other"> = {
  commandExecution: "command",
  fileChange: "tool",
  mcpToolCall: "tool",
  dynamicToolCall: "tool",
  collabAgentToolCall: "tool",
  webSearch: "tool",
};

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
}

interface ActiveTurn {
  executionId: string;
  turnId: string | null;
  modelId: string;
  emit: Emit;
  dispatchState: DispatchState;
  toolState: ToolState;
  sawToolActivity: boolean;
  cancelling: boolean;
  agentText: string;
  effectiveModel: string | null;
  rerouteReason: string | null;
  lastUsage: { inputTokens?: number | null; outputTokens?: number | null } | null;
  idleTimer?: NodeJS.Timeout;
  turnTimer?: NodeJS.Timeout;
  resolve(): void;
}

type DriverState = "cold" | "starting" | "ready" | "busy" | "closing" | "closed";

export function createCodexAppServerDriver(
  deps: DriverDeps,
): (participantId: string) => ParticipantDriver {
  const { supervisor, logger, timeouts, workRoot } = deps;

  return (participantId: string): ParticipantDriver => {
    let state: DriverState = "cold";
    let process: DriverProcess | null = null;
    // H4/F4 (CK-RS-001 port): track the in-flight spawn so close() can await it
    // (kimi pendingSpawn pattern). A process that resolves while/after close()
    // ran is shut down by the post-spawn guard below, never adopted into a
    // closing driver — closing the P1 leak window (close() during the spawn
    // await, process===null, nothing pending to fail).
    let pendingSpawn: Promise<DriverProcess> | null = null;
    let sessionEpoch = 0;
    let threadId: string | null = null;
    let threadModel: string | null = null;
    let catalog: string[] = [];
    let reasoningEfforts: string[] = [];
    let modelContextWindow: number | null = null;
    let requestCounter = 0;
    let activeTurn: ActiveTurn | null = null;
    const pending = new Map<string, PendingRequest>();
    let persona: string | null = null;
    let reasoningEffort: string | null = null;

    function diagnostic(kind: string, message: string, context?: Record<string, unknown>) {
      logger.diagnostic(`codex.${kind}`, message, { participantId, ...context });
    }

    function failAllPending(error: Error) {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    }

    // H4 (CK-RS-001 port): close() flips `state` to "closing" then "closed"
    // asynchronously across `await`s; every close-sensitive check goes through
    // this indirection so inline `state === "closing"` narrowing after an await
    // does not lie (mirrors kimi-stream-json L180).
    function isClosingOrClosed(): boolean {
      return state === "closing" || state === "closed";
    }

    function sendRequest(method: string, params: unknown): Promise<unknown> {
      if (!process) return Promise.reject(new Error("app-server not running"));
      const id = `ck-${participantId}-${++requestCounter}`;
      return withDeadline(
        new Promise((resolvePromise, rejectPromise) => {
          pending.set(id, { resolve: resolvePromise, reject: rejectPromise, method });
          process?.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
            if (error) {
              pending.delete(id);
              rejectPromise(error);
            }
          });
        }),
        timeouts.handshakeMs,
        () => new Error(`${method} timed out`),
      );
    }

    function sendNotification(method: string, params: unknown) {
      try {
        process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
      } catch {
        // best effort
      }
    }

    /** Approval-type server requests are always declined (no approval UI). */
    function handleServerRequest(message: Record<string, unknown>) {
      const id = message.id;
      const method = typeof message.method === "string" ? message.method : "";
      diagnostic("server_request_declined", `declined server request ${method}`);
      const decision = { decision: "denied" };
      try {
        process?.stdin.write(`${JSON.stringify({ id, result: decision })}\n`);
      } catch {
        // process gone
      }
    }

    function clearTurnTimers(turn: ActiveTurn) {
      if (turn.idleTimer) clearTimeout(turn.idleTimer);
      if (turn.turnTimer) clearTimeout(turn.turnTimer);
    }

    function emitTerminal(turn: ActiveTurn, event: DriverEvent) {
      clearTurnTimers(turn);
      if (activeTurn === turn) activeTurn = null;
      turn.emit(event);
      turn.resolve();
      if (state === "busy") state = "ready";
    }

    function failTurn(turn: ActiveTurn, error: ReturnType<typeof makeError>) {
      emitTerminal(turn, {
        type: "failed",
        error,
        dispatchState: turn.dispatchState,
        toolState: turn.toolState,
        retryable: false,
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
        toolState: turn.toolState,
      });
    }

    function armIdleTimer(turn: ActiveTurn) {
      if (turn.idleTimer) clearTimeout(turn.idleTimer);
      turn.idleTimer = setTimeout(() => {
        failTurn(
          turn,
          makeError("STREAM_IDLE_TIMEOUT", "stream", "No protocol frames within the idle limit.", {
            driverId: "codex-app-server",
            executionId: turn.executionId,
            participantId,
          }),
        );
      }, timeouts.streamIdleMs);
    }

    function noteToolActivity(
      turn: ActiveTurn,
      kind: "tool" | "command" | "other",
      itemType: string,
    ) {
      turn.sawToolActivity = true;
      if (turn.toolState === "none") turn.toolState = "active";
      turn.emit({
        type: "activity",
        kind,
        summary: sanitizeString(`codex ${itemType} activity`, 256),
      } as DriverEvent);
    }

    function handleItemCompleted(turn: ActiveTurn, params: Record<string, unknown>) {
      const item = params.item as Record<string, unknown> | undefined;
      if (!item || typeof item.type !== "string") return;
      if (TEXT_ITEM_TYPES.has(item.type)) {
        if (typeof item.text === "string") {
          turn.agentText += item.text;
        }
        return;
      }
      const kind = ACTIVITY_ITEM_TYPES[item.type];
      if (kind) {
        noteToolActivity(turn, kind, item.type);
        turn.toolState = "completed";
      }
      // All other item types (reasoning, plan, userMessage…) are ignored.
    }

    function handleTurnCompleted(turn: ActiveTurn, params: Record<string, unknown>) {
      const completedTurn = params.turn as Record<string, unknown> | undefined;
      const status = (completedTurn?.status as string | undefined) ?? "failed";
      if (turn.cancelling || status === "interrupted") {
        interruptTurn(turn, turn.cancelling ? "user_cancelled" : "unknown");
        return;
      }
      if (status !== "completed") {
        failTurn(
          turn,
          makeError("DRIVER_CRASH", "stream", `turn completed with status=${status}`, {
            driverId: "codex-app-server",
            executionId: turn.executionId,
            participantId,
          }),
        );
        return;
      }
      const output = turn.agentText;
      if (output.trim().length === 0) {
        failTurn(
          turn,
          makeError("EMPTY_OUTPUT", "stream", "Completed with empty normalized output.", {
            driverId: "codex-app-server",
            executionId: turn.executionId,
            participantId,
          }),
        );
        return;
      }
      const effective = turn.effectiveModel ?? threadModel;
      const verdict =
        effective && effective === turn.modelId ? "match" : effective ? "mismatch" : "unknown";
      emitTerminal(turn, {
        type: "completed",
        output,
        requestedModel: turn.modelId,
        effectiveModel: effective ?? null,
        modelVerdict: verdict as "match" | "mismatch" | "unknown",
        toolState: turn.toolState,
        dispatchState: "accepted",
        usage: turn.lastUsage,
        finalSeq: 0,
      } as DriverEvent);
    }

    function handleNotification(message: Record<string, unknown>) {
      const method = typeof message.method === "string" ? message.method : "";
      const params = (message.params ?? {}) as Record<string, unknown>;
      const turn = activeTurn;
      if (turn) armIdleTimer(turn);
      switch (method) {
        case "item/agentMessage/delta": {
          if (turn && typeof params.delta === "string" && params.delta) {
            turn.emit({ type: "output.delta", text: params.delta } as DriverEvent);
          }
          return;
        }
        case "item/started": {
          const item = params.item as Record<string, unknown> | undefined;
          const itemType = item?.type;
          if (turn && typeof itemType === "string" && ACTIVITY_ITEM_TYPES[itemType]) {
            noteToolActivity(turn, ACTIVITY_ITEM_TYPES[itemType] as "tool" | "command", itemType);
          }
          return;
        }
        case "item/completed": {
          if (turn) handleItemCompleted(turn, params);
          return;
        }
        case "model/rerouted": {
          if (turn) {
            turn.effectiveModel = typeof params.toModel === "string" ? params.toModel : null;
            turn.rerouteReason =
              typeof params.reason === "string" ? sanitizeString(params.reason, 256) : null;
            diagnostic("rerouted", "model rerouted during turn", {
              from: sanitizeString(String(params.fromModel ?? ""), 128),
              to: sanitizeString(String(params.toModel ?? ""), 128),
            });
          }
          return;
        }
        case "thread/tokenUsage/updated": {
          const usage = params.tokenUsage as Record<string, unknown> | undefined;
          const last = usage?.last as Record<string, unknown> | undefined;
          if (turn && last) {
            turn.lastUsage = {
              inputTokens: typeof last.inputTokens === "number" ? last.inputTokens : null,
              outputTokens: typeof last.outputTokens === "number" ? last.outputTokens : null,
            };
          }
          const window = usage?.modelContextWindow;
          if (typeof window === "number" && window > 0) {
            modelContextWindow = window;
          }
          return;
        }
        case "turn/completed": {
          if (turn) {
            const completedTurn = params.turn as Record<string, unknown> | undefined;
            if (!turn.turnId || completedTurn?.id === turn.turnId) {
              handleTurnCompleted(turn, params);
            }
          }
          return;
        }
        case "thread/compacted": {
          // The runtime compacted its own history: the Session no longer
          // holds the full applied context. Force needs_rebase upstream.
          diagnostic("compacted", "app-server compacted thread context");
          if (turn) {
            failTurn(
              turn,
              makeError("NEEDS_REBASE", "stream", "Runtime compacted the session context.", {
                driverId: "codex-app-server",
                executionId: turn.executionId,
                participantId,
              }),
            );
          }
          sessionEpoch += 1;
          threadId = null;
          return;
        }
        case "error": {
          const willRetry =
            (params.error as Record<string, unknown> | undefined)?.willRetry === true;
          diagnostic("turn_error", `server error notification willRetry=${willRetry}`);
          if (turn && !willRetry) {
            failTurn(
              turn,
              makeError("DRIVER_CRASH", "stream", "server reported a terminal error", {
                driverId: "codex-app-server",
                executionId: turn.executionId,
                participantId,
              }),
            );
          }
          // willRetry=true: Codex is retrying internally; the Orchestrator
          // must not start its own concurrent retry — keep waiting.
          return;
        }
        default:
          // Open set: unknown notifications are ignored by design (ADR-0007).
          return;
      }
    }

    function onFrame(message: Record<string, unknown>) {
      const id = message.id;
      const hasResult = Object.hasOwn(message, "result") || Object.hasOwn(message, "error");
      if (id !== undefined && hasResult) {
        const entry = pending.get(String(id));
        if (entry) {
          pending.delete(String(id));
          const errorValue = message.error;
          if (errorValue) {
            entry.reject(new Error(sanitizeString(JSON.stringify(errorValue).slice(0, 300))));
          } else {
            entry.resolve(message.result);
          }
          return;
        }
      }
      if (id !== undefined && typeof message.method === "string" && !hasResult) {
        handleServerRequest(message);
        return;
      }
      if (typeof message.method === "string") {
        handleNotification(message);
        return;
      }
      diagnostic("unknown_frame", "unhandled stdout frame", {});
    }

    function onProcessExit(code: number | null, signal: string | null) {
      logger.warn("codex.process_exit", { participantId, code, signal });
      process = null;
      threadId = null;
      // An exit during an intentional close is not a session rebuild: close()
      // already accounts for that generation change.
      if (state !== "closing" && state !== "closed") {
        sessionEpoch += 1;
        state = "cold";
      }
      // H4 (CK-RS-001 port): an exit during an intentional close() is a
      // lifecycle cancellation, NOT a crash — label the close-caught rejection
      // CANCELLED so scope-manager.prewarmParticipant short-circuits to cold/
      // readiness-null + scope.prewarm_cancelled instead of poisoning the
      // closing scope with runtime_unavailable + scope.prewarm_failed. A
      // genuine crash (no concurrent close) keeps the plain 'app-server exited'.
      failAllPending(
        isClosingOrClosed()
          ? Object.assign(new Error("codex app-server closed during prewarm"), {
              runtimeCode: "CANCELLED",
            })
          : new Error("app-server exited"),
      );
      const turn = activeTurn;
      if (turn) {
        // Ephemeral thread is gone. If any tool activity was seen, the tool
        // state can no longer be proven — surface unknown per the plan.
        const crashedTurn = {
          ...turn,
          toolState: turn.sawToolActivity ? ("unknown" as const) : turn.toolState,
        };
        emitTerminal(crashedTurn, {
          type: "interrupted",
          reason: "driver_crash",
          dispatchState: turn.dispatchState,
          toolState: crashedTurn.toolState,
        });
      }
    }

    let lastInstallation: PrewarmInput["installation"] | null = null;

    async function spawnProcess(installation: PrewarmInput["installation"]): Promise<void> {
      if (!installation.realpath) {
        throw Object.assign(new Error("installation has no validated realpath"), {
          runtimeCode: "INSTALLATION_INVALID",
        });
      }
      const cwd = join(workRoot, participantId);
      await mkdir(cwd, { recursive: true });
      // H3 (kimi pre-spawn guard, fix-2): the LAST lifecycle check before
      // spawning. close() can complete during the mkdir await above (or before
      // prewarm reached this point); without this guard the spawn would proceed
      // on a closing/closed driver and the late process would be adopted into it
      // (P1/F2a). CANCELLED is the lifecycle label (H4). There is no await
      // between this check and the pendingSpawn registration below, so close()
      // can never return and then have a process spawn behind its back.
      if (isClosingOrClosed()) {
        throw Object.assign(new Error("codex app-server closed during prewarm"), {
          runtimeCode: "CANCELLED",
        });
      }
      const spawnPromise = supervisor.spawnDriver({
        participantId,
        executable: installation.realpath,
        argv: ["app-server", "--listen", "stdio://"],
        cwd,
        envInherit: ENV_INHERIT,
        envSet: {},
      });
      // F2b (fix-2): pendingSpawn tracks the FULL spawn→post-spawn-guard
      // continuation (spawn + the guard's late-process shutdown), not the raw
      // spawn promise, so close() awaiting pendingSpawn waits for a late process
      // to be FULLY reaped before close returns (F2b). The guard executes once;
      // a spawn reject propagates and does not hang close() (caught + swallowed).
      const spawnContinuation = (async (): Promise<DriverProcess> => {
        const spawned = await spawnPromise;
        // G2: close() ran while the spawn was pending. Never adopt the process —
        // shut it down immediately and reject CANCELLED so the scope short-
        // circuits to prewarm_cancelled (H4), instead of leaking an adopted-to-
        // closed driver (P1).
        if (isClosingOrClosed()) {
          await spawned.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
          throw Object.assign(new Error("codex app-server closed during prewarm"), {
            runtimeCode: "CANCELLED",
          });
        }
        return spawned;
      })();
      pendingSpawn = spawnContinuation;
      const spawned = await spawnContinuation.finally(() => {
        if (pendingSpawn === spawnContinuation) pendingSpawn = null;
      });
      process = spawned;
      spawned.events.on(
        "exit",
        ({ code, signal }: { code: number | null; signal: string | null }) =>
          onProcessExit(code, signal),
      );
      attachNdjsonSplitter(spawned.stdout, {
        onLine(line) {
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            diagnostic("bad_json", "non-JSON stdout line", {});
            return;
          }
          onFrame(message);
        },
        onLimitExceeded() {
          const turn = activeTurn;
          if (turn) {
            failTurn(
              turn,
              makeError("PROTOCOL_LIMIT", "stream", "NDJSON line exceeded the 8 MiB limit.", {
                driverId: "codex-app-server",
                executionId: turn.executionId,
                participantId,
              }),
            );
          }
          void respawn("protocol_limit");
        },
        onEnd() {
          // process exit handler covers state
        },
      });
      // F1 (fix-2): waitSupervised straddles the adopt→initialize window —
      // `process` is set and the exit handler is registered, but no RPC is
      // pending yet (initialize is sent in handshake() after this resolves). So
      // a close()-SIGTERM here makes onProcessExit's failAllPending(CANCELLED) a
      // no-op and waitSupervised rejects with a plain error the narrowed prewarm
      // catch would rethrow verbatim — poisoning the closing scope. Relabel
      // CANCELLED on the close path (H4); a genuine supervised-spawn failure
      // keeps its plain error.
      try {
        await spawned.waitSupervised(timeouts.handshakeMs);
      } catch (err) {
        if (isClosingOrClosed()) {
          throw Object.assign(new Error("codex app-server closed during prewarm"), {
            runtimeCode: "CANCELLED",
          });
        }
        throw err;
      }
    }

    async function handshake(modelId: string): Promise<void> {
      if (!process) throw new Error("app-server not running");
      await sendRequest("initialize", {
        clientInfo: { name: "councilkit-runtime-host", title: null, version: "0.0.1" },
        capabilities: {},
      });
      sendNotification("initialized", {});

      const account = (await sendRequest("account/read", {})) as {
        account?: unknown;
        requiresOpenaiAuth?: boolean;
      };
      if (!account?.account) {
        throw Object.assign(new Error("codex local login not available"), {
          runtimeCode: "AUTH_REQUIRED",
        });
      }

      const models = (await sendRequest("model/list", {})) as {
        data?: {
          model?: string;
          hidden?: boolean;
          supportedReasoningEfforts?: { reasoningEffort?: string }[];
        }[];
      };
      const entries = Array.isArray(models?.data) ? models.data : [];
      catalog = entries
        .filter((m) => m && !m.hidden && typeof m.model === "string")
        .map((m) => m.model as string);
      if (!catalog.includes(modelId)) {
        throw Object.assign(new Error(`model ${modelId} not in codex catalog`), {
          runtimeCode: "MODEL_UNAVAILABLE",
          // The handshake already paid for model/list: hand the served set to
          // callers (catalog probe, choose-model repair) instead of losing it.
          catalog: [...catalog],
        });
      }
      const selected = entries.find((m) => m.model === modelId);
      reasoningEfforts = (selected?.supportedReasoningEfforts ?? [])
        .map((r) => r?.reasoningEffort)
        .filter((r): r is string => typeof r === "string");

      const thread = (await sendRequest("thread/start", {
        model: modelId,
        cwd: join(workRoot, participantId),
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
      })) as { thread?: { id?: string }; model?: string };
      if (!thread?.thread?.id) {
        throw Object.assign(new Error("thread/start returned no thread id"), {
          runtimeCode: "INCOMPATIBLE_DRIVER",
        });
      }
      threadId = thread.thread.id;
      threadModel = typeof thread.model === "string" ? thread.model : modelId;
      state = "ready";
    }

    async function respawn(reason: string): Promise<void> {
      logger.warn("codex.respawn", { participantId, reason });
      const old = process;
      process = null;
      threadId = null;
      sessionEpoch += 1;
      if (old) {
        // Await the old process's full teardown BEFORE spawning: the
        // supervisor rejects a second live driver for the same participant,
        // and a stale exit event must never clobber the replacement process.
        await old.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
      }
      if (state !== "closing" && state !== "closed" && lastInstallation && lastModelId) {
        state = "starting";
        await spawnProcess(lastInstallation);
        await handshake(lastModelId);
      }
    }

    let lastModelId: string | null = null;

    return {
      participantId,
      driverId: "codex-app-server",
      get sessionEpoch() {
        return sessionEpoch;
      },

      async prewarm(input: PrewarmInput): Promise<PrewarmResult> {
        if (input.spec.profile.driverId !== "codex-app-server") {
          throw Object.assign(new Error("profile driver mismatch"), {
            runtimeCode: "PROFILE_INVALID",
          });
        }
        persona = input.spec.personaPrompt ?? null;
        reasoningEffort =
          (input.spec.profile.options as { reasoningEffort?: string }).reasoningEffort ?? null;
        lastInstallation = input.installation;
        lastModelId = input.spec.modelId;
        if (state === "ready" || state === "busy") {
          return {
            canonicalModelId: threadModel ?? input.spec.modelId,
            modelAliases: [],
            capability: {
              protocol: "codex-app-server",
              methods: [
                "initialize",
                "account/read",
                "model/list",
                "thread/start",
                "turn/start",
                "turn/interrupt",
              ],
              reasoningEfforts,
            },
            catalog,
          };
        }
        state = "starting";
        try {
          await spawnProcess(input.installation);
          await handshake(input.spec.modelId);
        } catch (error) {
          // H4 (CK-RS-001 port): a handshake rejected because close() shut the
          // app-server down is a lifecycle cancellation. The source guards
          // already label close-caught errors CANCELLED (the post-spawn guard
          // for the spawn window; onProcessExit's failAllPending for the
          // in-flight initialize window), so just rethrow on the close path —
          // never write back cold there (would race close()'s closing→closed
          // flip). A genuine failure with no concurrent close keeps cold + throw.
          if (isClosingOrClosed()) {
            throw error;
          }
          state = "cold";
          throw error;
        }
        return {
          canonicalModelId: threadModel ?? input.spec.modelId,
          modelAliases: [],
          capability: {
            protocol: "codex-app-server",
            methods: [
              "initialize",
              "account/read",
              "model/list",
              "thread/start",
              "turn/start",
              "turn/interrupt",
            ],
            reasoningEfforts,
          },
          catalog,
        };
      },

      async execute(input: ExecuteInput, emit: Emit): Promise<void> {
        if (activeTurn) {
          throw Object.assign(new Error("participant busy"), { runtimeCode: "PARTICIPANT_BUSY" });
        }
        if (!process || !threadId || state !== "ready") {
          // Never retried in place (codex policy): surface a retryable
          // terminal so the Round pauses and the caller decides.
          emit({
            type: "failed",
            error: makeError("DRIVER_CRASH", "dispatch", "driver process or thread is not ready", {
              driverId: "codex-app-server",
              executionId: input.executionId,
              participantId,
              retryable: true,
            }),
            dispatchState: "not_dispatched",
            toolState: "none",
            retryable: true,
          });
          return;
        }
        state = "busy";
        emit({ type: "started", requestedModel: input.modelId } as DriverEvent);

        await new Promise<void>((resolvePromise) => {
          const turn: ActiveTurn = {
            executionId: input.executionId,
            turnId: null,
            modelId: input.modelId,
            emit,
            dispatchState: "not_dispatched",
            toolState: "none",
            sawToolActivity: false,
            cancelling: false,
            agentText: "",
            effectiveModel: null,
            rerouteReason: null,
            lastUsage: null,
            resolve: resolvePromise,
          };
          activeTurn = turn;
          armIdleTimer(turn);
          turn.turnTimer = setTimeout(() => {
            interruptTurn(turn, "timeout");
            void respawn("turn_timeout");
          }, timeouts.turnMs);

          const params: Record<string, unknown> = {
            threadId,
            clientUserMessageId: input.executionId,
            input: [{ type: "text", text: input.prompt }],
          };
          if (reasoningEffort) params.effort = reasoningEffort;
          if (persona && input.coldStart) {
            params.developerInstructions = persona;
          }

          const id = `ck-${participantId}-${++requestCounter}`;
          pending.set(id, {
            method: "turn/start",
            resolve: (result) => {
              const started = result as { turn?: { id?: string } };
              turn.turnId = started?.turn?.id ?? null;
              turn.dispatchState = "accepted";
            },
            reject: (error) => {
              failTurn(
                turn,
                makeError("DRIVER_CRASH", "dispatch", sanitizeString(error.message), {
                  driverId: "codex-app-server",
                  executionId: turn.executionId,
                  participantId,
                }),
              );
            },
          });
          process?.stdin.write(
            `${JSON.stringify({ id, method: "turn/start", params })}\n`,
            (error) => {
              if (error) {
                pending.delete(id);
                failTurn(
                  turn,
                  makeError("DRIVER_CRASH", "dispatch", `stdin write failed: ${error.message}`, {
                    driverId: "codex-app-server",
                    executionId: turn.executionId,
                    participantId,
                  }),
                );
                return;
              }
              if (turn.dispatchState === "not_dispatched") {
                turn.dispatchState = "unknown";
              }
              setTimeout(() => {
                if (activeTurn === turn && turn.dispatchState === "unknown") {
                  failTurn(
                    turn,
                    makeError(
                      "DISPATCH_TIMEOUT",
                      "dispatch",
                      "turn/start was not acknowledged in time.",
                      {
                        driverId: "codex-app-server",
                        executionId: turn.executionId,
                        participantId,
                      },
                    ),
                  );
                }
              }, timeouts.dispatchAckMs);
            },
          );
        });
      },

      async cancel(executionId: string): Promise<void> {
        const turn = activeTurn;
        if (!turn || turn.executionId !== executionId) return;
        turn.cancelling = true;
        if (turn.turnId && threadId) {
          try {
            await sendRequest("turn/interrupt", { threadId, turnId: turn.turnId });
          } catch {
            // RPC success is not the end; escalation below handles silence.
          }
        }
        const deadline = Date.now() + timeouts.interruptGraceMs;
        while (activeTurn === turn && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (activeTurn === turn) {
          process?.kill("SIGKILL");
          interruptTurn(turn, "user_cancelled");
          await respawn("cancel_escalation").catch(() => undefined);
        }
      },

      async close(): Promise<void> {
        state = "closing";
        const turn = activeTurn;
        if (turn) {
          turn.cancelling = true;
          if (turn.turnId && threadId) {
            sendRequest("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => undefined);
          }
        }
        // F2b (fix-2): pendingSpawn is the full spawn→post-spawn-guard continuation,
        // so awaiting it waits for a late process to be FULLY reaped (the guard's
        // shutdown) before close returns — not just the raw spawn promise. A
        // process spawned-but-not-yet-adopted is shut down by the guard
        // (CANCELLED) rather than adopted into this closing driver and leaked
        // (P1). The guard runs once; a spawn reject is swallowed here.
        const pending = pendingSpawn;
        if (pending) {
          await pending.catch(() => undefined);
          pendingSpawn = null;
        }
        const current = process;
        process = null;
        threadId = null;
        if (current) {
          current.closeStdin();
          await current.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
        }
        sessionEpoch += 1;
        state = "closed";
      },

      capabilityState() {
        if (state === "ready" || state === "busy") return "ready";
        return "checking";
      },

      contextWindowTokens() {
        return modelContextWindow;
      },
    };
  };
}
