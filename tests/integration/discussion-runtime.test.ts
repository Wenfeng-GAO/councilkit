import "fake-indexeddb/auto";

import {
  beginExecution,
  createRound,
  markExecutionDispatched,
  transitionRound,
} from "@/lib/discussion-transactions";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
} from "@/models/discussion/factories";
import { computeInstructionDigest, initializeRoomDigest } from "@/orchestrator/context-snapshot";
import { createDiscussionOrchestrator } from "@/orchestrator/discussion-orchestrator";
import { RuntimeClient } from "@/runtime/client";
import { followExecutionEvents } from "@/runtime/event-stream";
import type {
  Emit,
  ExecuteInput,
  ParticipantDriver,
  PrewarmInput,
  PrewarmResult,
} from "@host/drivers/types";
import {
  type ExecutionRegistry,
  createExecutionRegistry,
} from "@host/executions/execution-registry";
import type { InstallationRecord, InstallationRegistry } from "@host/installations/registry";
import type { Logger } from "@host/logging";
import { scopeRoutes } from "@host/routes/scopes";
import { type ScopeManager, createScopeManager } from "@host/scopes/scope-manager";
import { createSessionReconciler } from "@host/scopes/session-reconciler";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import type { RuntimeEvent } from "@shared/runtime/events";
import type { ContextSnapshot, InstallationDto, ParticipantSpec } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "../host/helpers";

/**
 * Discussion ↔ Runtime integration (U5): a real HTTP Host (real scope
 * manager / execution registry / reconciler with in-process fake drivers),
 * the real RuntimeClient, the real persistent Orchestrator and Dexie on
 * fake-indexeddb. Covers: end-to-end two-round flow, SSE afterSeq resume,
 * cancel → discarded ACK, and Host-restart convergence.
 *
 * Regression note: an earlier version of this suite needed an ActivatingClient
 * subclass because the orchestrator never activated the Host scope (fixed in
 * the U6 pre-pass — ensureScope now activates before persisting the binding).
 * The plain RuntimeClient below is the load-bearing proof of that fix: scope
 * state is enforced by the real Host.
 */

// ---------------------------------------------------------------------------
// Fakes (mirrors tests/integration/runtime-host.test.ts)
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

const nullLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  diagnostic: () => undefined,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Rig: real Host + real scope stack + fake drivers
// ---------------------------------------------------------------------------

interface Rig {
  host: TestHost;
  scopeManager: ScopeManager;
  executions: ExecutionRegistry;
  drivers: Map<string, FakeDriver>;
  /** Ordered cross-participant dispatch log (execution order proof). */
  callLog: { participantId: string; executionId: string }[];
}

async function createRig(hostInstanceId: string): Promise<Rig> {
  const drivers = new Map<string, FakeDriver>();
  const callLog: { participantId: string; executionId: string }[] = [];
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
        const original = driver.execute.bind(driver);
        driver.execute = (input: ExecuteInput, emit: Emit) => {
          callLog.push({ participantId, executionId: input.executionId });
          return original(input, emit);
        };
        drivers.set(participantId, driver);
        return driver;
      },
    },
    logger: nullLogger,
    hostInstanceId,
  });
  const host = await createTestHost({
    extraServices: {
      hostInstanceId,
      installationRegistry: installations,
      executionRegistry: executions,
      scopeManager,
      driverCapabilities: () => [{ driverId: "codex-app-server", capability: "ready" }],
    },
    routesFactory: (services) => [...scopeRoutes(services)],
  });
  return { host, scopeManager, executions, drivers, callLog };
}

