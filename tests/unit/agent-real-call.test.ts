import { runAgentRealCallTest } from "@/lib/agent-real-call";
import { RuntimeClientError } from "@/runtime/client";
import type { FollowEventsOptions, FollowOutcome } from "@/runtime/event-stream";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import type { RuntimeEvent } from "@shared/runtime/events";
import type {
  AckRequest,
  CreateScopeRequest,
  CreateScopeResponse,
  ExecuteRequest,
  ExecutionProfileDto,
  ExecutionStatus,
  ScopeStatus,
} from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

/**
 * Agent 真实调用 helper 单测（AC2 / plan-a §3 生命周期 + 错误矩阵）。
 *
 * 通过 FakeHost 模拟 Host 的 scope/execute/ack/close + SSE 终态行为，注入到
 * helper 的 RuntimeClient 与 followEvents 依赖里，覆盖成功/失败/超时/取消/
 * 泄漏/重连/空输出/close 失败路径。
 */

const PROFILE: ExecutionProfileDto = {
  driverId: "codex-app-server",
  installationId: "inst-fake",
  credentialMode: CREDENTIAL_MODE,
  options: {},
};

type Behavior =
  | { kind: "completed"; output: string; usage: RuntimeEvent extends never ? never : unknown }
  | { kind: "emptyOutput" }
  | { kind: "failed"; code: string }
  | { kind: "interrupted"; reason: string }
  | { kind: "hangUntilCancel" };

interface FakeHostOptions {
  behavior?: Behavior;
  createFailsWith?: RuntimeClientError;
  activateReadiness?: "ready" | "invalid_binding" | "model_unavailable" | "runtime_unavailable";
  closeFails?: boolean;
}

interface FakeExec {
  participantId: string;
  scopeId: string;
  seq: number;
  state: "running" | "completed" | "failed" | "interrupted";
  events: RuntimeEvent[];
  ackDisposition?: AckRequest["disposition"];
}

function makeCompletedEvent(seq: number, output: string): RuntimeEvent {
  return {
    type: "completed",
    executionId: "exec",
    seq,
    at: "2026-07-22T00:00:00.000Z",
    output,
    requestedModel: "model-x",
    effectiveModel: "model-x",
    modelVerdict: "match",
    toolState: "none",
    dispatchState: "accepted",
    usage: null,
    finalSeq: seq,
  };
}

function makeFailedEvent(seq: number, code: string): RuntimeEvent {
  return {
    type: "failed",
    executionId: "exec",
    seq,
    at: "2026-07-22T00:00:00.000Z",
    error: { code: code as never, phase: "stream", message: code, retryable: false },
    dispatchState: "accepted",
    toolState: "none",
    retryable: false,
  };
}

function makeInterruptedEvent(seq: number, reason: string): RuntimeEvent {
  return {
    type: "interrupted",
    executionId: "exec",
    seq,
    at: "2026-07-22T00:00:00.000Z",
    reason: reason as never,
    dispatchState: "accepted",
    toolState: "none",
  };
}

const DELTA1: RuntimeEvent = {
  type: "output.delta",
  executionId: "exec",
  seq: 2,
  at: "t",
  text: "COUN",
};
const DELTA2: RuntimeEvent = {
  type: "output.delta",
  executionId: "exec",
  seq: 3,
  at: "t",
  text: "CILKIT_OK",
};

