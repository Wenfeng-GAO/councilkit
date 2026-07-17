import { performance } from "node:perf_hooks";
import type {
  Emit,
  ExecuteInput,
  ParticipantDriver,
  PrewarmInput,
  PrewarmResult,
} from "@host/drivers/types";
import { createExecutionRegistry } from "@host/executions/execution-registry";
import type { InstallationRecord, InstallationRegistry } from "@host/installations/registry";
import { installationRoutes } from "@host/routes/installations";
import { scopeRoutes } from "@host/routes/scopes";
import { type ScopeManager, createScopeManager } from "@host/scopes/scope-manager";
import { createSessionReconciler } from "@host/scopes/session-reconciler";
import type { RuntimeEvent } from "@shared/runtime/events";
import type { ContextSnapshot, InstallationDto, ParticipantSpec } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "../host/helpers";

/**
 * U6 performance gate (docs/plans/2026-07-17-001 §"性能 gate"), mechanized
 * with in-process fake drivers so no supplier network is involved:
 *
 *  1. execute -> first normalized event: 100 samples on prewarmed
 *     participants, measured from just before the execute POST to the first
 *     runtime event on the SSE stream; p95 must be < 50ms.
 *  2. Reconnect replay: with events already buffered, a fresh SSE connection
 *     using ?afterSeq=<mid> must see its first replayed event in < 1000ms.
 *  3. Warm reuse: a second append-only round must not spawn anything new —
 *     prewarm is the spawn proxy for the in-process fakes.
 *
 * Sampling choice: each gate-1 sample opens a FRESH SSE connection right
 * after the execute POST resolves, so the measured window covers the POST
 * HTTP round trip + registry emit/buffer + SSE connect + replay/live write —
 * exactly what a client experiences on dispatch. The same stream then drains
 * to `completed` so the next sample never races a busy participant; draining
 * happens after the timing endpoint is recorded and does not pollute it.
 */

// ---------------------------------------------------------------------------
// Fakes (same shape as tests/integration/runtime-host.test.ts)
// ---------------------------------------------------------------------------

interface FakeDriver extends ParticipantDriver {
  sessionEpoch: number;
  prewarmCount: number;
  closeCount: number;
  executeCalls: { executionId: string; prompt: string; modelId: string; coldStart: boolean }[];
}

function createFakeDriver(participantId: string): FakeDriver {
  const reply = `answer-from-${participantId}`;
  const fake: FakeDriver = {
    participantId,
    driverId: "codex-app-server",
    sessionEpoch: 0,
    prewarmCount: 0,
    closeCount: 0,
    executeCalls: [],
    prewarm(input: PrewarmInput): Promise<PrewarmResult> {
      fake.prewarmCount += 1;
      return Promise.resolve({
        canonicalModelId: input.spec.modelId,
        modelAliases: [],
        capability: { protocol: "fake" },
        catalog: [input.spec.modelId],
      });
    },
    execute(input: ExecuteInput, emit: Emit): Promise<void> {
      fake.executeCalls.push({
        executionId: input.executionId,
        prompt: input.prompt,
        modelId: input.modelId,
        coldStart: input.coldStart,
      });
      return new Promise<void>((resolvePromise) => {
        setImmediate(() => {
          emit({ type: "started", requestedModel: input.modelId });
          emit({ type: "output.delta", text: reply.slice(0, 4) });
          emit({ type: "output.delta", text: reply.slice(4) });
          emit({ type: "usage", usage: { inputTokens: 120, outputTokens: 5 } });
          emit({
            type: "completed",
            output: reply,
            requestedModel: input.modelId,
            effectiveModel: input.modelId,
            modelVerdict: "match",
            toolState: "none",
            dispatchState: "accepted",
            usage: { inputTokens: 120, outputTokens: 5 },
            finalSeq: 0,
          });
          resolvePromise();
        });
      });
    },
    cancel(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      fake.closeCount += 1;
      fake.sessionEpoch += 1;
      return Promise.resolve();
    },
    capabilityState: () => "ready",
    contextWindowTokens: () => null,
  };
  return fake;
}

const FAKE_INSTALLATION_DTO: InstallationDto = {
  installationId: "codex-fake0000000",
  driverId: "codex-app-server",
  state: "trusted",
  executablePath: "/fake/codex",
  fingerprint: "sha256:00",
  components: [],
  detail: null,
};

