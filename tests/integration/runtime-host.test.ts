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
 * End-to-end integration: real HTTP Host + real scope manager / execution
 * registry / reconciler with in-process fake drivers (no child processes).
 * Covers the V1 control flow: scope create → activate → execute → SSE
 * live/replay → ACK tombstone → cancel → fencing → idempotency → close.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDriver extends ParticipantDriver {
  sessionEpoch: number;
  prewarmCount: number;
  closeCount: number;
  cancelCount: number;
  executeCalls: { executionId: string; prompt: string; modelId: string; coldStart: boolean }[];
}

function createFakeDriver(
  participantId: string,
  options: { reply?: string; hangUntilCancel?: boolean } = {},
): FakeDriver {
  const reply = options.reply ?? `answer-from-${participantId}`;
  const fake: FakeDriver = {
    participantId,
    driverId: "codex-app-server",
    sessionEpoch: 0,
    prewarmCount: 0,
    closeCount: 0,
    cancelCount: 0,
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
      if (options.hangUntilCancel) {
        emit({ type: "started", requestedModel: input.modelId });
        return new Promise<void>((resolvePromise) => {
          pendingCancel = () => {
            emit({
              type: "interrupted",
              reason: "user_cancelled",
              dispatchState: "accepted",
              toolState: "none",
            });
            resolvePromise();
          };
        });
      }
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
      fake.cancelCount += 1;
      pendingCancel?.();
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
  let pendingCancel: (() => void) | null = null;
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

const nullLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  diagnostic: () => undefined,
} as unknown as import("@host/logging").Logger;

// ---------------------------------------------------------------------------
// HTTP helpers
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

/** Collects SSE runtime events until `until` matches or the deadline hits. */
async function collectEvents(
  host: TestHost,
  path: string,
  until: (event: RuntimeEvent) => boolean,
  timeoutMs = 5_000,
): Promise<RuntimeEvent[]> {
  const controller = new AbortController();
  const response = await fetch(`${host.baseUrl}${path}`, {
    headers: authedHeaders(host),
    signal: controller.signal,
  });
  if (!response.body) throw new Error("no SSE body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: RuntimeEvent[] = [];
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
          const event = JSON.parse(dataLine.slice(6)) as RuntimeEvent;
          events.push(event);
          if (until(event)) return events;
        }
        index = buffer.indexOf("\n\n");
      }
    }
    return events;
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
  revision = 0,
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