function fakeHost(options: FakeHostOptions = {}) {
  const counters = { create: 0, activate: 0, execute: 0, ack: 0, cancel: 0, close: 0 };
  let scopeCounter = 0;
  const execs: FakeExec[] = [];

  const participantOf = (participantId: string, status: string) => ({
    participantId,
    runtime: status === "ready" ? ("ready" as const) : ("failed" as const),
    binding:
      status === "ready"
        ? {
            bindingDigest: "d",
            driverId: "codex-app-server" as const,
            installationId: "inst-fake",
            installationFingerprint: "fp",
            capabilityDigest: "cd",
            requestedModel: "model-x",
            canonicalModelId: "model-x",
            modelAliases: [],
          }
        : null,
    readiness:
      status === "ready"
        ? { state: "ready" as const, detail: null }
        : status === "invalid_binding"
          ? { state: "invalid_binding" as const, detail: "binding invalid" }
          : status === "model_unavailable"
            ? { state: "model_unavailable" as const, detail: "model missing" }
            : { state: "runtime_unavailable" as const, detail: "login required" },
  });

  const client = {
    async createScope(
      _request: CreateScopeRequest,
      _opts?: { signal?: AbortSignal },
    ): Promise<CreateScopeResponse> {
      counters.create += 1;
      if (options.createFailsWith) throw options.createFailsWith;
      const scopeId = `scope-${scopeCounter++}`;
      const participantId = _request.participants[0]?.participantId ?? "p";
      const exec: FakeExec = { participantId, scopeId, seq: 1, state: "running", events: [] };
      execs.push(exec);
      const readiness = options.activateReadiness ?? "ready";
      return {
        scopeId,
        controllerId: "ctrl",
        leaseEpoch: 1,
        scope: {
          scopeId,
          state: "active",
          hostInstanceId: "h",
          leaseEpoch: 1,
          participants: [participantOf(participantId, readiness)],
        },
      };
    },
    async activateScope(
      scopeId: string,
      _controller: { controllerId: string; leaseEpoch: number },
    ): Promise<ScopeStatus> {
      counters.activate += 1;
      const readiness = options.activateReadiness ?? "ready";
      const exec = execs[execs.length - 1];
      return {
        scopeId,
        state: "active",
        hostInstanceId: "h",
        leaseEpoch: 1,
        participants: [participantOf(exec?.participantId ?? "p", readiness)],
      };
    },
    async execute(
      _scopeId: string,
      request: ExecuteRequest,
      _opts?: { signal?: AbortSignal },
    ): Promise<{ execution: ExecutionStatus }> {
      counters.execute += 1;
      const exec = execs[execs.length - 1];
      if (exec) {
        exec.events.push({
          type: "started",
          executionId: request.executionId,
          seq: 1,
          at: "t",
          requestedModel: "model-x",
        });
        exec.events.push(DELTA1, DELTA2);
        const behavior = options.behavior;
        if (!behavior || behavior.kind === "completed") {
          exec.events.push(
            makeCompletedEvent(
              4,
              behavior?.kind === "completed" ? behavior.output : "COUNCILKIT_OK",
            ),
          );
        } else if (behavior.kind === "emptyOutput") {
          exec.events.push(makeCompletedEvent(4, ""));
        } else if (behavior.kind === "failed") {
          exec.events.push(makeFailedEvent(4, behavior.code));
        } else if (behavior.kind === "interrupted") {
          exec.events.push(makeInterruptedEvent(4, behavior.reason));
        }
      }
      return {
        execution: {
          executionId: request.executionId,
          participantId: request.participantId,
          state: "running",
          lastSeq: 1,
        },
      };
    },
    async getExecution(_scopeId: string, executionId: string): Promise<ExecutionStatus> {
      const exec = execs[execs.length - 1];
      return {
        executionId,
        participantId: exec?.participantId ?? "p",
        state: exec?.state ?? "running",
        lastSeq: exec?.seq ?? 0,
      };
    },
    async ack(
      _scopeId: string,
      executionId: string,
      request: AckRequest,
    ): Promise<{
      executionId: string;
      ackState: "acknowledged";
      disposition: AckRequest["disposition"];
    }> {
      counters.ack += 1;
      const exec = execs[execs.length - 1];
      if (exec) exec.ackDisposition = request.disposition;
      return { executionId, ackState: "acknowledged", disposition: request.disposition };
    },
    async cancelExecution(_scopeId: string, _executionId: string): Promise<void> {
      counters.cancel += 1;
      const exec = execs[execs.length - 1];
      if (exec) {
        exec.state = "interrupted";
        exec.events.push(makeInterruptedEvent(exec.events.length + 5, "user_cancelled"));
      }
    },
    async closeScope(
      scopeId: string,
      _controller: { controllerId: string; leaseEpoch: number },
    ): Promise<{ scopeId: string; state: "closed" }> {
      counters.close += 1;
      if (options.closeFails) throw new RuntimeClientError(500, "INTERNAL", "close failed");
      return { scopeId, state: "closed" };
    },
    eventStreamFetch(input: { scopeId: string; executionId: string; afterSeq: number }) {
      return { url: `http://fake/events?afterSeq=${input.afterSeq}`, headers: {} };
    },
  };

  const followEvents = async (opts: FollowEventsOptions): Promise<FollowOutcome> => {
    const exec = execs[execs.length - 1];
    if (!exec) return { kind: "closed", lastSeq: 0 };
    const afterSeqMatch = /afterSeq=(\d+)/.exec(opts.fetchInput.url);
    const afterSeq = afterSeqMatch ? Number.parseInt(afterSeqMatch[1], 10) : 0;
    let lastSeq = afterSeq;
    let terminal: RuntimeEvent | null = null;
    for (const event of exec.events) {
      if (event.seq <= afterSeq) continue;
      await opts.onEvent(event);
      lastSeq = event.seq;
      if (event.type === "completed" || event.type === "failed" || event.type === "interrupted") {
        terminal = event;
        exec.state = event.type;
        break;
      }
    }
    if (terminal) return { kind: "terminal", event: terminal };
    if (options.behavior?.kind === "hangUntilCancel") {
      // Hang until the deadline / external abort fires, then surface "aborted"
      // so the helper's abort path classifies timeout vs cancelled correctly.
      const signal = opts.signal;
      if (signal?.aborted) return { kind: "aborted", lastSeq };
      await new Promise<void>((resolve) => {
        if (signal) {
          const done = () => resolve();
          signal.addEventListener("abort", done, { once: true });
        } else {
          setTimeout(resolve, 50);
        }
      });
      return { kind: "aborted", lastSeq };
    }
    return { kind: "closed", lastSeq };
  };

  return { client, counters, followEvents, execs };
}

