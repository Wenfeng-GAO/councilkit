import "fake-indexeddb/auto";

import {
  type ControllerToken,
  activateRuntimeBinding,
  beginExecution,
  createRound,
  createRuntimeBindingTx,
  markExecutionDispatched,
  transitionRound,
} from "@/lib/discussion-transactions";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { DiscussionRoom, DiscussionRound, Participant } from "@/models/discussion/entities";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
} from "@/models/discussion/factories";
import type { ModelExecution } from "@/models/discussion/model-execution";
import { handleCompletedExecution } from "@/orchestrator/commit-execution";
import { initializeRoomDigest } from "@/orchestrator/context-snapshot";
import { RuntimeClient } from "@/runtime/client";
import type { CompletedEvent } from "@shared/runtime/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * commit-execution ACK edges that the round-driving suites do not reach:
 * null effective model, host-instance mismatch, missing finalSeq, expired /
 * pending / 404 / 5xx ACK replies, unknown execution ids, and discard replay.
 */

const FIXED_NOW = "2026-07-17T03:04:05.000Z";
const SCOPE_ID = "scope-1";
const HOST_ID = "host-1";
const TOKEN: ControllerToken = { controllerId: "ctrl-1", leaseEpoch: 1 };
const BASE_URL = "http://runtime-host.invalid";
const EMPTY_ROOM_DIGEST = "f9a5c7675f35c60c2e06ce99591a9d0e0d4a413912306e16abc5b529aeaa0d09";
const INSTRUCTION_DIGEST = "c68bb103b6636b8b050f8747869281728975f57a84b5051bcc04571fdd37bc50";
const PARTICIPANT_DIGEST = "ae5dde98cfda30d454bbf39d3521f8b2825d3284cf23a73f88cabf18011b4246";

const CONTENT_DIGEST = {
  "host moved": "ae511b416a3440fee8062cf79bf2702e74888ac8eedd80b42f6f68381d931a3f",
  "seq skipped": "050d7c46e56a6d8ae3bbca47e7d0997a07f012dfc0b6e64cc8886d506d4ddcb5",
  "pending body": "9688a749d2a03a34e68ea10297654a7ef59e9d601a461fe04c3448efb02d7cf2",
  "expired body": "3ce1e21b4b555ec48eede4b6e63f4c236b26e329fc62cd5302743a537ce895ed",
  "missing terminal": "fd83b1618d0e2b734d526b6633da9d96ed16869901f9ed5f4becc2125db93989",
} as const;

interface AckCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: {
    controllerId: string;
    leaseEpoch: number;
    finalSeq: number;
    disposition: "committed" | "discarded";
  };
}

type AckScript =
  | { kind: "acknowledged" | "expired" | "pending" }
  | { kind: "status"; status: number; code: string; message: string }
  | { kind: "throw"; error: Error };

interface Seed {
  room: DiscussionRoom;
  p1: Participant;
  round: DiscussionRound;
}

let db: CouncilKitRuntimeDB;
const ackCalls: AckCall[] = [];
let ackScript: AckScript = { kind: "acknowledged" };

function ackFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const body = JSON.parse(String(init?.body)) as AckCall["body"];
  const headers = { ...(init?.headers as Record<string, string>) };
  ackCalls.push({ url, method: String(init?.method), headers, body });
  if (ackScript.kind === "throw") return Promise.reject(ackScript.error);
  if (ackScript.kind === "status") {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: ackScript.code, message: ackScript.message },
        }),
        { status: ackScript.status, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  const executionId = url.split("/").at(-2) ?? "";
  return Promise.resolve(
    new Response(
      JSON.stringify({
        ok: true,
        data: {
          executionId,
          ackState: ackScript.kind,
          disposition: body.disposition,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function client(): RuntimeClient {
  return new RuntimeClient({
    baseUrl: BASE_URL,
    csrfToken: "csrf-token",
    fetchFn: ackFetch,
  });
}

function completed(executionId: string, over: Partial<CompletedEvent> = {}): CompletedEvent {
  return {
    executionId,
    seq: 7,
    at: FIXED_NOW,
    type: "completed",
    output: "mismatch output",
    requestedModel: "model-a",
    effectiveModel: "model-a",
    modelVerdict: "match",
    toolState: "none",
    dispatchState: "accepted",
    usage: { inputTokens: 11, outputTokens: 7, costUsd: null },
    finalSeq: 7,
    ...over,
  };
}

async function seedRunning(): Promise<Seed> {
  const agent = createDiscussionAgent({
    name: "A1",
    personaPrompt: "p1 persona",
    executionProfileId: "prof-1",
    modelId: "model-a",
    color: "#a1b2c3",
  });
  await db.agents.add(agent);
  const room = initializeRoomDigest(
    createDiscussionRoom({ topic: "Topic", background: "bg", facilitatorParticipantId: "pending" }),
  );
  await db.rooms.add(room);
  const p1 = createParticipant({ roomId: room.id, agent, profileDigest: "pd1" });
  await db.participants.add(p1);
  room.facilitatorParticipantId = p1.id;
  await db.rooms.put(room);
  const binding = await createRuntimeBindingTx(db, {
    roomId: room.id,
    scopeRequestId: "scope-request-1",
  });
  await activateRuntimeBinding(db, {
    id: binding.id,
    hostInstanceId: HOST_ID,
    executionScopeId: SCOPE_ID,
    controllerId: TOKEN.controllerId,
    leaseEpoch: TOKEN.leaseEpoch,
  });
  const round = await createRound(db, {
    roomId: room.id,
    token: TOKEN,
    participantOrder: [p1.id, "p-later"],
  });
  await transitionRound(db, { roomId: room.id, roundId: round.id, token: TOKEN, to: "prewarming" });
  await transitionRound(db, { roomId: room.id, roundId: round.id, token: TOKEN, to: "running" });
  await db.rounds.update(round.id, { focusMessageId: "focus-msg-1" });
  const storedRound = (await db.rounds.get(round.id)) as DiscussionRound;
  return { room, p1, round: storedRound };
}

async function dispatchMessage(seed: Seed, executionId: string): Promise<ModelExecution> {
  const execution = createModelExecution({
    executionId,
    roomId: seed.room.id,
    roundId: seed.round.id,
    participantId: seed.p1.id,
    resultKind: "message",
    requestedModel: "model-a",
    contextRevision: 0,
    expectedRoomDigest: EMPTY_ROOM_DIGEST,
    participantSnapshotDigest: PARTICIPANT_DIGEST,
    instructionDigest: INSTRUCTION_DIGEST,
  });
  await beginExecution(db, { execution, token: TOKEN });
  await markExecutionDispatched(db, {
    executionId,
    hostInstanceId: HOST_ID,
    executionScopeId: SCOPE_ID,
    dispatchState: "accepted",
  });
  return execution;
}

function deps(currentHostInstanceId = HOST_ID) {
  return {
    db,
    client: client(),
    scopeId: SCOPE_ID,
    token: TOKEN,
    currentHostInstanceId,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_NOW));
  ackCalls.length = 0;
  ackScript = { kind: "acknowledged" };
  db = new CouncilKitRuntimeDB(`commit-ack-${crypto.randomUUID()}`);
});

afterEach(async () => {
  vi.useRealTimers();
  await db.delete();
  db.close();
});

describe("handleCompletedExecution ACK edges", () => {
  it("throws when the execution id is not in Dexie", async () => {
    await expect(
      handleCompletedExecution(deps(), "exec-missing", completed("exec-missing")),
    ).rejects.toThrow("handleCompletedExecution: unknown execution exec-missing");
    expect(ackCalls).toEqual([]);
  });

  it("discards a null effective model as model_mismatch and ACKs discarded", async () => {
    const seed = await seedRunning();
    const executionId = "exec-null-model";
    await dispatchMessage(seed, executionId);
    const event = completed(executionId, {
      output: "mismatch output",
      effectiveModel: null,
      modelVerdict: "match",
    });

    const result = await handleCompletedExecution(deps(), executionId, event);

    expect(result).toEqual({ kind: "discarded", runtimeOutcome: "model_mismatch" });
    expect(ackCalls).toEqual([
      {
        url: `${BASE_URL}/api/v1/scopes/${SCOPE_ID}/executions/${executionId}/ack`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-councilkit-csrf": "csrf-token",
        },
        body: {
          controllerId: "ctrl-1",
          leaseEpoch: 1,
          finalSeq: 7,
          disposition: "discarded",
        },
      },
    ]);
    expect(await db.messages.where("roomId").equals(seed.room.id).toArray()).toEqual([]);
    expect(await db.modelExecutions.get(executionId)).toEqual({
      executionId,
      roomId: seed.room.id,
      roundId: seed.round.id,
      participantId: seed.p1.id,
      resultKind: "message",
      state: "discarded",
      hostInstanceId: HOST_ID,
      executionScopeId: SCOPE_ID,
      requestedModel: "model-a",
      effectiveModel: null,
      dispatchState: "accepted",
      toolState: "none",
      contextRevision: 0,
      expectedRoomDigest: EMPTY_ROOM_DIGEST,
      participantSnapshotDigest: PARTICIPANT_DIGEST,
      instructionDigest: INSTRUCTION_DIGEST,
      contentDigest: null,
      committedEntityType: null,
      committedEntityId: null,
      runtimeOutcome: "model_mismatch",
      usage: { inputTokens: 11, outputTokens: 7, costUsd: null },
      error: {
        code: "MODEL_MISMATCH",
        phase: "stream",
        message: "requested model-a, effective unknown, verdict match",
        retryable: false,
      },
      finalEventSeq: 7,
      ackState: "acknowledged",
      retryOfExecutionId: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    expect(await db.rounds.get(seed.round.id)).toEqual({
      id: seed.round.id,
      roomId: seed.room.id,
      roundNumber: 1,
      participantOrder: [seed.p1.id, "p-later"],
      phase: "paused",
      pausedFrom: "running",
      pauseReason: {
        code: "model_mismatch",
        participantId: seed.p1.id,
        executionId,
      },
      nextParticipantIndex: 0,
      activeExecutionId: null,
      focusMessageId: "focus-msg-1",
      createdAt: FIXED_NOW,
      completedAt: null,
    });
    const room = await db.rooms.get(seed.room.id);
    expect(room?.contextRevision).toBe(0);
    expect(room?.contextDigest).toBe(EMPTY_ROOM_DIGEST);
  });

  it("replays an identical discard and re-ACKs with the execution id", async () => {
    const seed = await seedRunning();
    const executionId = "exec-discard-replay";
    await dispatchMessage(seed, executionId);
    const event = completed(executionId, {
      output: "mismatch output",
      effectiveModel: null,
      modelVerdict: "mismatch",
    });

    const first = await handleCompletedExecution(deps(), executionId, event);
    const second = await handleCompletedExecution(deps(), executionId, event);

    expect(first).toEqual({ kind: "discarded", runtimeOutcome: "model_mismatch" });
    expect(second).toEqual({ kind: "replayed", entityId: executionId });
    expect(ackCalls.map((call) => call.body)).toEqual([
      { controllerId: "ctrl-1", leaseEpoch: 1, finalSeq: 7, disposition: "discarded" },
      { controllerId: "ctrl-1", leaseEpoch: 1, finalSeq: 7, disposition: "discarded" },
    ]);
    expect(await db.messages.count()).toBe(0);
    const stored = await db.modelExecutions.get(executionId);
    expect(stored?.state).toBe("discarded");
    expect(stored?.ackState).toBe("acknowledged");
    expect(stored?.error).toEqual({
      code: "MODEL_MISMATCH",
      phase: "stream",
      message: "requested model-a, effective unknown, verdict mismatch",
      retryable: false,
    });
    expect(stored?.committedEntityId).toBeNull();
  });

  it("expires the ACK without HTTP when the host instance changed", async () => {
    const seed = await seedRunning();
    const executionId = "exec-host-move";
    await dispatchMessage(seed, executionId);
    const event = completed(executionId, { output: "host moved" });

    const result = await handleCompletedExecution(deps("host-2"), executionId, event);

    const message = (await db.messages.where("roomId").equals(seed.room.id).toArray())[0];
    expect(result).toEqual({
      kind: "committed",
      entityId: message?.id,
      roundPhase: "running",
    });
    expect(message).toEqual({
      id: message?.id,
      roomId: seed.room.id,
      roundId: seed.round.id,
      role: "participant",
      participantId: seed.p1.id,
      content: "host moved",
      sourceExecutionId: executionId,
      createdAt: FIXED_NOW,
    });
    expect(ackCalls).toEqual([]);
    const stored = await db.modelExecutions.get(executionId);
    expect(stored?.state).toBe("committed");
    expect(stored?.ackState).toBe("expired");
    expect(stored?.contentDigest).toBe(CONTENT_DIGEST["host moved"]);
    expect(stored?.committedEntityId).toBe(message?.id);
    expect(stored?.finalEventSeq).toBe(7);
    expect(stored?.hostInstanceId).toBe(HOST_ID);
    const round = await db.rounds.get(seed.round.id);
    expect(round?.phase).toBe("running");
    expect(round?.nextParticipantIndex).toBe(1);
    expect(round?.activeExecutionId).toBeNull();
    const room = await db.rooms.get(seed.room.id);
    expect(room?.contextRevision).toBe(1);
  });

  it("skips the ACK when the pre-commit row has a null finalEventSeq", async () => {
    const seed = await seedRunning();
    const executionId = "exec-null-seq";
    await dispatchMessage(seed, executionId);
    await db.modelExecutions.update(executionId, {
      state: "succeeded_uncommitted",
      finalEventSeq: null,
    });
    const event = completed(executionId, { output: "seq skipped", finalSeq: 4, seq: 4 });

    const result = await handleCompletedExecution(deps(), executionId, event);

    const message = (await db.messages.where("roomId").equals(seed.room.id).toArray())[0];
    expect(result).toEqual({
      kind: "committed",
      entityId: message?.id,
      roundPhase: "running",
    });
    expect(message?.content).toBe("seq skipped");
    expect(message?.sourceExecutionId).toBe(executionId);
    expect(message?.createdAt).toBe(FIXED_NOW);
    expect(ackCalls).toEqual([]);
    const stored = await db.modelExecutions.get(executionId);
    expect(stored?.state).toBe("committed");
    expect(stored?.ackState).toBe("pending");
    expect(stored?.finalEventSeq).toBe(4);
    expect(stored?.contentDigest).toBe(CONTENT_DIGEST["seq skipped"]);
  });

  it("marks the row expired when the host answers ackState expired", async () => {
    const seed = await seedRunning();
    const executionId = "exec-ack-expired";
    await dispatchMessage(seed, executionId);
    ackScript = { kind: "expired" };
    const event = completed(executionId, { output: "expired body" });

    const result = await handleCompletedExecution(deps(), executionId, event);

    const message = (await db.messages.where("roomId").equals(seed.room.id).toArray())[0];
    expect(result).toEqual({
      kind: "committed",
      entityId: message?.id,
      roundPhase: "running",
    });
    expect(message?.content).toBe("expired body");
    expect(ackCalls).toEqual([
      {
        url: `${BASE_URL}/api/v1/scopes/${SCOPE_ID}/executions/${executionId}/ack`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-councilkit-csrf": "csrf-token",
        },
        body: {
          controllerId: "ctrl-1",
          leaseEpoch: 1,
          finalSeq: 7,
          disposition: "committed",
        },
      },
    ]);
    const stored = await db.modelExecutions.get(executionId);
    expect(stored?.state).toBe("committed");
    expect(stored?.ackState).toBe("expired");
    expect(stored?.contentDigest).toBe(CONTENT_DIGEST["expired body"]);
  });

  it("leaves ackState pending when the host answers ackState pending", async () => {
    const seed = await seedRunning();
    const executionId = "exec-ack-pending";
    await dispatchMessage(seed, executionId);
    ackScript = { kind: "pending" };
    const event = completed(executionId, { output: "pending body" });

    const result = await handleCompletedExecution(deps(), executionId, event);

    const message = (await db.messages.where("roomId").equals(seed.room.id).toArray())[0];
    expect(result).toEqual({
      kind: "committed",
      entityId: message?.id,
      roundPhase: "running",
    });
    expect(message?.content).toBe("pending body");
    expect(ackCalls[0]?.body.disposition).toBe("committed");
    expect(ackCalls[0]?.body.finalSeq).toBe(7);
    const stored = await db.modelExecutions.get(executionId);
    expect(stored?.ackState).toBe("pending");
    expect(stored?.state).toBe("committed");
    expect(stored?.contentDigest).toBe(CONTENT_DIGEST["pending body"]);
  });

  it("expires the ACK when the host returns 404", async () => {
    const seed = await seedRunning();
    const executionId = "exec-ack-404";
    await dispatchMessage(seed, executionId);
    ackScript = { kind: "status", status: 404, code: "NOT_FOUND", message: "terminal missing" };
    const event = completed(executionId, { output: "missing terminal" });

    const result = await handleCompletedExecution(deps(), executionId, event);

    const message = (await db.messages.where("roomId").equals(seed.room.id).toArray())[0];
    expect(result).toEqual({
      kind: "committed",
      entityId: message?.id,
      roundPhase: "running",
    });
    expect(message?.content).toBe("missing terminal");
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]?.url).toBe(
      `${BASE_URL}/api/v1/scopes/${SCOPE_ID}/executions/${executionId}/ack`,
    );
    expect(ackCalls[0]?.body).toEqual({
      controllerId: "ctrl-1",
      leaseEpoch: 1,
      finalSeq: 7,
      disposition: "committed",
    });
    const stored = await db.modelExecutions.get(executionId);
    expect(stored?.state).toBe("committed");
    expect(stored?.ackState).toBe("expired");
    expect(stored?.contentDigest).toBe(CONTENT_DIGEST["missing terminal"]);
    expect(stored?.error).toBeNull();
  });

  it("leaves ackState pending when the host returns 503", async () => {
    const seed = await seedRunning();
    const executionId = "exec-ack-503";
    await dispatchMessage(seed, executionId);
    ackScript = { kind: "status", status: 503, code: "UPSTREAM", message: "host down" };
    const event = completed(executionId, { output: "upstream down" });

    const result = await handleCompletedExecution(deps(), executionId, event);

    const message = (await db.messages.where("roomId").equals(seed.room.id).toArray())[0];
    expect(result).toEqual({
      kind: "committed",
      entityId: message?.id,
      roundPhase: "running",
    });
    expect(message?.content).toBe("upstream down");
    expect(ackCalls).toHaveLength(1);
    const stored = await db.modelExecutions.get(executionId);
    expect(stored?.state).toBe("committed");
    expect(stored?.ackState).toBe("pending");
    expect(stored?.finalEventSeq).toBe(7);
  });

  it("leaves ackState pending when ack throws a non-runtime error", async () => {
    const seed = await seedRunning();
    const executionId = "exec-ack-network";
    await dispatchMessage(seed, executionId);
    ackScript = { kind: "throw", error: new TypeError("socket reset") };

    const result = await handleCompletedExecution(
      deps(),
      executionId,
      completed(executionId, { output: "upstream down" }),
    );

    const message = (await db.messages.where("roomId").equals(seed.room.id).toArray())[0];
    expect(result).toEqual({
      kind: "committed",
      entityId: message?.id,
      roundPhase: "running",
    });
    expect(message?.content).toBe("upstream down");
    expect(message?.sourceExecutionId).toBe(executionId);
    const stored = await db.modelExecutions.get(executionId);
    expect(stored?.ackState).toBe("pending");
    expect(stored?.state).toBe("committed");
    expect(stored?.committedEntityId).toBe(message?.id);
    expect(ackCalls).toEqual([
      {
        url: `${BASE_URL}/api/v1/scopes/${SCOPE_ID}/executions/${executionId}/ack`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-councilkit-csrf": "csrf-token",
        },
        body: {
          controllerId: "ctrl-1",
          leaseEpoch: 1,
          finalSeq: 7,
          disposition: "committed",
        },
      },
    ]);
  });
});