function clientFor(host: TestHost): RuntimeClient {
  return new RuntimeClient({
    baseUrl: host.baseUrl,
    csrfToken: host.session.csrfToken,
    headers: {
      Cookie: host.session.sessionCookieValue().split(";")[0] as string,
      Origin: "http://127.0.0.1:43127",
    },
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers (raw calls, for tombstone probes)
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
  if (!envelope.ok) return { status: response.status, data: envelope.error as T };
  return { status: response.status, data: envelope.data as T };
}

function spec(participantId: string): ParticipantSpec {
  return {
    participantId,
    profile: {
      driverId: "codex-app-server",
      installationId: FAKE_INSTALLATION_DTO.installationId,
      credentialMode: CREDENTIAL_MODE,
      options: {},
    },
    modelId: "fake-model-1",
  };
}

function snapshot(participantId: string, instruction: string): ContextSnapshot {
  return {
    digestVersion: 1,
    roomContext: {
      contextRevision: 1,
      contextDigest: "digest-r1",
      items: [{ id: "m1", role: "user", content: "first message" }],
    },
    participant: { participantId, participantSnapshotDigest: "participant-digest-1" },
    instruction: { kind: "message", instructionDigest: "instr-1", text: instruction },
  };
}

// ---------------------------------------------------------------------------
// Dexie seed
// ---------------------------------------------------------------------------

let db: CouncilKitRuntimeDB;

async function seedBase() {
  const ts = new Date().toISOString();
  await db.executionProfiles.put({
    id: "prof-1",
    name: "Profile 1",
    driverId: "codex-app-server",
    installationId: FAKE_INSTALLATION_DTO.installationId,
    credentialMode: CREDENTIAL_MODE,
    options: {},
    revision: 1,
    createdAt: ts,
    updatedAt: ts,
  });
  const agent1 = createDiscussionAgent({
    name: "A1",
    personaPrompt: "p1 persona",
    executionProfileId: "prof-1",
    modelId: "fake-model-1",
    color: "#a1b2c3",
  });
  const agent2 = createDiscussionAgent({
    name: "A2",
    personaPrompt: "p2 persona",
    executionProfileId: "prof-1",
    modelId: "fake-model-1",
    color: "#b2c3d4",
  });
  await db.agents.bulkAdd([agent1, agent2]);
  const room = initializeRoomDigest(
    createDiscussionRoom({ topic: "Topic", background: "bg", facilitatorParticipantId: "pending" }),
  );
  await db.rooms.add(room);
  const p1 = createParticipant({ roomId: room.id, agent: agent1, profileDigest: "pd1" });
  const p2 = createParticipant({ roomId: room.id, agent: agent2, profileDigest: "pd2" });
  // Deterministic participant order (activeParticipants sorts by createdAt).
  p1.createdAt = "2026-07-17T00:00:00.000Z";
  p2.createdAt = "2026-07-17T00:00:00.001Z";
  await db.participants.bulkAdd([p1, p2]);
  room.facilitatorParticipantId = p1.id;
  await db.rooms.put(room);
  return { room, p1, p2 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const rigs: Rig[] = [];

beforeEach(() => {
  db = new CouncilKitRuntimeDB(`test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop() as Rig;
    await rig.scopeManager.closeAll("test-cleanup").catch(() => undefined);
    await rig.host.cleanup();
  }
  await db.delete();
  db.close();
});

describe("discussion runtime integration (U5)", () => {
  it("1. end-to-end: two full rounds through the real Host with persist→ACK per turn", async () => {
    const rig = await createRig("integration-host-1");
    rigs.push(rig);
    const { room, p1, p2 } = await seedBase();
    const client = clientFor(rig.host);
    const orchestrator = createDiscussionOrchestrator({ db, client });
    await orchestrator.ensureScope(room.id, [p1, p2]);

    const round1 = await orchestrator.startRound(room.id);
    expect(round1?.phase).toBe("completed");
    const round2 = await orchestrator.startRound(room.id);
    expect(round2?.phase).toBe("completed");

    // Per round: p1 message → p2 message → p1 (facilitator) summary.
    expect(rig.callLog.map((call) => call.participantId)).toEqual([
      p1.id,
      p2.id,
      p1.id,
      p1.id,
      p2.id,
      p1.id,
    ]);
    expect(rig.drivers.get(p1.id)?.prewarmCount).toBe(1);
    expect(rig.drivers.get(p2.id)?.prewarmCount).toBe(1);

    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(4);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(2);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(6);
    const executions = await db.modelExecutions.where("roomId").equals(room.id).toArray();
    expect(executions).toHaveLength(6);
    for (const execution of executions) {
      expect(execution.state).toBe("committed");
      expect(execution.ackState).toBe("acknowledged");
    }
    const summaries = executions.filter((execution) => execution.resultKind === "summary");
    expect(summaries).toHaveLength(2);
    expect(summaries.every((execution) => execution.participantId === p1.id)).toBe(true);

    // ACK tombstones on the Host are idempotent: a repeat returns the same
    // outcome, a conflicting disposition is rejected — never re-executed.
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((candidate) => candidate.state === "active")
      .first();
    const firstExecution = executions.find((execution) => execution.resultKind === "message");
    const ackPath = `/api/v1/scopes/${binding?.executionScopeId}/executions/${firstExecution?.executionId}/ack`;
    const ackBody = {
      controllerId: binding?.controllerId,
      leaseEpoch: binding?.leaseEpoch,
      finalSeq: firstExecution?.finalEventSeq,
      disposition: "committed",
    };
    const repeat = await api<{ ackState: string }>(rig.host, "POST", ackPath, ackBody);
    expect(repeat.status).toBe(200);
    expect(repeat.data.ackState).toBe("acknowledged");
    const conflict = await api<{ code: string }>(rig.host, "POST", ackPath, {
      ...ackBody,
      disposition: "discarded",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.data.code).toBe("EXECUTION_CONFLICT");
    expect(rig.callLog).toHaveLength(6);
  });

  it("2. resumes the event stream with afterSeq: strictly-greater replay, never re-dispatched", async () => {
    const rig = await createRig("integration-host-2");
    rigs.push(rig);
    const client = clientFor(rig.host);
    const created = await client.createScope({
      scopeRequestId: "req-events-0001",
      participants: [spec("p-1")],
    });
    const controller = { controllerId: created.controllerId, leaseEpoch: created.leaseEpoch };
    await client.activateScope(created.scopeId, controller);
    const executed = await client.execute(created.scopeId, {
      ...controller,
      executionId: "exec-resume-0001",
      participantId: "p-1",
      snapshot: snapshot("p-1", "answer turn 1"),
    });
    expect(executed.execution.state).toBe("running");

    // First read (live or replayed): the full stream in order.
    const first: RuntimeEvent[] = [];
    const firstOutcome = await followExecutionEvents({
      fetchInput: client.eventStreamFetch({
        scopeId: created.scopeId,
        executionId: "exec-resume-0001",
        afterSeq: 0,
      }),
      onEvent: (event) => {
        first.push(event);
      },
    });
    expect(firstOutcome.kind).toBe("terminal");
    expect(first.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

    // The page reconnects after a disconnect at seq 2: strictly-greater
    // replay only, and the model was never re-invoked.
    const second: RuntimeEvent[] = [];
    const secondOutcome = await followExecutionEvents({
      fetchInput: client.eventStreamFetch({
        scopeId: created.scopeId,
        executionId: "exec-resume-0001",
        afterSeq: 2,
      }),
      onEvent: (event) => {
        second.push(event);
      },
    });
    expect(secondOutcome.kind).toBe("terminal");
    expect(second.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(rig.drivers.get("p-1")?.executeCalls).toHaveLength(1);
  });

  it("3. cancel: the in-flight execution is discarded and the discarded ACK reaches the Host", async () => {
    const rig = await createRig("integration-host-3");
    rigs.push(rig);
    const { room, p1, p2 } = await seedBase();
    const client = clientFor(rig.host);
    const previews: RuntimeEvent[] = [];
    const orchestrator = createDiscussionOrchestrator({
      db,
      client,
      display: {
        onPreview: (_roomId, event) => {
          previews.push(event);
        },
      },
    });
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // Switch p1's driver to hang-until-cancel (same pattern as the Host suite).
    const driver = rig.drivers.get(p1.id) as FakeDriver;
    const hanging = createFakeDriver(p1.id, { hangUntilCancel: true });
    driver.execute = hanging.execute;
    driver.cancel = hanging.cancel;

    const roundPromise = orchestrator.startRound(room.id);
    await vi.waitFor(() => {
      expect(previews.some((event) => event.type === "started")).toBe(true);
    });
    await orchestrator.cancelActiveExecution(room.id);
    const round = await roundPromise;

    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.code).toBe("user_cancelled");
    const execution = (await db.modelExecutions.where("roomId").equals(room.id).toArray())[0];
    expect(execution?.state).toBe("discarded");
    expect(execution?.runtimeOutcome).toBe("user_cancelled");
    // Interrupted terminals carry no inline ACK; the recovery scan delivers it.
    expect(execution?.ackState).toBe("pending");

    const auditor = createDiscussionOrchestrator({ db, client });
    await auditor.startupAudit();
    expect((await db.modelExecutions.get(execution?.executionId ?? ""))?.ackState).toBe(
      "acknowledged",
    );
    const record = rig.executions.get(execution?.executionId ?? "");
    expect(record?.disposition).toBe("discarded");
    expect(record?.ackState).toBe("acknowledged");
    expect(record?.tombstone).toBe(true);
  });

  it("4. Host restart: audit expires the pending ACK, pauses unfinished work, keeps bodies", async () => {
    const rig1 = await createRig("integration-host-4a");
    rigs.push(rig1);
    const { room, p1, p2 } = await seedBase();
    const client1 = clientFor(rig1.host);
    const orchestrator1 = createDiscussionOrchestrator({ db, client: client1 });
    await orchestrator1.ensureScope(room.id, [p1, p2]);
    const round1 = await orchestrator1.startRound(room.id);
    expect(round1?.phase).toBe("completed");

    // Craft the crash window: the summary is committed but its ACK never landed.
    const summaryExecution = (
      await db.modelExecutions.where("roomId").equals(room.id).toArray()
    ).find((execution) => execution.resultKind === "summary");
    await db.modelExecutions.update(summaryExecution?.executionId ?? "", { ackState: "pending" });

    // An unfinished round-2 execution, dispatched on the old Host.
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((candidate) => candidate.state === "active")
      .first();
    const token = {
      controllerId: binding?.controllerId as string,
      leaseEpoch: binding?.leaseEpoch as number,
    };
    const round2 = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, { roomId: room.id, roundId: round2.id, token, to: "prewarming" });
    await transitionRound(db, { roomId: room.id, roundId: round2.id, token, to: "running" });
    const roomRow = await db.rooms.get(room.id);
    const pendingExecution = createModelExecution({
      executionId: "exec-restart-unfinished",
      roomId: room.id,
      roundId: round2.id,
      participantId: p1.id,
      resultKind: "message",
      requestedModel: p1.modelId,
      contextRevision: roomRow?.contextRevision ?? 0,
      expectedRoomDigest: roomRow?.contextDigest ?? "",
      participantSnapshotDigest: p1.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest({ kind: "message", text: "answer" }),
    });
    await beginExecution(db, { execution: pendingExecution, token });
    await markExecutionDispatched(db, {
      executionId: pendingExecution.executionId,
      hostInstanceId: "integration-host-4a",
      executionScopeId: binding?.executionScopeId as string,
      dispatchState: "unknown",
    });

    // "Restart": the old Host dies; a new instance comes up with an empty store.
    await rig1.scopeManager.closeAll("host-restart").catch(() => undefined);
    await rig1.host.cleanup();
    const rig2 = await createRig("integration-host-4b");
    rigs.push(rig2);
    const orchestrator2 = createDiscussionOrchestrator({ db, client: clientFor(rig2.host) });
    await orchestrator2.startupAudit();

    expect((await db.modelExecutions.get(summaryExecution?.executionId ?? ""))?.ackState).toBe(
      "expired",
    );
    const unfinished = await db.modelExecutions.get(pendingExecution.executionId);
    expect(unfinished?.state).toBe("interrupted");
    expect(unfinished?.error?.code).toBe("SAFE_INTERRUPTION");
    const storedRound2 = await db.rounds.get(round2.id);
    expect(storedRound2?.phase).toBe("paused");
    expect(storedRound2?.pauseReason?.code).toBe("execution_failed");

    // Committed round 1 untouched; the model was never re-invoked anywhere.
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(2);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(1);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(3);
    expect(rig2.callLog).toHaveLength(0);
  });
});