describe("runtime host integration", () => {
  it("two-turn flow: SSE live stream, incremental reuse, ACK tombstone", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const { host } = rig;
    const scope = await createActiveScope(host, "req-scope-0001", ["p-1"]);
    const driver = rig.drivers.get("p-1") as FakeDriver;
    expect(driver.prewarmCount).toBe(1);

    // --- turn 1 ---
    const exec1 = await api<{ execution: { state: string; lastSeq: number } }>(
      host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        executionId: "exec-0001-turn1",
        participantId: "p-1",
        snapshot: snapshot("p-1", [{ id: "m1", content: "first message" }], "answer turn 1", 1),
      },
    );
    expect(exec1.status).toBe(200);
    expect(exec1.data.execution.state).toBe("running");

    const events1 = await collectEvents(
      host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0001-turn1/events`,
      (event) => event.type === "completed",
    );
    const types1 = events1.map((event) => event.type);
    expect(types1).toEqual(["started", "output.delta", "output.delta", "usage", "completed"]);
    for (let i = 0; i < events1.length; i += 1) {
      expect(events1[i]?.seq).toBe(i + 1);
    }
    const terminal1 = events1.at(-1);
    if (terminal1?.type !== "completed") throw new Error("expected completed terminal");
    expect(terminal1.output).toBe("answer-from-p-1");
    expect(terminal1.finalSeq).toBe(5);

    // ACK idempotency + tombstone.
    const ack1 = await api<{ ackState: string }>(
      host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0001-turn1/ack`,
      { ...ctrl(scope), finalSeq: terminal1.finalSeq, disposition: "committed" },
    );
    expect(ack1.status).toBe(200);
    expect(ack1.data.ackState).toBe("acknowledged");
    const ackRepeat = await api<{ ackState: string }>(
      host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0001-turn1/ack`,
      { ...ctrl(scope), finalSeq: terminal1.finalSeq, disposition: "committed" },
    );
    expect(ackRepeat.status).toBe(200);
    expect(ackRepeat.data.ackState).toBe("acknowledged");
    const ackConflict = await api<{ code: string }>(
      host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0001-turn1/ack`,
      { ...ctrl(scope), finalSeq: terminal1.finalSeq, disposition: "discarded" },
    );
    expect(ackConflict.status).toBe(409);
    expect(ackConflict.data.code).toBe("EXECUTION_CONFLICT");

    // Tombstoned stream replays nothing.
    const afterAck = await collectEvents(
      host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0001-turn1/events`,
      () => false,
      400,
    );
    expect(afterAck).toEqual([]);

    // --- turn 2: strict append -> incremental prompt on the same session ---
    const exec2 = await api<{ execution: { state: string } }>(
      host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        executionId: "exec-0002-turn2",
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
    expect(exec2.status).toBe(200);
    await collectEvents(
      host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0002-turn2/events`,
      (event) => event.type === "completed",
    );
    expect(driver.executeCalls.length).toBe(2);
    const turn1Prompt = driver.executeCalls[0]?.prompt as string;
    const turn2Call = driver.executeCalls[1];
    expect(turn2Call?.coldStart).toBe(false);
    expect(turn2Call?.prompt).toContain("appended follow-up");
    expect(turn2Call?.prompt).not.toContain("first message");
    expect(turn1Prompt).toContain("first message");
    expect(driver.prewarmCount).toBe(1);
  });

  it("afterSeq replays strictly greater seq only", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const scope = await createActiveScope(rig.host, "req-scope-0002", ["p-1"]);
    await api(rig.host, "POST", `/api/v1/scopes/${scope.scopeId}/executions`, {
      ...ctrl(scope),
      executionId: "exec-0003-resume",
      participantId: "p-1",
      snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 1),
    });
    await collectEvents(
      rig.host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0003-resume/events`,
      (event) => event.type === "completed",
    );
    const fromThree = await collectEvents(
      rig.host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0003-resume/events?afterSeq=3`,
      (event) => event.type === "completed",
    );
    expect(fromThree.map((event) => event.seq)).toEqual([4, 5]);
    const fromEnd = await collectEvents(
      rig.host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0003-resume/events?afterSeq=5`,
      () => false,
      400,
    );
    expect(fromEnd).toEqual([]);
  });

  it("divergent history fails NEEDS_REBASE and never re-dispatches the driver", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const scope = await createActiveScope(rig.host, "req-scope-0003", ["p-1"]);
    const driver = rig.drivers.get("p-1") as FakeDriver;
    await api(rig.host, "POST", `/api/v1/scopes/${scope.scopeId}/executions`, {
      ...ctrl(scope),
      executionId: "exec-0004-first",
      participantId: "p-1",
      snapshot: snapshot("p-1", [{ id: "m1", content: "original" }], "go", 1),
    });
    await collectEvents(
      rig.host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0004-first/events`,
      (event) => event.type === "completed",
    );

    const diverged = await api<{ execution: { state: string; lastSeq: number } }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        executionId: "exec-0005-diverged",
        participantId: "p-1",
        snapshot: snapshot(
          "p-1",
          [
            { id: "m1", content: "EDITED history" },
            { id: "m2", content: "new" },
          ],
          "go again",
          2,
        ),
      },
    );
    expect(diverged.status).toBe(200);
    expect(diverged.data.execution.state).toBe("failed");
    const events = await collectEvents(
      rig.host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0005-diverged/events`,
      (event) => event.type === "failed",
    );
    const failed = events.at(-1);
    if (failed?.type !== "failed") throw new Error("expected failed terminal");
    expect(failed.error.code).toBe("NEEDS_REBASE");
    expect(failed.dispatchState).toBe("not_dispatched");
    expect(driver.executeCalls.length).toBe(1);
  });

  it("controller fencing: stale epoch rejected, takeover rotates", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const scope = await createActiveScope(rig.host, "req-scope-0004", ["p-1"]);

    const stale = await api<{ code: string }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        leaseEpoch: 999,
        executionId: "exec-0006-stale",
        participantId: "p-1",
        snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 1),
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.data.code).toBe("STALE_CONTROLLER");

    const takeover = await api<{ controllerId: string; leaseEpoch: number }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/controller`,
      { controllerId: "ctrl-new-owner" },
    );
    expect(takeover.status).toBe(200);
    expect(takeover.data.leaseEpoch).toBe(scope.leaseEpoch + 1);

    const oldController = await api<{ code: string }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        executionId: "exec-0007-old-owner",
        participantId: "p-1",
        snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 1),
      },
    );
    expect(oldController.status).toBe(409);

    const newScope: CreatedScope = {
      scopeId: scope.scopeId,
      controllerId: "ctrl-new-owner",
      leaseEpoch: takeover.data.leaseEpoch,
    };
    const ok = await api(rig.host, "POST", `/api/v1/scopes/${scope.scopeId}/executions`, {
      ...ctrl(newScope),
      executionId: "exec-0008-new-owner",
      participantId: "p-1",
      snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 1),
    });
    expect(ok.status).toBe(200);
  });

  it("createScope is idempotent per scopeRequestId", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const first = await api<{ scopeId: string; controllerId: string }>(
      rig.host,
      "POST",
      "/api/v1/scopes",
      { scopeRequestId: "req-scope-0005", participants: [spec("p-1")] },
    );
    const second = await api<{ scopeId: string; controllerId: string }>(
      rig.host,
      "POST",
      "/api/v1/scopes",
      { scopeRequestId: "req-scope-0005", participants: [spec("p-1")] },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.data.scopeId).toBe(first.data.scopeId);
    expect(second.data.controllerId).toBe(first.data.controllerId);
    const driver = rig.drivers.get("p-1") as FakeDriver;
    expect(driver.prewarmCount).toBe(1);
  });

  it("duplicate executionId returns the same record without re-dispatch", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const scope = await createActiveScope(rig.host, "req-scope-0006", ["p-1"]);
    const driver = rig.drivers.get("p-1") as FakeDriver;
    const request = {
      ...ctrl(scope),
      executionId: "exec-0009-dupe",
      participantId: "p-1",
      snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 1),
    };
    const first = await api<{ execution: { state: string } }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      request,
    );
    expect(first.status).toBe(200);
    await collectEvents(
      rig.host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0009-dupe/events`,
      (event) => event.type === "completed",
    );
    const second = await api<{ execution: { state: string; lastSeq: number } }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      request,
    );
    expect(second.status).toBe(200);
    expect(second.data.execution.state).toBe("completed");
    expect(second.data.execution.lastSeq).toBe(5);
    expect(driver.executeCalls.length).toBe(1);
  });

  it("cancel produces interrupted(user_cancelled) terminal", async () => {
    const rig = await createRig();
    rigs.push(rig);
    // Rebuild a rig whose driver hangs: replace the factory output in place.
    const scope = await createActiveScope(rig.host, "req-scope-0007", ["p-1"]);
    const driver = rig.drivers.get("p-1") as FakeDriver;
    // Switch this driver to hanging mode by monkey-patching execute.
    const hanging = createFakeDriver("p-1", { hangUntilCancel: true });
    driver.execute = hanging.execute;
    driver.cancel = hanging.cancel;

    await api(rig.host, "POST", `/api/v1/scopes/${scope.scopeId}/executions`, {
      ...ctrl(scope),
      executionId: "exec-0010-cancel",
      participantId: "p-1",
      snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 1),
    });
    const cancelled = await api(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0010-cancel/cancel`,
      {
        controllerId: scope.controllerId,
        leaseEpoch: scope.leaseEpoch,
      },
    );
    expect(cancelled.status).toBe(200);
    const events = await collectEvents(
      rig.host,
      `/api/v1/scopes/${scope.scopeId}/executions/exec-0010-cancel/events`,
      (event) => event.type === "interrupted",
    );
    const terminal = events.at(-1);
    if (terminal?.type !== "interrupted") throw new Error("expected interrupted terminal");
    expect(terminal.reason).toBe("user_cancelled");
  });

  it("ACK on an unknown execution converges to expired", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const scope = await createActiveScope(rig.host, "req-scope-0008", ["p-1"]);
    const result = await api<{ ackState: string; disposition: string | null }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions/exec-never-existed/ack`,
      { ...ctrl(scope), finalSeq: 1, disposition: "committed" },
    );
    expect(result.status).toBe(200);
    expect(result.data.ackState).toBe("expired");
    expect(result.data.disposition).toBeNull();
  });

  it("close shuts drivers down and rejects further executions", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const scope = await createActiveScope(rig.host, "req-scope-0009", ["p-1", "p-2"]);
    const closed = await api<{ state: string }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/close`,
      { controllerId: scope.controllerId, leaseEpoch: scope.leaseEpoch },
    );
    expect(closed.status).toBe(200);
    expect(closed.data.state).toBe("closed");
    expect(rig.drivers.get("p-1")?.closeCount).toBe(1);
    expect(rig.drivers.get("p-2")?.closeCount).toBe(1);

    const after = await api<{ code: string }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${scope.scopeId}/executions`,
      {
        ...ctrl(scope),
        executionId: "exec-0011-closed",
        participantId: "p-1",
        snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 1),
      },
    );
    expect(after.status).toBe(409);
    expect(after.data.code).toBe("SCOPE_CLOSED");
  });

  it("a closed scope's participant starts cold in a later scope", async () => {
    const rig = await createRig();
    rigs.push(rig);
    const first = await createActiveScope(rig.host, "req-scope-0010", ["p-1"]);
    await api(rig.host, "POST", `/api/v1/scopes/${first.scopeId}/executions`, {
      ...ctrl(first),
      executionId: "exec-0012-high-rev",
      participantId: "p-1",
      snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 9),
    });
    await collectEvents(
      rig.host,
      `/api/v1/scopes/${first.scopeId}/executions/exec-0012-high-rev/events`,
      (event) => event.type === "completed",
    );
    await api(rig.host, "POST", `/api/v1/scopes/${first.scopeId}/close`, ctrl(first));

    // New scope, same Participant, LOWER revision: must start cold, not
    // needs_rebase — the Execution Session ended with the first scope.
    const second = await createActiveScope(rig.host, "req-scope-0011", ["p-1"]);
    const turned = await api<{ execution: { state: string } }>(
      rig.host,
      "POST",
      `/api/v1/scopes/${second.scopeId}/executions`,
      {
        ...ctrl(second),
        executionId: "exec-0013-low-rev",
        participantId: "p-1",
        snapshot: snapshot("p-1", [{ id: "m1", content: "x" }], "go", 1),
      },
    );
    expect(turned.status).toBe(200);
    expect(turned.data.execution.state).toBe("running");
    const events = await collectEvents(
      rig.host,
      `/api/v1/scopes/${second.scopeId}/executions/exec-0013-low-rev/events`,
      (event) => event.type === "completed" || event.type === "failed",
    );
    expect(events.at(-1)?.type).toBe("completed");
  });
});