const FAKE_INSTALLATION_RECORD: InstallationRecord = {
  installationId: FAKE_INSTALLATION_DTO.installationId,
  driverId: "codex-app-server",
  name: "codex",
  discoveredPath: "/fake/codex",
  realpath: "/fake/codex",
  fingerprint: "sha256:00",
  state: "trusted",
  components: [],
  detail: null,
};

function fakeInstallationRegistry(): InstallationRegistry {
  return {
    refresh: () => [FAKE_INSTALLATION_DTO],
    list: () => [FAKE_INSTALLATION_DTO],
    get: (installationId: string) =>
      installationId === FAKE_INSTALLATION_DTO.installationId ? FAKE_INSTALLATION_DTO : undefined,
    revalidate: () => FAKE_INSTALLATION_DTO,
    assertExecutable: (installationId: string) => {
      if (installationId !== FAKE_INSTALLATION_RECORD.installationId) {
        throw new Error("INSTALLATION_NOT_FOUND");
      }
      return FAKE_INSTALLATION_RECORD;
    },
  } as InstallationRegistry;
}

// ---------------------------------------------------------------------------
// Host assembly
// ---------------------------------------------------------------------------

interface Rig {
  host: TestHost;
  scopeManager: ScopeManager;
  drivers: Map<string, FakeDriver>;
}

const nullLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  diagnostic: () => undefined,
} as unknown as import("@host/logging").Logger;

async function createRig(): Promise<Rig> {
  const drivers = new Map<string, FakeDriver>();
  const installations = fakeInstallationRegistry();
  const executions = createExecutionRegistry({ logger: nullLogger });
  const reconciler = createSessionReconciler();
  const scopeManager = createScopeManager({
    installations,
    executions,
    reconciler,
    driverFactories: {
      "codex-app-server": (participantId: string) => {
        const driver = createFakeDriver(participantId);
        drivers.set(participantId, driver);
        return driver;
      },
    },
    logger: nullLogger,
    hostInstanceId: "integration-host",
  });
  const host = await createTestHost({
    extraServices: {
      installationRegistry: installations,
      executionRegistry: executions,
      scopeManager,
      driverCapabilities: () => [{ driverId: "codex-app-server", capability: "ready" }],
    },
    routesFactory: (services) => [...installationRoutes(services), ...scopeRoutes(services)],
  });
  return { host, scopeManager, drivers };
}

// ---------------------------------------------------------------------------
// HTTP + SSE helpers
// ---------------------------------------------------------------------------

