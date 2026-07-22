import { digestOf } from "@/models/discussion/factories";
/**
 * Agent 真实模型调用测试 helper（V1.1 §2 / plan-a §3）。
 *
 * 框架无关、不依赖 React/Dexie/Host 新端点：输入 RuntimeClient + Profile DTO +
 * modelId + persona，驱动 createScope → activateScope → execute → SSE 终态 →
 * ack（committed/discarded）→ closeScope 的完整生命周期，返回终态证据与错误
 * 分类。60s 总超时覆盖全阶段；任何路径不泄漏 scope/进程；结果不落 Dexie。
 *
 * 复用既有 scope/execute/SSE/ack 口径，但完全不读 Dexie/不创建
 * Room/Participant/ModelExecution 行——一次性单 participant scope。
 */
import { type RuntimeClient, RuntimeClientError } from "@/runtime/client";
import { type FollowEventsOptions, followExecutionEvents } from "@/runtime/event-stream";
import type { ToolState } from "@shared/runtime/contracts";
import type {
  CompletedEvent,
  FailedEvent,
  InterruptedEvent,
  ModelVerdict,
  RuntimeEvent,
  Usage,
} from "@shared/runtime/events";
import type { ContextSnapshot, ExecutionProfileDto, SnapshotItem } from "@shared/runtime/schemas";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AgentRealCallVerdict = "completed" | "failed" | "interrupted" | "timeout" | "cancelled";

export type AgentRealCallErrorCategory =
  | "auth"
  | "installation"
  | "model_unavailable"
  | "timeout"
  | "quota"
  | "crash";

export interface AgentRealCallError {
  category: AgentRealCallErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
}

export interface AgentRealCallResult {
  verdict: AgentRealCallVerdict;
  canonical: string | null;
  effective: string | null;
  modelVerdict: ModelVerdict | null;
  toolState: ToolState | null;
  ttftMs: number | null;
  totalMs: number;
  outputPreview: string;
  usage: Usage | null;
  error: AgentRealCallError | null;
}

export interface AgentRealCallInput {
  client: RuntimeClient;
  profile: ExecutionProfileDto;
  modelId: string;
  persona: string;
  signal?: AbortSignal;
  /** 默认 60_000。 */
  timeoutMs?: number;
  idFactory?: () => string;
  now?: () => number;
  /** 注入式 SSE 跟随器，便于单测替换。 */
  followEvents?: typeof followExecutionEvents;
}

/** outputPreview 按 Unicode code point 截断的最大长度。 */
export const AGENT_REAL_CALL_PREVIEW_MAX = 500;

/** 探针指令逐字（plan-a §3 / Q16）。 */
const PROBE_INSTRUCTION = "Reply with exactly: COUNCILKIT_OK";

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function runAgentRealCallTest(input: AgentRealCallInput): Promise<AgentRealCallResult> {
  const now = input.now ?? Date.now;
  const ids = input.idFactory ?? (() => crypto.randomUUID());
  const timeoutMs = input.timeoutMs ?? 60_000;

  return runInternal({
    client: input.client,
    profile: input.profile,
    modelId: input.modelId,
    persona: input.persona,
    externalSignal: input.signal,
    timeoutMs,
    ids,
    now,
    follow: input.followEvents ?? followExecutionEvents,
  });
}

// ---------------------------------------------------------------------------
// Internal driver
// ---------------------------------------------------------------------------

interface RunParams {
  client: RuntimeClient;
  profile: ExecutionProfileDto;
  modelId: string;
  persona: string;
  externalSignal?: AbortSignal;
  timeoutMs: number;
  ids: () => string;
  now: () => number;
  follow: typeof followExecutionEvents;
}

