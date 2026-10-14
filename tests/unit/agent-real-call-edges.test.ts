import { runAgentRealCallTest } from "@/lib/agent-real-call";
import { RuntimeClientError } from "@/runtime/client";
import type { FollowEventsOptions, FollowOutcome } from "@/runtime/event-stream";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import type { RuntimeEvent } from "@shared/runtime/events";
import type { ExecutionProfileDto } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

const PROFILE: ExecutionProfileDto = {
  driverId: "codex-app-server",
  installationId: "inst-fake",
  credentialMode: CREDENTIAL_MODE,
  options: {},
};

function completedEvent(output = "COUNCILKIT_OK"): RuntimeEvent {
  return {
    type: "completed",
    executionId: "exec",
    seq: 4,
    at: "2026-07-22T00:00:00.000Z",
    output,
    requestedModel: "model-x",
    effectiveModel: "model-x",
    modelVerdict: "match",
    toolState: "none",
    dispatchState: "accepted",
    usage: null,
    finalSeq: 4,
  };
}

function interruptedEvent(reason: string): RuntimeEvent {
  return {
    type: "interrupted",
    executionId: "exec",
    seq: 2,
    at: "2026-07-22T00:00:00.000Z",
    reason: reason as "timeout",
    dispatchState: "accepted",
    toolState: "none",
  };
}

interface Script {
  createThrows?: unknown;
  closeThrows?: unknown;
  activateThrows?: unknown;
  readiness?: { state: string; detail: string | null };
  follow?: (opts: FollowEventsOptions, pass: number) => Promise<FollowOutcome>;
  getExecution?: () => Promise<{ state: string; lastSeq: number } | null>;
}

function scripted(script: Script = {}) {
  const counts = { create: 0, close: 0, execute: 0, activate: 0 };
  let follows = 0;
  let participantId = "";
  const createBodies: unknown[] = [];
  const executeBodies: unknown[] = [];

  const client = {
    async createScope(request: {
      participants: Array<{ participantId: string; personaPrompt?: string }>;
    }) {
      counts.create += 1;
      createBodies.push(request);
      participantId = request.participants[0]?.participantId ?? "";
      if (script.createThrows !== undefined && counts.create === 1) throw script.createThrows;
      return {
        scopeId: "scope-1",
        controllerId: "ctrl",
        leaseEpoch: 1,
        scope: {
          participants: [
            {
              participantId,
              binding: { canonicalModelId: "model-x" },
              readiness: { state: "ready", detail: null },
            },
          ],
        },
      };
    },
    async activateScope() {
      counts.activate += 1;
      if (script.activateThrows) throw script.activateThrows;
      return {
        participants: [
          {
            participantId,
            binding: { canonicalModelId: "model-x" },
            readiness: script.readiness ?? { state: "ready", detail: null },
          },
        ],
      };
    },
    async execute(_scopeId: string, request: { snapshot: unknown }) {
      counts.execute += 1;
      executeBodies.push(request);
      return { execution: { executionId: "exec", state: "running", lastSeq: 1 } };
    },
    async getExecution() {
      if (script.getExecution) return script.getExecution();
      throw new Error("getExecution unused");
    },
    async ack() {
      return { executionId: "exec", ackState: "acknowledged", disposition: "committed" };
    },
    async cancelExecution() {
      return { executionId: "exec", state: "interrupted" };
    },
    async closeScope(scopeId: string) {
      counts.close += 1;
      if (script.closeThrows) throw script.closeThrows;
      return { scopeId, state: "closed" as const };
    },
    eventStreamFetch() {
      return { url: "http://127.0.0.1/events?afterSeq=0", headers: {} };
    },
  };

  const followEvents = async (opts: FollowEventsOptions): Promise<FollowOutcome> => {
    follows += 1;
    if (script.follow) return script.follow(opts, follows);
    const event = completedEvent();
    await opts.onEvent(event);
    return { kind: "terminal", event };
  };

  return { client, counts, followEvents, createBodies, executeBodies };
}

