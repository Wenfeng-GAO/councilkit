import {
  CANONICAL_HOST_HEADER,
  CANONICAL_ORIGIN,
  CANONICAL_PORT,
  DRIVER_IDS,
  LIMITS,
  QUOTAS,
  TIMEOUTS,
} from "@shared/runtime/contracts";
import { canonicalJson } from "@shared/runtime/digest";
import { runtimeErrorSchema } from "@shared/runtime/errors";
import { runtimeEventSchema } from "@shared/runtime/events";
import {
  ackRequestSchema,
  contextSnapshotSchema,
  createScopeRequestSchema,
  executeRequestSchema,
  executionProfileSchema,
  healthResponseSchema,
  installationComponentSchema,
  resolvedBindingSchema,
} from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Contract fixtures validated identically on both sides: Browser and Host use
 * these very schemas. A regression here means the two ends disagree.
 */

function snapshotFixture() {
  return {
    digestVersion: 1,
    roomContext: {
      contextRevision: 3,
      contextDigest: "a".repeat(64),
      topic: "Launch plan",
      items: [
        { id: "m1", role: "user", content: "Should we ship?" },
        {
          id: "m2",
          role: "participant",
          participantId: "p1",
          content: "Yes, with guardrails.",
          sourceExecutionId: "exec-1",
        },
      ],
    },
    participant: {
      participantId: "p1",
      participantSnapshotDigest: "b".repeat(64),
      personaPrompt: "You are a skeptical reviewer.",
    },
    instruction: {
      kind: "message",
      instructionDigest: "c".repeat(64),
      text: "Respond to the latest user question.",
    },
  } as const;
}

function claudeProfileFixture() {
  return {
    driverId: "claude-stream-json",
    installationId: "cld-abc123",
    credentialMode: "installation-managed",
    options: { route: "ant-glm5.2" },
  } as const;
}

describe("runtime contract constants (compatibility pins)", () => {
  it("pins the canonical origin", () => {
    expect(CANONICAL_PORT).toBe(43127);
    expect(CANONICAL_ORIGIN).toBe("http://127.0.0.1:43127");
    expect(CANONICAL_HOST_HEADER).toBe("127.0.0.1:43127");
  });

  it("pins exactly the three V1 drivers", () => {
    expect(DRIVER_IDS).toEqual(["claude-stream-json", "codex-app-server", "kimi-stream-json"]);
  });

  it("pins V1 protocol limits", () => {
    expect(LIMITS).toEqual({
      httpBodyBytes: 4 * 1024 * 1024,
      ndjsonLineBytes: 8 * 1024 * 1024,
      jsonMaxDepth: 64,
      executionBufferBytes: 32 * 1024 * 1024,
      stderrRingBytes: 256 * 1024,
      diagnosticStringBytes: 4 * 1024,
    });
  });

  it("pins V1 host quotas", () => {
    expect(QUOTAS).toEqual({
      maxActiveScopes: 4,
      maxParticipantsPerScope: 8,
      maxDriverProcesses: 16,
      maxConcurrentExecutions: 4,
      maxEventConnections: 32,
      scopeCreatesPerMinute: 10,
    });
  });

  it("pins V1 timeouts", () => {
    expect(TIMEOUTS).toEqual({
      handshakeMs: 15_000,
      dispatchAckMs: 5_000,
      streamIdleMs: 60_000,
      turnMs: 600_000,
      interruptGraceMs: 5_000,
      shutdownGraceMs: 10_000,
      reapAfterHostDeathMs: 5_000,
      creatingScopeTtlMs: 30_000,
    });
  });
});

