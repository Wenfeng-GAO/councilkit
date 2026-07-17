import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeError } from "@shared/runtime/errors";
import type { ClaudeRoute } from "@shared/runtime/schemas";
import { sanitizeString, sanitizeValue } from "../logging";
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
 * `claude-stream-json` Driver: one long-lived `cld <route>` stream-json
 * process per Participant. Verified live against the local installation
 * (2026-07): control `initialize` handshakes without a model call and yields
 * the resolvedModel catalog; the canonical model is the catalog `default`,
 * unless the route declares its verified serving model (`servesModel`, e.g.
 * moonshot → Kimi-K3[1m]) — still closed-set against the catalog. `system/init`
 * (first turn) must show empty tools/MCP/skills/slash commands; user-message
 * replay confirms enqueue; `result.result` is the authoritative output;
 * usage/cost are cumulative and reported as per-turn diffs.
 */

const DISCUSSION_CONTRACT = [
  "You are one Participant in a structured CouncilKit discussion.",
  "Stay in the persona given above and answer only the final instruction.",
  "Do not use tools; plain reasoned text is the whole deliverable.",
].join(" ");

interface RouteDef {
  argv: string[];
  /**
   * The model this route verifiably serves when it differs from the
   * handshake catalog's `default` entry (provider-declared reality, verified
   * live). It must still appear in the catalog — the closed-set property is
   * never bypassed; if the provider drops it, the installation is
   * INCOMPATIBLE_DRIVER. When the provider later swaps the serving model,
   * turns mismatch and pause until this mapping is updated — by design.
   */
  servesModel?: string;
  /**
   * Provider-declared context window class (the catalog ids' `[1m]` suffix =
   * 1M tokens). The Session Reconciler's 50% cumulative-input threshold uses
   * this instead of its 64k unknown-window default — reporting null here
   * false-throttles long-running rooms into a spurious needs_rebase pause.
   */
  contextWindowTokens?: number;
}

/**
 * Closed route set: model selection comes only from this explicit mapping.
 * moonshot's catalog default is claude-opus-4-8[1m], but the route's serving
 * model is provider-side and drifts: Kimi-K2.5 (verified 2026-07-17) was
 * replaced by Kimi-K3[1m] (verified 2026-07-18 — the provider dropped
 * Kimi-K2.5 from the handshake catalog; declaration updated per the plan's
 * drift-remedy precedent).
 */
const ROUTES: Record<ClaudeRoute, RouteDef> = {
  "ant-glm5.2": { argv: ["ant", "glm5.2"], contextWindowTokens: 1_000_000 },
  moonshot: {
    argv: ["moonshot"],
    servesModel: "Kimi-K3[1m]",
    contextWindowTokens: 1_000_000,
  },
  deepseek: { argv: ["deepseek"], contextWindowTokens: 1_000_000 },
};

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

const CONTROL_FRAME_KEYS = new Set([
  "type",
  "subtype",
  "request_id",
  "uuid",
  "session_id",
  "model",
  "is_error",
]);