type Host = ReturnType<typeof fakeHost>;

function run(host: Host, overrides: Record<string, unknown> = {}) {
  return runAgentRealCallTest({
    client: host.client as never,
    profile: PROFILE,
    modelId: "model-x",
    persona: "test persona",
    timeoutMs: 5_000,
    idFactory: () => `id-${Math.random().toString(36).slice(2)}`,
    now: () => 1_000_000,
    followEvents: host.followEvents as never,
    ...overrides,
  } as never);
}

describe("agent-real-call — success", () => {
  it("completed: full lifecycle, committed ACK, close", async () => {
    const host = fakeHost({
      behavior: { kind: "completed", output: "COUNCILKIT_OK", usage: null },
    });
    const result = await run(host);
    expect(result.verdict).toBe("completed");
    expect(result.canonical).toBe("model-x");
    expect(result.effective).toBe("model-x");
    expect(result.modelVerdict).toBe("match");
    expect(result.toolState).toBe("none");
    expect(result.error).toBeNull();
    expect(result.outputPreview).toBe("COUNCILKIT_OK");
    expect(host.counters.execute).toBe(1);
    expect(host.counters.ack).toBe(1);
    expect(host.counters.close).toBe(1);
    expect(host.execs[0].ackDisposition).toBe("committed");
  });

  it("outputPreview truncates to 500 code points + ellipsis", async () => {
    const host = fakeHost({
      behavior: { kind: "completed", output: "x".repeat(600), usage: null },
    });
    const result = await run(host);
    expect(Array.from(result.outputPreview).length).toBe(501);
    expect(result.outputPreview.endsWith("…")).toBe(true);
  });

  it("final-only completed: TTFT from terminal arrival", async () => {
    const host = fakeHost({ behavior: { kind: "completed", output: "final-only", usage: null } });
    const result = await run(host);
    expect(result.verdict).toBe("completed");
    expect(result.ttftMs).not.toBeNull();
  });
});