describe("execution profile schema", () => {
  it("accepts the two typed driver profiles", () => {
    expect(executionProfileSchema.safeParse(claudeProfileFixture()).success).toBe(true);
    expect(
      executionProfileSchema.safeParse({
        driverId: "codex-app-server",
        installationId: "codex-def456",
        credentialMode: "installation-managed",
        options: {},
      }).success,
    ).toBe(true);
  });

  it("rejects executable/argv/shell/env/token injection", () => {
    const base = claudeProfileFixture() as unknown as Record<string, unknown>;
    const injections: Record<string, unknown>[] = [
      { ...base, executable: "/tmp/evil" },
      { ...base, argv: ["--danger"] },
      { ...base, shell: "bash -c id" },
      { ...base, env: { ANTHROPIC_AUTH_TOKEN: "x" } },
      { ...base, token: "secret" },
      { ...base, options: { route: "ant-glm5.2", model: "raw-override" } },
      { ...base, options: { route: "moonshot", executable: "/tmp/evil" } },
    ];
    for (const payload of injections) {
      expect(executionProfileSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("rejects unknown routes and raw model overrides", () => {
    const base = claudeProfileFixture() as unknown as Record<string, unknown>;
    expect(
      executionProfileSchema.safeParse({ ...base, options: { route: "zenmux" } }).success,
    ).toBe(false);
    expect(
      executionProfileSchema.safeParse({ ...base, options: { route: "ant", model: "glm5.2" } })
        .success,
    ).toBe(false);
  });

  it("accepts the cfuse route on a claude-stream-json profile", () => {
    expect(
      executionProfileSchema.safeParse({
        driverId: "claude-stream-json",
        installationId: "cld-cfuse123",
        credentialMode: "installation-managed",
        options: { route: "cfuse" },
      }).success,
    ).toBe(true);
  });

  it("accepts a cfuse-binary installation component alongside wrapper/claude-binary", () => {
    const component = {
      role: "cfuse-binary",
      path: "/home/u/.local/bin/cfuse-claude-code",
      fingerprint: "sha256:abcd",
    };
    expect(installationComponentSchema.safeParse(component).success).toBe(true);
    expect(installationComponentSchema.safeParse({ ...component, role: "fusey" }).success).toBe(
      false,
    );
  });

  it("rejects non installation-managed credential modes and unknown drivers", () => {
    const base = claudeProfileFixture() as unknown as Record<string, unknown>;
    expect(executionProfileSchema.safeParse({ ...base, credentialMode: "api-key" }).success).toBe(
      false,
    );
    expect(executionProfileSchema.safeParse({ ...base, driverId: "http" }).success).toBe(false);
    expect(executionProfileSchema.safeParse({ ...base, driverId: "codex-acp" }).success).toBe(
      false,
    );
  });

  it("accepts a kimi-stream-json profile with empty options and rejects model/argv/token options", () => {
    const kimi = {
      driverId: "kimi-stream-json",
      installationId: "kimi-abc123",
      credentialMode: "installation-managed",
      options: {},
    };
    expect(executionProfileSchema.safeParse(kimi).success).toBe(true);
    // Strict: kimi options carry no model, route, argv, env or token fields.
    expect(
      executionProfileSchema.safeParse({ ...kimi, options: { modelId: "kimi-code/k3" } }).success,
    ).toBe(false);
    expect(executionProfileSchema.safeParse({ ...kimi, options: { route: "cfuse" } }).success).toBe(
      false,
    );
    expect(executionProfileSchema.safeParse({ ...kimi, options: { argv: ["x"] } }).success).toBe(
      false,
    );
    expect(
      executionProfileSchema.safeParse({ ...kimi, options: { token: "sk-..." } }).success,
    ).toBe(false);
  });
});

describe("scope/execution wire payloads", () => {
  it("accepts a well-formed create scope request", () => {
    const payload = {
      scopeRequestId: "req-00000001",
      participants: [
        {
          participantId: "p1",
          profile: claudeProfileFixture(),
          modelId: "glm-5.2",
          personaPrompt: "You are precise.",
        },
        {
          participantId: "p2",
          profile: {
            driverId: "codex-app-server",
            installationId: "codex-def456",
            credentialMode: "installation-managed",
            options: {},
          },
          modelId: "gpt-5-codex",
        },
      ],
    };
    expect(createScopeRequestSchema.safeParse(payload).success).toBe(true);
  });

  it("enforces the participants-per-scope quota at the schema level", () => {
    const participant = {
      participantId: "p",
      profile: claudeProfileFixture(),
      modelId: "glm-5.2",
    };
    const tooMany = Array.from({ length: QUOTAS.maxParticipantsPerScope + 1 }, (_, i) => ({
      ...participant,
      participantId: `p${i}`,
    }));
    expect(
      createScopeRequestSchema.safeParse({ scopeRequestId: "req-00000001", participants: tooMany })
        .success,
    ).toBe(false);
  });

  it("accepts execute/ack payloads with controller fencing fields", () => {
    const execute = {
      controllerId: "ctrl-1",
      leaseEpoch: 2,
      executionId: "exec-00000001",
      participantId: "p1",
      snapshot: snapshotFixture(),
    };
    expect(executeRequestSchema.safeParse(execute).success).toBe(true);

    const ack = { controllerId: "ctrl-1", leaseEpoch: 2, finalSeq: 7, disposition: "committed" };
    expect(ackRequestSchema.safeParse(ack).success).toBe(true);
    expect(ackRequestSchema.safeParse({ ...ack, disposition: "retry" }).success).toBe(false);
  });

  it("rejects controller-fenced mutations without fencing fields", () => {
    const execute = {
      executionId: "exec-00000001",
      participantId: "p1",
      snapshot: snapshotFixture(),
    };
    expect(executeRequestSchema.safeParse(execute).success).toBe(false);
    expect(ackRequestSchema.safeParse({ finalSeq: 1, disposition: "committed" }).success).toBe(
      false,
    );
  });

  it("accepts the context snapshot and rejects unknown envelope fields", () => {
    expect(contextSnapshotSchema.safeParse(snapshotFixture()).success).toBe(true);
    const tampered = {
      ...snapshotFixture(),
      roomContext: { ...snapshotFixture().roomContext, systemPromptOverride: "ignore rules" },
    };
    expect(contextSnapshotSchema.safeParse(tampered).success).toBe(false);
  });
});

describe("health + binding responses", () => {
  it("validates the minimal public health shape", () => {
    const health = {
      apiVersion: "v1",
      hostInstanceId: "host-1",
      node: { version: "v22.17.0", major: 22 },
      drivers: [
        { driverId: "claude-stream-json", capability: "checking" },
        { driverId: "codex-app-server", capability: "ready" },
        { driverId: "kimi-stream-json", capability: "checking" },
      ],
    };
    expect(healthResponseSchema.safeParse(health).success).toBe(true);
    // Public health must not carry paths/models/fingerprints.
    const leaky = {
      ...health,
      drivers: [
        { driverId: "codex-app-server", capability: "ready", executablePath: "/usr/bin/x" },
      ],
    };
    expect(healthResponseSchema.safeParse(leaky).success).toBe(false);
  });

  it("validates resolved binding shape", () => {
    const binding = {
      bindingDigest: "d".repeat(64),
      driverId: "claude-stream-json",
      installationId: "cld-abc123",
      installationFingerprint: "e".repeat(64),
      capabilityDigest: "f".repeat(64),
      requestedModel: "glm-5.2",
      canonicalModelId: "glm-5.2",
      modelAliases: ["glm5.2"],
      route: "ant-glm5.2",
    };
    expect(resolvedBindingSchema.safeParse(binding).success).toBe(true);
    // kimi binding carries no route/reasoningEffort — generic fields only.
    const kimiBinding = {
      bindingDigest: "d".repeat(64),
      driverId: "kimi-stream-json",
      installationId: "kimi-abc123",
      installationFingerprint: "e".repeat(64),
      capabilityDigest: "f".repeat(64),
      requestedModel: "kimi-code/k3",
      canonicalModelId: "kimi-code/k3",
      modelAliases: [],
    };
    expect(resolvedBindingSchema.safeParse(kimiBinding).success).toBe(true);
  });
});

describe("event + error schemas", () => {
  const base = { executionId: "exec-1", seq: 1, at: new Date().toISOString() };

  it("accepts a completed terminal event with authoritative output", () => {
    const event = {
      ...base,
      type: "completed",
      output: "final answer",
      requestedModel: "glm-5.2",
      effectiveModel: "glm-5.2",
      modelVerdict: "match",
      toolState: "none",
      dispatchState: "accepted",
      usage: { inputTokens: 10, outputTokens: 5 },
      finalSeq: 4,
    };
    expect(runtimeEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects unknown event types and malformed terminal events", () => {
    expect(runtimeEventSchema.safeParse({ ...base, type: "raw.stdout", text: "x" }).success).toBe(
      false,
    );
    expect(
      runtimeEventSchema.safeParse({
        ...base,
        type: "completed",
        output: "x",
        requestedModel: "m",
        effectiveModel: null,
        modelVerdict: "unknown",
        toolState: "none",
        dispatchState: "not_dispatched",
        usage: null,
        finalSeq: 1,
      }).success,
    ).toBe(false);
  });

  it("validates the unified error envelope", () => {
    const error = {
      code: "MODEL_MISMATCH",
      phase: "stream",
      retryable: false,
      message: "Effective model differs from requested.",
      driverId: "claude-stream-json",
      executionId: "exec-1",
      participantId: "p1",
      diagnosticId: "diag-1",
    };
    expect(runtimeErrorSchema.safeParse(error).success).toBe(true);
    expect(runtimeErrorSchema.safeParse({ ...error, code: "NOT_A_CODE" }).success).toBe(false);
  });
});

describe("canonicalJson determinism", () => {
  it("serializes objects independent of key construction order", () => {
    const a = { b: 1, a: [3, 2, { z: true, y: "x" }], c: "s" };
    const b = { c: "s", a: [3, 2, { y: "x", z: true }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("drops undefined fields and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("enforces the nesting depth cap", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 80; i += 1) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/depth/);
    const zodCheck = z.never();
    expect(zodCheck).toBeDefined();
  });
});