interface PendingControl {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

interface ActiveTurn {
  executionId: string;
  uuid: string;
  modelId: string;
  emit: Emit;
  dispatchState: "not_dispatched" | "accepted" | "unknown";
  sawAssistantText: boolean;
  cancelling?: boolean;
  acceptedAt?: number;
  idleTimer?: NodeJS.Timeout;
  turnTimer?: NodeJS.Timeout;
  resolve(): void;
}

type DriverState = "cold" | "starting" | "ready" | "busy" | "closing" | "closed";

export function createClaudeStreamJsonDriver(
  deps: DriverDeps,
): (participantId: string) => ParticipantDriver {
  const { supervisor, logger, timeouts, workRoot } = deps;

  return (participantId: string): ParticipantDriver => {
    let state: DriverState = "cold";
    let process: DriverProcess | null = null;
    let sessionEpoch = 0;
    let canonicalModel: string | null = null;
    let catalog: string[] = [];
    let initVerified = false;
    let lastCumulative = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let activeTurn: ActiveTurn | null = null;
    let requestCounter = 0;
    const pendingControls = new Map<string, PendingControl>();
    let stderrTail = "";

    function diagnostic(kind: string, message: string, context?: Record<string, unknown>) {
      logger.diagnostic(`claude.${kind}`, message, { participantId, ...context });
    }

    function noteStderr(text: string) {
      stderrTail = sanitizeString(`${stderrTail}${text}`).slice(-2048);
    }

    function failAllPendingControls(error: Error) {
      for (const pending of pendingControls.values()) pending.reject(error);
      pendingControls.clear();
    }

    function sendControl(request: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!process) return Promise.reject(new Error("driver process not running"));
      const requestId = `ck-${participantId}-${++requestCounter}`;
      const frame = JSON.stringify({ type: "control_request", request_id: requestId, request });
      return withDeadline(
        new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
          pendingControls.set(requestId, { resolve: resolvePromise, reject: rejectPromise });
          process?.stdin.write(`${frame}\n`, (error) => {
            if (error) {
              pendingControls.delete(requestId);
              rejectPromise(error);
            }
          });
        }),
        timeouts.handshakeMs,
        () => new Error("control request timed out"),
      );
    }

    function handleControlResponse(message: Record<string, unknown>): boolean {
      if (message.type !== "control_response") return false;
      const response = message.response as Record<string, unknown> | undefined;
      if (!response) return true;
      const requestId = response.request_id as string | undefined;
      if (!requestId) return true;
      const pending = pendingControls.get(requestId);
      if (!pending) return true;
      pendingControls.delete(requestId);
      if (response.subtype === "success") {
        pending.resolve((response.response as Record<string, unknown>) ?? {});
      } else {
        pending.reject(new Error(`control request failed: ${String(response.subtype)}`));
      }
      return true;
    }

    function summarizeUnknownFrame(message: Record<string, unknown>) {
      const summary: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(message)) {
        if (!CONTROL_FRAME_KEYS.has(key)) continue;
        summary[key] = typeof value === "string" ? sanitizeString(value, 128) : value;
      }
      diagnostic("unknown_frame", `unhandled stdout frame type=${String(message.type)}`, {
        frame: sanitizeValue(summary),
      });
    }

    function clearTurnTimers(turn: ActiveTurn) {
      if (turn.idleTimer) clearTimeout(turn.idleTimer);
      if (turn.turnTimer) clearTimeout(turn.turnTimer);
    }

    function armIdleTimer(turn: ActiveTurn) {
      if (turn.idleTimer) clearTimeout(turn.idleTimer);
      turn.idleTimer = setTimeout(() => {
        terminateTurn(
          turn,
          "failed",
          makeError("STREAM_IDLE_TIMEOUT", "stream", "No protocol frames within the idle limit.", {
            driverId: "claude-stream-json",
            executionId: turn.executionId,
            participantId,
          }),
        );
      }, timeouts.streamIdleMs);
    }

    function emitTerminal(turn: ActiveTurn, event: DriverEvent) {
      clearTurnTimers(turn);
      if (activeTurn === turn) activeTurn = null;
      turn.emit(event);
      turn.resolve();
    }

    function terminateTurn(
      turn: ActiveTurn,
      kind: "failed" | "interrupted",
      error?: ReturnType<typeof makeError>,
      reason?: string,
    ) {
      if (activeTurn !== turn) return;
      if (kind === "failed" && error) {
        emitTerminal(turn, {
          type: "failed",
          error,
          dispatchState: turn.dispatchState,
          toolState: "none",
          retryable: error.retryable,
        });
      } else {
        emitTerminal(turn, {
          type: "interrupted",
          reason:
            (reason as "timeout" | "user_cancelled" | "driver_crash" | "unknown") ?? "unknown",
          dispatchState: turn.dispatchState,
          toolState: "none",
        });
      }
      if (state === "busy") state = "ready";
    }

    function verifyInitFrame(message: Record<string, unknown>): boolean {
      const arrays = ["tools", "mcp_servers", "skills", "slash_commands"] as const;
      for (const key of arrays) {
        const value = message[key];
        if (Array.isArray(value) && value.length > 0) return false;
        if (value === undefined || value === null) continue;
        if (!Array.isArray(value)) return false;
      }
      return true;
    }

    function handleSystemFrame(turn: ActiveTurn | null, message: Record<string, unknown>) {
      if (message.subtype === "init") {
        // The empty-surface contract is verified once per Execution Session;
        // later init frames of the same session carry no new information.
        if (initVerified) return;
        const ok = verifyInitFrame(message);
        if (!ok) {
          diagnostic(
            "init_not_empty",
            "system/init reported non-empty tools/mcp/skills/slash_commands",
          );
          if (turn) {
            terminateTurn(
              turn,
              "failed",
              makeError(
                "INCOMPATIBLE_DRIVER",
                "stream",
                "system/init reported tools/MCP/skills/slash commands; refusing execution.",
                { driverId: "claude-stream-json", executionId: turn.executionId, participantId },
              ),
            );
          }
          return;
        }
        initVerified = true;
        const initModel = typeof message.model === "string" ? message.model : null;
        if (initModel && canonicalModel && initModel !== canonicalModel) {
          diagnostic("init_model_drift", "system/init model differs from handshake catalog", {
            handshake: canonicalModel,
            init: sanitizeString(initModel, 128),
          });
        }
      }
      // Other system subtypes (status etc.) are informational.
    }

    function handleResultFrame(turn: ActiveTurn, message: Record<string, unknown>) {
      if (turn.cancelling) {
        terminateTurn(turn, "interrupted", undefined, "user_cancelled");
        return;
      }
      const subtype = typeof message.subtype === "string" ? message.subtype : "";
      const isError = message.is_error === true;
      const usage = (message.usage ?? {}) as Record<string, unknown>;
      const inputTokens =
        Number(usage.input_tokens ?? 0) +
        Number(usage.cache_read_input_tokens ?? 0) +
        Number(usage.cache_creation_input_tokens ?? 0);
      const outputTokens = Number(usage.output_tokens ?? 0);
      const costUsd = typeof message.total_cost_usd === "number" ? message.total_cost_usd : 0;
      const diff = {
        inputTokens: Math.max(0, inputTokens - lastCumulative.inputTokens),
        outputTokens: Math.max(0, outputTokens - lastCumulative.outputTokens),
        costUsd: Math.max(0, costUsd - lastCumulative.costUsd),
      };
      lastCumulative = { inputTokens, outputTokens, costUsd };
      turn.emit({ type: "usage", usage: diff } as DriverEvent);

      const modelUsage = (message.modelUsage ?? {}) as Record<string, unknown>;
      const effective = Object.keys(modelUsage)[0] ?? canonicalModel;
      const verdict =
        effective && effective === turn.modelId ? "match" : effective ? "mismatch" : "unknown";

      if (isError || subtype !== "success") {
        terminateTurn(
          turn,
          "failed",
          makeError(
            "DRIVER_CRASH",
            "stream",
            `result subtype=${subtype || "unknown"} is_error=true`,
            {
              driverId: "claude-stream-json",
              executionId: turn.executionId,
              participantId,
            },
          ),
        );
        return;
      }

      const output = typeof message.result === "string" ? message.result : "";
      if (output.trim().length === 0) {
        terminateTurn(
          turn,
          "failed",
          makeError("EMPTY_OUTPUT", "stream", "Completed with empty normalized output.", {
            driverId: "claude-stream-json",
            executionId: turn.executionId,
            participantId,
          }),
        );
        return;
      }

      emitTerminal(turn, {
        type: "completed",
        output,
        requestedModel: turn.modelId,
        effectiveModel: effective ?? null,
        modelVerdict: verdict as "match" | "mismatch" | "unknown",
        toolState: "none",
        dispatchState: "accepted",
        usage: diff,
        finalSeq: 0, // registry re-stamps
      } as DriverEvent);
      if (state === "busy") state = "ready";
    }

    function handleStreamEvent(turn: ActiveTurn, message: Record<string, unknown>) {
      const event = message.event as Record<string, unknown> | undefined;
      if (!event) return;
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          turn.sawAssistantText = true;
          turn.emit({ type: "output.delta", text: delta.text } as DriverEvent);
        }
      }
    }

    function handleReplayFrame(turn: ActiveTurn, message: Record<string, unknown>) {
      const uuid = (message.uuid ??
        (message.message as Record<string, unknown> | undefined)?.uuid) as string | undefined;
      if (uuid === turn.uuid && turn.dispatchState !== "accepted") {
        turn.dispatchState = "accepted";
        turn.acceptedAt = Date.now();
      }
    }

    function onFrame(message: Record<string, unknown>) {
      if (handleControlResponse(message)) return;
      const turn = activeTurn;
      if (turn) armIdleTimer(turn);
      switch (message.type) {
        case "system":
          handleSystemFrame(turn, message);
          return;
        case "user":
          if (turn) handleReplayFrame(turn, message);
          return;
        case "stream_event":
          if (turn) handleStreamEvent(turn, message);
          return;
        case "assistant":
          return; // deltas come from stream_event; assistant frames are informational
        case "result":
          if (turn) handleResultFrame(turn, message);
          else diagnostic("orphan_result", "result frame without an active turn");
          return;
        default:
          summarizeUnknownFrame(message);
      }
    }

    function onProcessExit(code: number | null, signal: string | null) {
      logger.warn("claude.process_exit", { participantId, code, signal });
      process = null;
      // An exit during an intentional close is not a session rebuild: close()
      // already accounts for that generation change.
      if (state !== "closing" && state !== "closed") {
        sessionEpoch += 1;
        state = "cold";
      }
      initVerified = false;
      failAllPendingControls(new Error("driver process exited"));
      const turn = activeTurn;
      if (turn) {
        terminateTurn(
          turn,
          "failed",
          makeError(
            "DRIVER_CRASH",
            "stream",
            `driver process exited (code=${code} signal=${signal})`,
            {
              driverId: "claude-stream-json",
              executionId: turn.executionId,
              participantId,
              retryable: turn.dispatchState === "not_dispatched",
            },
          ),
        );
      }
    }

    async function spawnAndHandshake(installation: PrewarmInput["installation"]): Promise<void> {
      const claudeComponent = installation.components.find((c) => c.role === "claude-binary");
      if (!claudeComponent) {
        throw Object.assign(new Error("cld composite installation is missing its claude binary"), {
          runtimeCode: "INSTALLATION_INVALID",
        });
      }
      const spec = installationRecordToSpec(installation);
      const cwd = join(workRoot, participantId);
      await mkdir(cwd, { recursive: true });
      const spawned = await supervisor.spawnDriver({
        participantId,
        executable: installation.realpath ?? spec,
        argv: buildArgv(persona),
        cwd,
        envInherit: ENV_INHERIT,
        envSet: {
          CLD_SKIP_UPDATE_CHECK: "1",
          CLD_CLAUDE_BIN: claudeComponent.path,
        },
      });
      process = spawned;
      spawned.stderr.on("data", (chunk: Buffer) => noteStderr(chunk.toString("utf8")));
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
            terminateTurn(
              turn,
              "failed",
              makeError("PROTOCOL_LIMIT", "stream", "NDJSON line exceeded the 8 MiB limit.", {
                driverId: "claude-stream-json",
                executionId: turn.executionId,
                participantId,
              }),
            );
          }
          void respawn("protocol_limit");
        },
        onEnd() {
          // stdout closed: process is exiting; exit handler covers state.
        },
      });

      await spawned.waitSupervised(timeouts.handshakeMs);
      const init = (await sendControl({ subtype: "initialize" })) as {
        models?: { value: string; resolvedModel?: string }[];
      };
      const models = Array.isArray(init.models) ? init.models : [];
      const resolved = models
        .map((m) => m?.resolvedModel)
        .filter((m): m is string => typeof m === "string" && m.length > 0);
      const defaultModel = models.find((m) => m.value === "default")?.resolvedModel ?? resolved[0];
      if (!defaultModel) {
        throw Object.assign(new Error("initialize returned no resolvable model"), {
          runtimeCode: "INCOMPATIBLE_DRIVER",
        });
      }
      const serves = ROUTES[route].servesModel;
      if (serves && !resolved.includes(serves)) {
        throw Object.assign(
          new Error(`route serves ${serves} but the handshake catalog lacks it`),
          {
            runtimeCode: "INCOMPATIBLE_DRIVER",
            // Diagnostics aid (provider-side drift): the set the route
            // actually serves right now.
            catalog: [...new Set(resolved)],
          },
        );
      }
      if (serves && serves !== defaultModel) {
        diagnostic(
          "canonical_from_route",
          `route verifiably serves ${serves}; catalog default is ${defaultModel}`,
        );
      }
      canonicalModel = serves ?? defaultModel;
      catalog = [...new Set(resolved)];
      state = "ready";
    }

    function installationRecordToSpec(installation: PrewarmInput["installation"]): string {
      if (!installation.realpath) {
        throw Object.assign(new Error("installation has no validated realpath"), {
          runtimeCode: "INSTALLATION_INVALID",
        });
      }
      return installation.realpath;
    }

    function buildArgv(persona: string | null): string[] {
      const route = currentRoute();
      const systemPrompt = persona ? `${persona}\n\n${DISCUSSION_CONTRACT}` : DISCUSSION_CONTRACT;
      return [
        ...ROUTES[route].argv,
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
        "--no-session-persistence",
        "--safe-mode",
        "--disable-slash-commands",
        "--no-chrome",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--tools",
        "",
        "--system-prompt",
        systemPrompt,
      ];
    }

    let route: ClaudeRoute = "ant-glm5.2";
    let persona: string | null = null;
    function currentRoute(): ClaudeRoute {
      return route;
    }

    async function respawn(reason: string): Promise<void> {
      logger.warn("claude.respawn", { participantId, reason });
      const old = process;
      process = null;
      sessionEpoch += 1;
      initVerified = false;
      if (old) {
        // Await the old process's full teardown BEFORE spawning: the
        // supervisor rejects a second live driver for the same participant,
        // and a stale exit event must never clobber the replacement process.
        await old.shutdown(timeouts.shutdownGraceMs).catch(() => undefined);
      }
      if (state !== "closing" && state !== "closed" && lastInstallation) {
        state = "starting";
        await spawnAndHandshake(lastInstallation);
      }
    }

    let lastInstallation: PrewarmInput["installation"] | null = null;

    async function runTurn(input: ExecuteInput, emit: Emit, emitStarted: boolean): Promise<void> {
      if (!process || state !== "ready") {
        // Nothing was dispatched: surface a retryable terminal so the execute
        // loop can apply the safe-retry-once policy (respawn + one retry).
        emit({
          type: "failed",
          error: makeError("DRIVER_CRASH", "dispatch", "driver process is not running", {
            driverId: "claude-stream-json",
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
      const uuid = randomUUID();
      await new Promise<void>((resolvePromise) => {
        const turn: ActiveTurn = {
          executionId: input.executionId,
          uuid,
          modelId: input.modelId,
          emit,
          dispatchState: "not_dispatched",
          sawAssistantText: false,
          resolve: resolvePromise,
        };
        activeTurn = turn;
        if (emitStarted) {
          emit({ type: "started", requestedModel: input.modelId } as DriverEvent);
        }
        armIdleTimer(turn);
        turn.turnTimer = setTimeout(() => {
          terminateTurn(turn, "interrupted", undefined, "timeout");
          void respawn("turn_timeout");
        }, timeouts.turnMs);

        const frame = JSON.stringify({
          type: "user",
          message: { role: "user", content: input.prompt },
          uuid,
        });
        process?.stdin.write(`${frame}\n`, (error) => {
          if (error) {
            terminateTurn(
              turn,
              "failed",
              makeError("DRIVER_CRASH", "dispatch", `stdin write failed: ${error.message}`, {
                driverId: "claude-stream-json",
                executionId: turn.executionId,
                participantId,
                retryable: true,
              }),
            );
            return;
          }
          // Bytes left the Host; acceptance = replay within the dispatch window.
          turn.dispatchState = "unknown";
          setTimeout(() => {
            if (activeTurn === turn && turn.dispatchState === "unknown") {
              // No replay in time: the CLI may or may not have enqueued it.
              terminateTurn(
                turn,
                "failed",
                makeError(
                  "DISPATCH_TIMEOUT",
                  "dispatch",
                  "No enqueue replay within the dispatch window.",
                  {
                    driverId: "claude-stream-json",
                    executionId: turn.executionId,
                    participantId,
                  },
                ),
              );
              void respawn("dispatch_timeout");
            }
          }, timeouts.dispatchAckMs);
        });
      });
    }

    return {
      participantId,
      driverId: "claude-stream-json",
      get sessionEpoch() {
        return sessionEpoch;
      },

      async prewarm(input: PrewarmInput): Promise<PrewarmResult> {
        if (input.spec.profile.driverId !== "claude-stream-json") {
          throw Object.assign(new Error("profile driver mismatch"), {
            runtimeCode: "PROFILE_INVALID",
          });
        }
        route = input.spec.profile.options.route;
        persona = input.spec.personaPrompt ?? null;
        lastInstallation = input.installation;
        if (state === "ready" || state === "busy") {
          // Idempotent prewarm: re-handshake only after a crash.
          return {
            canonicalModelId: canonicalModel ?? input.spec.modelId,
            modelAliases: ["default"],
            capability: { protocol: "claude-stream-json", controlInitialize: true },
            catalog,
          };
        }
        state = "starting";
        try {
          await spawnAndHandshake(input.installation);
        } catch (error) {
          state = "cold";
          throw error;
        }
        return {
          canonicalModelId: canonicalModel ?? input.spec.modelId,
          modelAliases: ["default"],
          capability: { protocol: "claude-stream-json", controlInitialize: true },
          catalog,
        };
      },

      async execute(input: ExecuteInput, emit: Emit): Promise<void> {
        if (activeTurn) {
          throw Object.assign(new Error("participant busy"), { runtimeCode: "PARTICIPANT_BUSY" });
        }
        // Driver retry policy: exactly one in-place retry when dispatch
        // provably never happened (tools are verified empty, so a pre-dispatch
        // retry has no side effects).
        let attempt = 0;
        for (;;) {
          attempt += 1;
          let failedRetryable = false;
          const emitWrapper: Emit = (event) => {
            if (
              event.type === "failed" &&
              event.dispatchState === "not_dispatched" &&
              event.retryable &&
              attempt === 1
            ) {
              failedRetryable = true;
              return; // swallow first-attempt safe failure; retry below
            }
            emit(event);
          };
          await runTurn(input, emitWrapper, attempt === 1);
          if (!failedRetryable || attempt >= 2) return;
          logger.warn("claude.retry_once", { participantId, executionId: input.executionId });
          if (!process) {
            try {
              await respawn("safe_retry");
            } catch {
              emit({
                type: "failed",
                error: makeError(
                  "DRIVER_SPAWN_FAILED",
                  "dispatch",
                  "respawn failed during safe retry",
                  {
                    driverId: "claude-stream-json",
                    executionId: input.executionId,
                    participantId,
                  },
                ),
                dispatchState: "not_dispatched",
                toolState: "none",
                retryable: false,
              } as DriverEvent);
              return;
            }
          }
        }
      },

      async cancel(executionId: string): Promise<void> {
        const turn = activeTurn;
        if (!turn || turn.executionId !== executionId) return;
        turn.cancelling = true;
        try {
          await sendControl({ subtype: "interrupt" });
        } catch {
          // fall through to escalation
        }
        const deadline = Date.now() + timeouts.interruptGraceMs;
        while (activeTurn === turn && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (activeTurn === turn) {
          process?.kill("SIGKILL");
          terminateTurn(turn, "interrupted", undefined, "user_cancelled");
          await respawn("cancel_escalation").catch(() => undefined);
        } else {
          // The CLI produced its own terminal for the interrupt; normalize the
          // user-facing outcome as cancelled only if it ended without output.
        }
      },

      async close(): Promise<void> {
        state = "closing";
        const turn = activeTurn;
        if (turn) {
          try {
            await sendControl({ subtype: "interrupt" });
          } catch {
            // best effort
          }
        }
        const current = process;
        process = null;
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
        // The claude handshake carries no window metadata; the route table
        // declares the provider's window class instead of falling back to the
        // plan's 64k unknown-window default (which false-throttles long
        // rooms into spurious needs_rebase pauses).
        return ROUTES[currentRoute()].contextWindowTokens ?? null;
      },
    };
  };
}