async function runInternal(params: RunParams): Promise<AgentRealCallResult> {
  const { client, profile, modelId, persona, externalSignal, timeoutMs, ids, now, follow } = params;
  const startedAtMs = now();

  // Stable idents up-front: a lost create response is recovered idempotently by
  // re-using the same scopeRequestId.
  const scopeRequestId = ids();
  const participantId = ids();
  const executionId = ids();

  // Combined deadline: internal timer merges with the external signal.
  const timeoutController = new AbortController();
  const onExternalAbort = () => timeoutController.abort(externalSignal?.reason ?? "external");
  if (externalSignal?.aborted) timeoutController.abort("external");
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeoutTimer = setTimeout(() => timeoutController.abort("timeout"), timeoutMs);
  const deadline = timeoutController.signal;
  const reasonOf = (): "timeout" | "cancelled" =>
    deadline.reason === "timeout" ? "timeout" : "cancelled";

  let ttftMs: number | null = null;
  let dispatched = false;
  let ackDone = false;
  const owned: { scopeId?: string; controllerId?: string; leaseEpoch?: number } = {};
  const token = () => ({
    controllerId: owned.controllerId as string,
    leaseEpoch: owned.leaseEpoch as number,
  });
  const snapshot = buildProbeSnapshot({ participantId, persona });
  // ACK at most once across the run's terminal path.
  const ackOnce = async (
    disposition: "committed" | "discarded",
    finalSeq: number,
  ): Promise<boolean> => {
    if (!owned.scopeId || ackDone) return false;
    ackDone = true;
    try {
      const resp = await client.ack(
        owned.scopeId,
        executionId,
        { ...token(), finalSeq: Math.max(1, finalSeq), disposition },
        { signal: deadline },
      );
      return resp.ackState === "acknowledged";
    } catch {
      return false;
    }
  };

  let result: AgentRealCallResult | undefined;

  const make = (
    verdict: AgentRealCallVerdict,
    error: AgentRealCallError | null,
    partial: Partial<AgentRealCallResult> = {},
  ): AgentRealCallResult => ({
    verdict,
    canonical: partial.canonical ?? null,
    effective: partial.effective ?? null,
    modelVerdict: partial.modelVerdict ?? null,
    toolState: partial.toolState ?? null,
    ttftMs,
    totalMs: now() - startedAtMs,
    outputPreview: partial.outputPreview ?? "",
    usage: partial.usage ?? null,
    error,
  });

  try {
    // --- create -----------------------------------------------------------
    let created: Awaited<ReturnType<RuntimeClient["createScope"]>>;
    try {
      created = await client.createScope(
        {
          scopeRequestId,
          participants: [{ participantId, profile, modelId, personaPrompt: persona || undefined }],
        },
        { signal: deadline },
      );
    } catch (error) {
      if (deadline.aborted) {
        // create lost/timed out: idempotent recovery, close, then classify.
        await recoverAndClose({ client, scopeRequestId, profile, modelId, persona, participantId });
        result = make(
          reasonOf() === "timeout" ? "timeout" : "cancelled",
          reasonOf() === "timeout"
            ? makeTimeoutError()
            : {
                category: "crash",
                code: "CANCELLED",
                message: "cancelled by caller",
                retryable: false,
              },
        );
      } else {
        result = make("failed", classifyClientError(error));
      }
      return result;
    }
    owned.scopeId = created.scopeId;
    owned.controllerId = created.controllerId;
    owned.leaseEpoch = created.leaseEpoch;
    const canonical =
      created.scope.participants.find((p) => p.participantId === participantId)?.binding
        ?.canonicalModelId ?? null;

    if (deadline.aborted) {
      result = make(reasonOf() === "timeout" ? "timeout" : "cancelled", makeTimeoutError(), {
        canonical,
      });
      return result;
    }

    // --- activate ---------------------------------------------------------
    let activated: Awaited<ReturnType<RuntimeClient["activateScope"]>>;
    try {
      activated = await client.activateScope(created.scopeId, token(), { signal: deadline });
    } catch (error) {
      result = make("failed", classifyClientError(error), { canonical });
      return result;
    }
    const ap = activated.participants.find((p) => p.participantId === participantId);
    const gate = gateParticipant(ap);
    if (gate) {
      result = make(gate.verdict, gate.error, { canonical });
      return result;
    }
    if (deadline.aborted) {
      result = make(reasonOf() === "timeout" ? "timeout" : "cancelled", makeTimeoutError(), {
        canonical,
      });
      return result;
    }

    // --- execute ----------------------------------------------------------
    try {
      await client.execute(
        created.scopeId,
        { ...token(), executionId, participantId, snapshot },
        { signal: deadline },
      );
      dispatched = true;
    } catch (error) {
      result = make(
        deadline.aborted && reasonOf() === "timeout" ? "timeout" : "failed",
        deadline.aborted && reasonOf() === "timeout"
          ? makeTimeoutError()
          : classifyClientError(error, { dispatch: true }),
        { canonical },
      );
      return result;
    }

    // --- follow SSE -------------------------------------------------------
    const terminal = await driveToTerminal({
      client,
      scopeId: created.scopeId,
      executionId,
      follow,
      deadlineSignal: deadline,
      onEvent: (event) => {
        if (ttftMs === null && isOutputEvent(event)) ttftMs = now() - startedAtMs;
      },
    });

    if (terminal.kind === "aborted") {
      // Abort during streaming: cancel an in-flight execution, then settle.
      if (dispatched) {
        await client.cancelExecution(created.scopeId, executionId, token()).catch(() => undefined);
      }
      result = make(
        reasonOf() === "timeout" ? "timeout" : "cancelled",
        reasonOf() === "timeout"
          ? makeTimeoutError()
          : {
              category: "crash",
              code: "CANCELLED",
              message: "cancelled by caller",
              retryable: false,
            },
        { canonical },
      );
      return result;
    }

    if (terminal.kind === "closed") {
      result = await handleStreamReconnect({ canonical, make });
      return result;
    }

    result = await handleTerminalEvent({
      event: terminal.event,
      canonical,
      ack: ackOnce,
      make,
      now,
      startedAtMs,
      getTtft: () => ttftMs,
    });
    return result;
  } catch (error) {
    // Defensive catch-all: classify and let finally close.
    result = make(
      deadline.aborted && reasonOf() === "timeout" ? "timeout" : "failed",
      classifyClientError(error),
    );
    return result;
  } finally {
    clearTimeout(timeoutTimer);
    // closeScope must run exactly once with an independent cleanup signal so an
    // already-aborted deadline signal cannot prevent the close request.
    const cleanupController = new AbortController();
    if (owned.scopeId && owned.controllerId && owned.leaseEpoch !== undefined) {
      try {
        await client.closeScope(owned.scopeId, token(), { signal: cleanupController.signal });
      } catch {
        // close failure: mutate the to-be-returned result object (the try block
        // already captured the same reference, so a reassign would not propagate)
        // to downgrade a completed verdict to crash-failure so the UI can flag
        // diagnostics (plan-a §3: not swallowed silently).
        if (result && result.verdict === "completed") {
          result.verdict = "failed";
          result.error = {
            category: "crash",
            code: "SCOPE_CLOSE_FAILED",
            message: "scope could not be closed after the call",
            retryable: false,
          };
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal handling
// ---------------------------------------------------------------------------

async function handleTerminalEvent(input: {
  event: RuntimeEvent;
  canonical: string | null;
  ack: (disposition: "committed" | "discarded", finalSeq: number) => Promise<boolean>;
  make: (
    verdict: AgentRealCallVerdict,
    error: AgentRealCallError | null,
    partial?: Partial<AgentRealCallResult>,
  ) => AgentRealCallResult;
  now: () => number;
  startedAtMs: number;
  getTtft: () => number | null;
}): Promise<AgentRealCallResult> {
  const { event, canonical, ack, make, now, startedAtMs, getTtft } = input;

  if (event.type === "completed") {
    const completed = event as CompletedEvent;
    const output = completed.output ?? "";
    if (output.trim().length === 0) {
      await ack("discarded", completed.seq);
      return make(
        "failed",
        {
          category: "crash",
          code: "EMPTY_OUTPUT",
          message: "model returned an empty output",
          retryable: false,
        },
        {
          canonical: canonical ?? completed.requestedModel,
          effective: completed.effectiveModel,
          modelVerdict: completed.modelVerdict,
          toolState: completed.toolState,
          // final-only completed: TTFT = terminal arrival time.
          ttftMs: getTtft() ?? now() - startedAtMs,
          usage: completed.usage,
        },
      );
    }
    const ackOk = await ack("committed", completed.seq);
    if (!ackOk) {
      return make(
        "failed",
        {
          category: "crash",
          code: "ACK_FAILED",
          message: "ACK did not reach the acknowledged state",
          retryable: true,
        },
        {
          canonical: canonical ?? completed.requestedModel,
          effective: completed.effectiveModel,
          modelVerdict: completed.modelVerdict,
          toolState: completed.toolState,
          usage: completed.usage,
          outputPreview: truncatePreview(output),
        },
      );
    }
    return make("completed", null, {
      canonical: canonical ?? completed.requestedModel,
      effective: completed.effectiveModel,
      modelVerdict: completed.modelVerdict,
      toolState: completed.toolState,
      usage: completed.usage,
      outputPreview: truncatePreview(output),
    });
  }

  if (event.type === "failed") {
    const failed = event as FailedEvent;
    await ack("discarded", failed.seq).catch(() => undefined);
    return make("failed", classifyTerminalError(failed.error), {
      canonical,
    });
  }

  // interrupted
  const interrupted = event as InterruptedEvent;
  await ack("discarded", interrupted.seq).catch(() => undefined);
  return make("interrupted", classifyInterrupt(interrupted), { canonical });
}

// ---------------------------------------------------------------------------
// SSE driving + reconnect (mirrors orchestrator driveToTerminal semantics)
// ---------------------------------------------------------------------------

type TerminalOutcome =
  | { kind: "terminal"; event: RuntimeEvent }
  | { kind: "closed"; afterSeq: number }
  | { kind: "aborted" };

async function driveToTerminal(input: {
  client: RuntimeClient;
  scopeId: string;
  executionId: string;
  follow: typeof followExecutionEvents;
  deadlineSignal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
}): Promise<TerminalOutcome> {
  const { client, scopeId, executionId, follow, deadlineSignal, onEvent } = input;
  let resumeAt = 0;
  for (;;) {
    const fetchInput = client.eventStreamFetch({ scopeId, executionId, afterSeq: resumeAt });
    const options: FollowEventsOptions = {
      fetchInput,
      onEvent,
      signal: deadlineSignal,
    };
    const outcome = await follow(options);
    if (outcome.kind === "terminal") return { kind: "terminal", event: outcome.event };
    if (outcome.kind === "aborted") return { kind: "aborted" };
    // closed without terminal: re-read the Host record to decide resume vs terminal.
    resumeAt = outcome.lastSeq;
    let state: Awaited<ReturnType<RuntimeClient["getExecution"]>> | null = null;
    try {
      state = await client.getExecution(scopeId, executionId, { signal: deadlineSignal });
    } catch {
      state = null;
    }
    if (deadlineSignal.aborted) return { kind: "aborted" };
    if (!state) return { kind: "closed", afterSeq: resumeAt };
    // Both "still running" and "Host terminal not yet replayed" cases re-follow
    // from afterSeq on the next iteration (execute is NEVER re-dispatched —
    // reconnect only) until a terminal arrives.
  }
}

async function handleStreamReconnect(input: {
  canonical: string | null;
  make: (
    verdict: AgentRealCallVerdict,
    error: AgentRealCallError | null,
    partial?: Partial<AgentRealCallResult>,
  ) => AgentRealCallResult;
}): Promise<AgentRealCallResult> {
  const { canonical, make } = input;
  // Stream closed and getExecution returned nothing usable: treat as crash — no
  // re-dispatch is allowed (execute at most once).
  return make(
    "failed",
    {
      category: "crash",
      code: "STREAM_CLOSED",
      message: "event stream closed before a terminal arrived and the execution was lost",
      retryable: false,
    },
    { canonical },
  );
}

// ---------------------------------------------------------------------------
// Idempotent create recovery
// ---------------------------------------------------------------------------

async function recoverAndClose(input: {
  client: RuntimeClient;
  scopeRequestId: string;
  profile: ExecutionProfileDto;
  modelId: string;
  persona: string;
  participantId: string;
}): Promise<void> {
  const { client, scopeRequestId, profile, modelId, persona, participantId } = input;
  // Use an independent cleanup signal so a pre-aborted deadline cannot block.
  const cleanup = new AbortController();
  try {
    const recovered = await client.createScope(
      {
        scopeRequestId,
        participants: [{ participantId, profile, modelId, personaPrompt: persona || undefined }],
      },
      { signal: cleanup.signal },
    );
    await client
      .closeScope(
        recovered.scopeId,
        { controllerId: recovered.controllerId, leaseEpoch: recovered.leaseEpoch },
        { signal: cleanup.signal },
      )
      .catch(() => undefined);
  } catch {
    // If the first create never landed, the recovery create succeeds and is
    // closed; if it landed, the Host returns the same scopeId and we close it.
    // Best-effort, never rethrow.
  }
}

// ---------------------------------------------------------------------------
// Participant readiness gating (activate-time)
// ---------------------------------------------------------------------------

function gateParticipant(
  status:
    | {
        runtime?: string;
        binding?: { canonicalModelId?: string } | null;
        readiness?: { state?: string | null; detail?: string | null } | null;
      }
    | undefined,
): { verdict: AgentRealCallVerdict; error: AgentRealCallError } | null {
  if (!status) return null;
  const readiness = status.readiness?.state;
  if (readiness === "ready") return null;
  if (readiness === "invalid_binding") {
    return {
      verdict: "failed",
      error: {
        category: "installation",
        code: "INVALID_BINDING",
        message: status.readiness?.detail ?? "installation/binding invalid",
        retryable: false,
      },
    };
  }
  if (readiness === "model_unavailable") {
    return {
      verdict: "failed",
      error: {
        category: "model_unavailable",
        code: "MODEL_UNAVAILABLE",
        message: status.readiness?.detail ?? "selected modelId not in the driver catalog",
        retryable: false,
      },
    };
  }
  if (readiness === "runtime_unavailable") {
    const detail = (status.readiness?.detail ?? "").toLowerCase();
    const authKeywords = ["auth", "login", "unauthenticated", "forbidden"];
    if (authKeywords.some((keyword) => detail.includes(keyword))) {
      return {
        verdict: "failed",
        error: {
          category: "auth",
          code: "AUTH_REQUIRED",
          message: status.readiness?.detail ?? "local CLI not authenticated",
          retryable: false,
        },
      };
    }
    return {
      verdict: "failed",
      error: {
        category: "crash",
        code: "RUNTIME_UNAVAILABLE",
        message: status.readiness?.detail ?? "runtime unavailable",
        retryable: false,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyClientError(
  error: unknown,
  opts: { dispatch?: boolean } = {},
): AgentRealCallError {
  if (error instanceof RuntimeClientError) {
    return classifyCode(error.code, error.status, error.message);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return {
      category: "timeout",
      code: "ABORT",
      message: error.message || "request aborted",
      retryable: true,
    };
  }
  return {
    category: "crash",
    code: opts.dispatch ? "DISPATCH_FAILED" : "RUNTIME_UNAVAILABLE",
    message: errorMessageOf(error),
    retryable: false,
  };
}

function classifyTerminalError(error: {
  code: string;
  message: string;
  retryable: boolean;
}): AgentRealCallError {
  return classifyCode(error.code, 0, error.message, error.retryable);
}

function classifyInterrupt(event: InterruptedEvent): AgentRealCallError {
  switch (event.reason) {
    case "timeout":
      return {
        category: "timeout",
        code: "TURN_TIMEOUT",
        message: "turn timed out",
        retryable: true,
      };
    case "host_shutdown":
      return {
        category: "crash",
        code: "HOST_SHUTDOWN",
        message: "host shutdown",
        retryable: false,
      };
    case "supervisor_lost":
      return {
        category: "crash",
        code: "SUPERVISOR_LOST",
        message: "supervisor lost",
        retryable: false,
      };
    case "driver_crash":
      return {
        category: "crash",
        code: "DRIVER_CRASH",
        message: "driver crashed",
        retryable: false,
      };
    case "user_cancelled":
      return {
        category: "crash",
        code: "USER_CANCELLED",
        message: "cancelled by user",
        retryable: false,
      };
    default:
      return { category: "crash", code: "INTERRUPTED", message: "interrupted", retryable: false };
  }
}

function classifyCode(
  code: string,
  status: number,
  message: string,
  retryable = false,
): AgentRealCallError {
  const c = code;
  if (
    c === "UNAUTHENTICATED" ||
    c === "FORBIDDEN" ||
    c === "CSRF_MISMATCH" ||
    c === "AUTH_REQUIRED" ||
    c === "STALE_CONTROLLER"
  ) {
    return { category: "auth", code: c, message, retryable: false };
  }
  if (
    c === "INSTALLATION_NOT_FOUND" ||
    c === "INSTALLATION_INVALID" ||
    c === "INSTALLATION_CHANGED" ||
    c === "INSTALLATION_UNTRUSTED" ||
    c === "PROFILE_INVALID" ||
    c === "INCOMPATIBLE_DRIVER"
  ) {
    return { category: "installation", code: c, message, retryable: false };
  }
  if (c === "MODEL_UNAVAILABLE" || c === "MODEL_MISMATCH") {
    return { category: "model_unavailable", code: c, message, retryable: false };
  }
  if (
    c === "HANDSHAKE_TIMEOUT" ||
    c === "DISPATCH_TIMEOUT" ||
    c === "STREAM_IDLE_TIMEOUT" ||
    c === "STREAM_DRAIN_TIMEOUT" ||
    c === "TURN_TIMEOUT"
  ) {
    return { category: "timeout", code: c, message, retryable: retryable || true };
  }
  if (
    c === "RESOURCE_LIMIT" ||
    c === "RATE_LIMITED" ||
    c === "PARTICIPANT_BUSY" ||
    status === 429
  ) {
    return { category: "quota", code: c, message, retryable: retryable || true };
  }
  // Crash bucket (default fallback): driver spawn/protocol/internal/unknown.
  return { category: "crash", code: c || "CRASH", message, retryable };
}

function makeTimeoutError(): AgentRealCallError {
  return {
    category: "timeout",
    code: "DEADLINE_TIMEOUT",
    message: "60s deadline exceeded",
    retryable: true,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isOutputEvent(event: RuntimeEvent): boolean {
  return (
    event.type === "output.delta" || event.type === "output.snapshot" || event.type === "completed"
  );
}

/** Truncate to AGENT_REAL_CALL_PREVIEW_MAX Unicode code points, append ellipsis. */
function truncatePreview(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= AGENT_REAL_CALL_PREVIEW_MAX) return text;
  return `${chars.slice(0, AGENT_REAL_CALL_PREVIEW_MAX).join("")}…`;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildProbeSnapshot(input: { participantId: string; persona: string }): ContextSnapshot {
  const instruction = { kind: "message" as const, text: PROBE_INSTRUCTION };
  const instructionDigest = digestOf({
    digestVersion: 1,
    kind: instruction.kind,
    text: instruction.text,
  });
  const items: SnapshotItem[] = [];
  const participantSnapshotDigest = digestOf({
    digestVersion: 1,
    personaPrompt: input.persona || undefined,
  });
  return {
    digestVersion: 1,
    roomContext: {
      contextRevision: 0,
      contextDigest: digestOf({ digestVersion: 1, topic: "", background: "", items }),
      items,
    },
    participant: {
      participantId: input.participantId,
      participantSnapshotDigest,
      ...(input.persona ? { personaPrompt: input.persona } : {}),
    },
    instruction: {
      kind: instruction.kind,
      instructionDigest,
      text: instruction.text,
    },
  };
}

// Silent type re-exports to keep imports used under isolatedModules.
export type { CompletedEvent, FailedEvent, InterruptedEvent, ModelVerdict, Usage };