function run(host: ReturnType<typeof scripted>, overrides: Record<string, unknown> = {}) {
  return runAgentRealCallTest({
    client: host.client as never,
    profile: PROFILE,
    modelId: "model-x",
    persona: "test persona",
    timeoutMs: 5_000,
    idFactory: () => "id-fixed",
    now: () => 1_000_000,
    followEvents: host.followEvents,
    ...overrides,
  });
}

describe("agent-real-call edges", () => {
  it("reports STREAM_CLOSED when the stream ends and the execution record is gone", async () => {
    const host = scripted({
      follow: async () => ({ kind: "closed", lastSeq: 3 }),
      getExecution: async () => {
        throw new Error("execution record lost");
      },
    });
    const result = await run(host);
    expect(result).toMatchObject({
      verdict: "failed",
      canonical: "model-x",
      error: {
        category: "crash",
        code: "STREAM_CLOSED",
        message: "event stream closed before a terminal arrived and the execution was lost",
        retryable: false,
      },
    });
    expect(host.counts.close).toBe(1);
    expect(host.counts.execute).toBe(1);
  });

  it("reconnects once when the record is still running and then completes", async () => {
    const host = scripted({
      follow: async (opts, pass) => {
        if (pass === 1) return { kind: "closed", lastSeq: 1 };
        const event = completedEvent("COUNCILKIT_OK");
        await opts.onEvent(event);
        return { kind: "terminal", event };
      },
      getExecution: async () => ({ state: "running", lastSeq: 1 }),
    });
    const result = await run(host);
    expect(result).toMatchObject({
      verdict: "completed",
      canonical: "model-x",
      effective: "model-x",
      outputPreview: "COUNCILKIT_OK",
      error: null,
      totalMs: 0,
      ttftMs: 0,
    });
    expect(host.counts.close).toBe(1);
  });

  it.each([
    ["timeout", "timeout", "TURN_TIMEOUT", "turn timed out", true],
    ["host_shutdown", "crash", "HOST_SHUTDOWN", "host shutdown", false],
    ["user_cancelled", "crash", "USER_CANCELLED", "cancelled by user", false],
    ["unknown", "crash", "INTERRUPTED", "interrupted", false],
  ] as const)(
    "classifies interrupted reason %s",
    async (reason, category, code, message, retryable) => {
      const host = scripted({
        follow: async () => ({ kind: "terminal", event: interruptedEvent(reason) }),
      });
      const result = await run(host);
      expect(result.verdict).toBe("interrupted");
      expect(result.error).toEqual({ category, code, message, retryable });
    },
  );

  it("treats an unknown readiness state as ready enough to finish", async () => {
    const host = scripted({ readiness: { state: "pending", detail: "warming" } });
    const result = await run(host);
    expect(result.verdict).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.outputPreview).toBe("COUNCILKIT_OK");
  });

  it("uses default gate messages when readiness detail is missing", async () => {
    const invalid = scripted({ readiness: { state: "invalid_binding", detail: null } });
    expect((await run(invalid)).error).toEqual({
      category: "installation",
      code: "INVALID_BINDING",
      message: "installation/binding invalid",
      retryable: false,
    });
    const missing = scripted({ readiness: { state: "model_unavailable", detail: null } });
    expect((await run(missing)).error).toEqual({
      category: "model_unavailable",
      code: "MODEL_UNAVAILABLE",
      message: "selected modelId not in the driver catalog",
      retryable: false,
    });
    const down = scripted({ readiness: { state: "runtime_unavailable", detail: "disk full" } });
    expect((await run(down)).error).toEqual({
      category: "crash",
      code: "RUNTIME_UNAVAILABLE",
      message: "disk full",
      retryable: false,
    });
    expect(down.counts.execute).toBe(0);
    expect(down.counts.close).toBe(1);
  });

  it("classifies an activate-time model mismatch and keeps the canonical id", async () => {
    const host = scripted({
      activateThrows: new RuntimeClientError(409, "MODEL_MISMATCH", "mismatch"),
    });
    const result = await run(host);
    expect(result).toMatchObject({
      verdict: "failed",
      canonical: "model-x",
      error: {
        category: "model_unavailable",
        code: "MODEL_MISMATCH",
        message: "mismatch",
        retryable: false,
      },
    });
    expect(host.counts.execute).toBe(0);
  });

  it("omits an empty persona from the create body and the probe snapshot", async () => {
    const host = scripted();
    const result = await run(host, { persona: "" });
    expect(result.verdict).toBe("completed");
    expect(host.createBodies[0]).toEqual({
      scopeRequestId: "id-fixed",
      participants: [
        {
          participantId: "id-fixed",
          profile: PROFILE,
          modelId: "model-x",
          personaPrompt: undefined,
        },
      ],
    });
    const snapshot = (
      host.executeBodies[0] as {
        snapshot: {
          participant: Record<string, unknown>;
          instruction: { kind: string; text: string };
        };
      }
    ).snapshot;
    expect(snapshot.instruction.kind).toBe("message");
    expect(snapshot.instruction.text).toBe("Reply with exactly: COUNCILKIT_OK");
    expect(Object.keys(snapshot.participant).sort()).toEqual([
      "participantId",
      "participantSnapshotDigest",
    ]);
    expect(snapshot.participant.participantId).toBe("id-fixed");
  });

  it.each([
    ["STALE_CONTROLLER", 409, "auth", false],
    ["AUTH_REQUIRED", 401, "auth", false],
    ["INSTALLATION_INVALID", 409, "installation", false],
    ["INSTALLATION_UNTRUSTED", 409, "installation", false],
    ["PROFILE_INVALID", 400, "installation", false],
    ["INCOMPATIBLE_DRIVER", 409, "installation", false],
    ["DISPATCH_TIMEOUT", 408, "timeout", true],
    ["STREAM_IDLE_TIMEOUT", 408, "timeout", true],
    ["STREAM_DRAIN_TIMEOUT", 408, "timeout", true],
  ] as const)("maps create code %s", async (code, status, category, retryable) => {
    const host = scripted({
      createThrows: new RuntimeClientError(status, code, `${code} detail`),
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error).toEqual({
      category,
      code,
      message: `${code} detail`,
      retryable,
    });
    expect(host.counts.create).toBe(1);
    expect(host.counts.close).toBe(0);
  });

  it("treats HTTP 429 and an empty code as quota and CRASH", async () => {
    const quota = scripted({
      createThrows: new RuntimeClientError(429, "WHATEVER", "slow down"),
    });
    expect((await run(quota)).error).toEqual({
      category: "quota",
      code: "WHATEVER",
      message: "slow down",
      retryable: true,
    });
    const crash = scripted({
      createThrows: new RuntimeClientError(500, "", "blank"),
    });
    expect((await run(crash)).error).toEqual({
      category: "crash",
      code: "CRASH",
      message: "blank",
      retryable: false,
    });
  });

  it("does not recover a named AbortError that is not the deadline", async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    const host = scripted({ createThrows: error });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error).toEqual({
      category: "timeout",
      code: "ABORT",
      message: "aborted",
      retryable: true,
    });
    expect(host.counts.create).toBe(1);
    expect(host.counts.close).toBe(0);
  });

  it("recovers a string create failure and closes the leaked scope", async () => {
    const host = scripted({ createThrows: "boom" });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error).toEqual({
      category: "crash",
      code: "RUNTIME_UNAVAILABLE",
      message: "boom",
      retryable: false,
    });
    expect(host.counts.create).toBe(2);
    expect(host.counts.close).toBe(1);
  });

  it("recovers a 502 create and surfaces a failed recovery close", async () => {
    const recovered = scripted({
      createThrows: new RuntimeClientError(502, "BAD_GATEWAY", "gateway down"),
    });
    expect((await run(recovered)).error).toEqual({
      category: "crash",
      code: "BAD_GATEWAY",
      message: "gateway down",
      retryable: false,
    });
    expect(recovered.counts.create).toBe(2);
    expect(recovered.counts.close).toBe(1);

    const closed = scripted({
      createThrows: new TypeError("network error: response stream lost"),
      closeThrows: new Error("close failed"),
    });
    expect((await run(closed)).error).toEqual({
      category: "crash",
      code: "SCOPE_CLOSE_FAILED",
      message: "recovered scope could not be closed after create transport loss",
      retryable: false,
    });
    expect(closed.counts.create).toBe(2);
    expect(closed.counts.close).toBe(1);
  });
});