async function api<T = unknown>(
  host: TestHost,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${host.baseUrl}${path}`, {
    method,
    headers: authedHeaders(host),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = (await response.json()) as { ok: boolean; data?: T; error?: unknown };
  if (!envelope.ok) {
    if (process.env.CK_DEBUG_API) {
      console.error(
        `[debug] ${method} ${path} -> ${response.status}`,
        JSON.stringify(envelope.error),
      );
    }
    return { status: response.status, data: envelope.error as T };
  }
  return { status: response.status, data: envelope.data as T };
}

interface EventStreamResult {
  /** performance.now() at the moment the first runtime event was parsed. */
  firstAt: number | null;
  events: RuntimeEvent[];
}

/**
 * Opens an SSE events stream and reads until `until` matches (or the idle
 * deadline hits). Records the arrival timestamp of the FIRST runtime event
 * before any further processing so callers can time execute->first-event and
 * reconnect->first-replay windows.
 */
async function streamRuntimeEvents(
  host: TestHost,
  path: string,
  until: (event: RuntimeEvent) => boolean,
  timeoutMs = 5_000,
): Promise<EventStreamResult> {
  const controller = new AbortController();
  const response = await fetch(`${host.baseUrl}${path}`, {
    headers: authedHeaders(host),
    signal: controller.signal,
  });
  if (!response.body) throw new Error("no SSE body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: RuntimeEvent[] = [];
  let firstAt: number | null = null;
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let chunk: { done?: boolean; value?: Uint8Array };
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("sse-read-timeout")), remaining),
          ),
        ]);
      } catch {
        break; // idle deadline: return what was collected
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine && block.includes("event: runtime")) {
          if (firstAt === null) firstAt = performance.now();
          const event = JSON.parse(dataLine.slice(6)) as RuntimeEvent;
          events.push(event);
          if (until(event)) return { firstAt, events };
        }
        index = buffer.indexOf("\n\n");
      }
    }
    return { firstAt, events };
  } finally {
    controller.abort();
    reader.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

function spec(participantId: string): ParticipantSpec {
  return {
    participantId,
    profile: {
      driverId: "codex-app-server",
      installationId: FAKE_INSTALLATION_DTO.installationId,
      credentialMode: "installation-managed",
      options: {},
    },
    modelId: "fake-model-1",
  };
}

function snapshot(
  participantId: string,
  items: { id: string; content: string }[],
  instruction: string,
  revision: number,
): ContextSnapshot {
  return {
    digestVersion: 1,
    roomContext: {
      contextRevision: revision,
      contextDigest: `digest-r${revision}`,
      items: items.map((item) => ({ id: item.id, role: "user" as const, content: item.content })),
    },
    participant: { participantId, participantSnapshotDigest: "participant-digest-1" },
    instruction: { kind: "message", instructionDigest: `instr-${revision}`, text: instruction },
  };
}

interface CreatedScope {
  scopeId: string;
  controllerId: string;
  leaseEpoch: number;
}

/** Bodies are strict-schema: only controller fields may be spread in. */
function ctrl(scope: CreatedScope): { controllerId: string; leaseEpoch: number } {
  return { controllerId: scope.controllerId, leaseEpoch: scope.leaseEpoch };
}

async function createActiveScope(
  host: TestHost,
  scopeRequestId: string,
  participantIds: string[],
): Promise<CreatedScope> {
  const created = await api<CreatedScope>(host, "POST", "/api/v1/scopes", {
    scopeRequestId,
    participants: participantIds.map(spec),
  });
  expect(created.status).toBe(200);
  const { scopeId, controllerId, leaseEpoch } = created.data;
  const activated = await api(host, "POST", `/api/v1/scopes/${scopeId}/activate`, {
    controllerId,
    leaseEpoch,
  });
  expect(activated.status).toBe(200);
  return { scopeId, controllerId, leaseEpoch };
}

// ---------------------------------------------------------------------------
// Latency stats (nearest-rank percentiles over the raw samples)
// ---------------------------------------------------------------------------

interface LatencyStats {
  p50: number;
  p95: number;
  max: number;
}

function summarize(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
  return { p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] as number };
}

function formatStats(stats: LatencyStats): string {
  return `p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`;
}

function rawSamples(samples: number[]): string {
  return JSON.stringify(samples.map((sample) => Number(sample.toFixed(3))));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop() as Rig;
    await rig.scopeManager.closeAll("test-cleanup").catch(() => undefined);
    await rig.host.cleanup();
  }
});

describe("runtime perf gate (U6)", () => {
  it("execute -> first event: p95 < 50ms over 100 samples on prewarmed participants", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const { host } = rig;
    // 100 samples = 4 participants x 25 sequential executions each. A session
    // is reusable for at most SESSION_MAX_EXECUTIONS (32) turns, so 25 per
    // participant keeps every dispatch on the warm path. All participants are
    // prewarmed once at scope create, before any sampling starts.
    const participantIds = ["p-1", "p-2", "p-3", "p-4"];
    const scope = await createActiveScope(host, "req-perf-0001", participantIds);
    for (const participantId of participantIds) {
      expect(rig.drivers.get(participantId)?.prewarmCount).toBe(1);
    }

    const samples: number[] = [];
    const items: { id: string; content: string }[] = [];
    for (let i = 0; i < 100; i += 1) {
      const participantId = participantIds[Math.floor(i / 25)] as string;
      // Strictly append-only room context: every turn stays incremental (or
      // the participant's first turn, which is full but still prewarmed).
      items.push({ id: `m${i + 1}`, content: `message ${i + 1}` });
      const executionId = `exec-perf-${String(i + 1).padStart(4, "0")}`;
      const t0 = performance.now();
      const posted = await api<{ execution: { state: string } }>(
        host,
        "POST",
        `/api/v1/scopes/${scope.scopeId}/executions`,
        {
          ...ctrl(scope),
          executionId,
          participantId,
          snapshot: snapshot(participantId, items, `answer turn ${i + 1}`, i + 1),
        },
      );
      expect(posted.status).toBe(200);
      expect(posted.data.execution.state).toBe("running");
      const stream = await streamRuntimeEvents(
        host,
        `/api/v1/scopes/${scope.scopeId}/executions/${executionId}/events`,
        (event) => event.type === "completed" || event.type === "failed",
      );
      if (stream.firstAt === null) throw new Error(`no events for ${executionId}`);
      samples.push(stream.firstAt - t0);
      expect(stream.events[0]?.type).toBe("started");
      expect(stream.events.at(-1)?.type).toBe("completed");
      // Let the aborted stream's server-side close land before the next sample.
      await new Promise((resolve) => setImmediate(resolve));
    }

    const stats = summarize(samples);
    console.log(`[perf] execute->first-event n=${samples.length} ${formatStats(stats)}`);
    expect(
      stats.p95,
      `execute->first-event p95 ${stats.p95.toFixed(2)}ms >= 50ms (${formatStats(stats)}); ` +
        `samples=${rawSamples(samples)}`,
    ).toBeLessThan(50);
    expect(rig.drivers.size).toBe(participantIds.length);
  });

  it("reconnect replay: first replayed event after afterSeq reconnect arrives < 1000ms", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const { host } = rig;
    const scope = await createActiveScope(host, "req-perf-0002", ["p-1"]);
    const executionId = "exec-perf-replay";
    const posted = await api<{ execution: { state: string } }>(
      host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        executionId,
        participantId: "p-1",
        snapshot: snapshot("p-1", [{ id: "m1", content: "buffered" }], "go", 1),
      },
    );
    expect(posted.status).toBe(200);
    // Live connection follows to completion, then disconnects (the drop);
    // the execution keeps its full buffered event log (seq 1..5).
    const live = await streamRuntimeEvents(
      host,
      `/api/v1/scopes/${scope.scopeId}/executions/${executionId}/events`,
      (event) => event.type === "completed",
    );
    expect(live.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

    // Reconnect mid-stream: each sample is a fresh SSE connection with
    // ?afterSeq=2; measure connect -> first replayed event (seq 3).
    const samples: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const t0 = performance.now();
      const replay = await streamRuntimeEvents(
        host,
        `/api/v1/scopes/${scope.scopeId}/executions/${executionId}/events?afterSeq=2`,
        () => true,
      );
      if (replay.firstAt === null) throw new Error("no replayed event on reconnect");
      samples.push(replay.firstAt - t0);
      expect(replay.events[0]?.seq).toBe(3);
      await new Promise((resolve) => setImmediate(resolve));
    }

    const stats = summarize(samples);
    console.log(`[perf] reconnect-replay n=${samples.length} ${formatStats(stats)}`);
    for (const sample of samples) {
      expect(
        sample,
        `reconnect->first-replay ${sample.toFixed(2)}ms >= 1000ms (${formatStats(stats)}); ` +
          `samples=${rawSamples(samples)}`,
      ).toBeLessThan(1000);
    }
  });

  it("warm reuse: a second append-only round spawns no new driver", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const { host } = rig;
    const scope = await createActiveScope(host, "req-perf-0003", ["p-1"]);
    const driver = rig.drivers.get("p-1") as FakeDriver;
    expect(driver.prewarmCount).toBe(1);
    expect(rig.drivers.size).toBe(1);

    // Round 1.
    const round1 = await api<{ execution: { state: string } }>(
      host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        executionId: "exec-perf-warm-1",
        participantId: "p-1",
        snapshot: snapshot("p-1", [{ id: "m1", content: "first message" }], "answer turn 1", 1),
      },
    );
    expect(round1.status).toBe(200);
    const stream1 = await streamRuntimeEvents(
      host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-perf-warm-1/events`,
      (event) => event.type === "completed",
    );
    expect(stream1.events.at(-1)?.type).toBe("completed");

    // Round 2: strict append on the same participant.
    const round2 = await api<{ execution: { state: string } }>(
      host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        executionId: "exec-perf-warm-2",
        participantId: "p-1",
        snapshot: snapshot(
          "p-1",
          [
            { id: "m1", content: "first message" },
            { id: "m2", content: "appended follow-up" },
          ],
          "answer turn 2",
          2,
        ),
      },
    );
    expect(round2.status).toBe(200);
    const stream2 = await streamRuntimeEvents(
      host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-perf-warm-2/events`,
      (event) => event.type === "completed",
    );
    expect(stream2.events.at(-1)?.type).toBe("completed");

    // prewarm is the spawn proxy for the in-process fakes: a warm second
    // round must not spawn/re-init anything.
    expect(driver.prewarmCount).toBe(1);
    expect(driver.closeCount).toBe(0);
    expect(rig.drivers.size).toBe(1);
    expect(driver.executeCalls.length).toBe(2);
    expect(driver.executeCalls[0]?.coldStart).toBe(true);
    expect(driver.executeCalls[1]?.coldStart).toBe(false);
    expect(driver.executeCalls[1]?.prompt).toContain("appended follow-up");
    expect(driver.executeCalls[1]?.prompt).not.toContain("first message");
  });
});