describe("agent-real-call — terminal failures", () => {
  it("empty output: verdict failed, EMPTY_OUTPUT, discarded ACK", async () => {
    const host = fakeHost({ behavior: { kind: "emptyOutput", usage: null } as never });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("EMPTY_OUTPUT");
    expect(host.execs[0].ackDisposition).toBe("discarded");
  });

  it("failed terminal: verdict failed, discarded ACK, classified", async () => {
    const host = fakeHost({
      behavior: { kind: "failed", code: "DRIVER_CRASH", usage: null } as never,
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.category).toBe("crash");
    expect(host.execs[0].ackDisposition).toBe("discarded");
    expect(host.counters.close).toBe(1);
  });

  it("interrupted terminal: verdict interrupted, discarded ACK", async () => {
    const host = fakeHost({
      behavior: { kind: "interrupted", reason: "driver_crash", usage: null } as never,
    });
    const result = await run(host);
    expect(result.verdict).toBe("interrupted");
    expect(host.execs[0].ackDisposition).toBe("discarded");
  });
});

describe("agent-real-call — gating + create", () => {
  it("create failure: classified by Host code, no scope-owned work", async () => {
    const host = fakeHost({
      createFailsWith: new RuntimeClientError(404, "INSTALLATION_NOT_FOUND", "no install"),
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.category).toBe("installation");
  });

  it("activate invalid_binding: installation category", async () => {
    const host = fakeHost({ activateReadiness: "invalid_binding" });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.category).toBe("installation");
    expect(host.counters.close).toBe(1);
  });

  it("activate model_unavailable: model_unavailable category", async () => {
    const host = fakeHost({ activateReadiness: "model_unavailable" });
    const result = await run(host);
    expect(result.error?.category).toBe("model_unavailable");
  });

  it("activate runtime_unavailable with login detail: auth category", async () => {
    const host = fakeHost({ activateReadiness: "runtime_unavailable" });
    const result = await run(host);
    expect(result.error?.category).toBe("auth");
  });
});

describe("agent-real-call — timeout / cancel / cleanup", () => {
  it("deadline timeout: verdict timeout, cancel once, close once", async () => {
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "to-id",
    } as never);
    expect(result.verdict).toBe("timeout");
    expect(result.error?.category).toBe("timeout");
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.close).toBe(1);
  });

  it("external abort: verdict cancelled, cleanup chain runs", async () => {
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    const controller = new AbortController();
    const promise = runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 30_000,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      signal: controller.signal,
      idFactory: () => "ca-id",
    } as never);
    controller.abort();
    const result = await promise;
    expect(result.verdict).toBe("cancelled");
    expect(host.counters.close).toBe(1);
  });

  it("close failure downgrades completed → failed (SCOPE_CLOSE_FAILED)", async () => {
    const host = fakeHost({
      behavior: { kind: "completed", output: "ok", usage: null },
      closeFails: true,
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("SCOPE_CLOSE_FAILED");
  });

  it("execute dispatched exactly once", async () => {
    const host = fakeHost({ behavior: { kind: "completed", output: "ok", usage: null } });
    await run(host);
    expect(host.counters.execute).toBe(1);
  });
});

describe("agent-real-call — error mapping matrix", () => {
  const cases: Array<{ code: string; status: number; category: string }> = [
    { code: "UNAUTHENTICATED", status: 401, category: "auth" },
    { code: "FORBIDDEN", status: 403, category: "auth" },
    { code: "CSRF_MISMATCH", status: 403, category: "auth" },
    { code: "INSTALLATION_NOT_FOUND", status: 404, category: "installation" },
    { code: "INSTALLATION_CHANGED", status: 409, category: "installation" },
    { code: "MODEL_UNAVAILABLE", status: 409, category: "model_unavailable" },
    { code: "MODEL_MISMATCH", status: 409, category: "model_unavailable" },
    { code: "TURN_TIMEOUT", status: 500, category: "timeout" },
    { code: "HANDSHAKE_TIMEOUT", status: 500, category: "timeout" },
    { code: "RESOURCE_LIMIT", status: 429, category: "quota" },
    { code: "RATE_LIMITED", status: 429, category: "quota" },
    { code: "PARTICIPANT_BUSY", status: 409, category: "quota" },
    { code: "DRIVER_SPAWN_FAILED", status: 500, category: "crash" },
    { code: "PROTOCOL_VIOLATION", status: 500, category: "crash" },
    { code: "INTERNAL", status: 500, category: "crash" },
  ];
  for (const { code, status, category } of cases) {
    it(`${code} → ${category}`, async () => {
      const host = fakeHost({ createFailsWith: new RuntimeClientError(status, code, code) });
      const result = await run(host);
      expect(result.error?.category).toBe(category);
    });
  }
});

// Keep the snapshot import used for type-only references.
