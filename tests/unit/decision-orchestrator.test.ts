import "fake-indexeddb/auto";

import { createRound, transitionRound } from "@/lib/discussion-transactions";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type {
  DiscussionAgent,
  DiscussionRoom,
  DiscussionRound,
  Participant,
} from "@/models/discussion/entities";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
} from "@/models/discussion/factories";
import type { ModelExecution } from "@/models/discussion/model-execution";
import { handleCompletedExecution } from "@/orchestrator/commit-execution";
import { initializeRoomDigest } from "@/orchestrator/context-snapshot";
import {
  CONVERGENCE_MARKER,
  instructionText,
  parseConvergenceSuggestion,
  wireKindOf,
} from "@/orchestrator/discussion-instructions";
import {
  type ControlState,
  type LockProvider,
  createDiscussionOrchestrator,
} from "@/orchestrator/discussion-orchestrator";
import { RuntimeClient } from "@/runtime/client";
import { CREDENTIAL_MODE, type DispatchState, type ToolState } from "@shared/runtime/contracts";
import type { RuntimeError } from "@shared/runtime/errors";
import {
  type CompletedEvent,
  type InterruptedEvent,
  type ModelVerdict,
  type RuntimeEvent,
  type Usage,
  runtimeEventSchema,
} from "@shared/runtime/events";
import type { SnapshotItem } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Decision orchestrator (S2): the discuss-mode discussion orchestration —
 * facilitator focus → participant turns → summary → optional convergence to a
 * decision report — exercised end-to-end against real Dexie on
 * fake-indexeddb with a scripted in-process fake Host.
 *
 * Two suites:
 * - `instruction templates & convergence parsing` — the pure functions in
 *   discussion-instructions (mode × kind text, digest stability, the
 *   last-line convergence vote, target-output injection).
 * - `decision orchestration` — focus ordering, three-mode instruction
 *   divergence via digest, automatic convergence → report → concluded, the
 *   maxRounds cap, parse-failure non-blocking, concludeRoom manual path,
 *   report idempotency, startup-audit classifying a concluding crash, the
 *   legacy-undefined focus semantics, and focus retry/pause flows.
 *
 * The fake-Host / seed scaffolding mirrors tests/unit/discussion-orchestrator.test.ts
 * and additionally records each execute's instruction text/digest and the
 * snapshot's shared-projection items (S2 introduces focus/report kinds, whose
 * behavior is assertion-relevant and must be visible to the test).
 */

// ---------------------------------------------------------------------------
// Scripted fake Host
// ---------------------------------------------------------------------------

type EventProto =
  | { type: "started"; requestedModel: string }
  | { type: "output.delta"; text: string }
  | { type: "usage"; usage: Usage }
  | {
      type: "completed";
      output: string;
      requestedModel: string;
      effectiveModel: string | null;
      modelVerdict: ModelVerdict;
      toolState: ToolState;
      dispatchState: "accepted";
      usage: Usage | null;
    }
  | {
      type: "failed";
      error: RuntimeError;
      dispatchState: DispatchState;
      toolState: ToolState;
      retryable: boolean;
    }
  | {
      type: "interrupted";
      reason: InterruptedEvent["reason"];
      dispatchState: DispatchState;
      toolState: ToolState;
    };

type TurnPlan =
  | {
      kind: "complete";
      output?: string;
      effectiveModel?: string | null;
      modelVerdict?: ModelVerdict;
      toolState?: ToolState;
    }
  | {
      kind: "fail";
      code?: RuntimeError["code"];
      phase?: RuntimeError["phase"];
      retryable: boolean;
      dispatchState?: DispatchState;
    }
  | { kind: "hang" };

interface FakeParticipant {
  runtime: "ready" | "failed";
  modelId: string;
}

interface FakeScope {
  scopeId: string;
  scopeRequestId: string;
  controllerId: string;
  leaseEpoch: number;
  state: "active" | "closed";
  participants: Map<string, FakeParticipant>;
}

interface StreamEntry {
  controller: ReadableStreamDefaultController<Uint8Array>;
  deliveredUpTo: number;
  closed: boolean;
}

interface FakeExecution {
  executionId: string;
  participantId: string;
  scopeId: string;
  requestedModel: string;
  state: "running" | "completed" | "failed" | "interrupted";
  events: RuntimeEvent[];
  lastSeq: number;
  terminal: RuntimeEvent | null;
  ackState: "pending" | "acknowledged";
  disposition: "committed" | "discarded" | null;
  tombstone: boolean;
  autoClose: boolean;
  streams: Set<StreamEntry>;
}

interface ExecuteCall {
  executionId: string;
  participantId: string;
  instructionKind: "message" | "summary";
}

/** Captured S2 instruction facts per execute: the wire kind is message/summary
 * (focus→message, report→summary), but the digest + text differ per mode/kind. */
interface InstructionRecord {
  wireKind: "message" | "summary";
  text: string;
  instructionDigest: string;
}

interface AckCall {
  executionId: string;
  disposition: string;
  result: string;
  /** Dexie execution state read in-process at ACK time (persist→ACK proof). */
  stateAtAck: string | null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseFrame(event: RuntimeEvent): string {
  return `event: runtime\ndata: ${JSON.stringify(event)}\n\n`;
}

class FakeHost {
  hostInstanceId = "host-1";
  ackBehavior: "ok" | "fail-network" | "drop-response" = "ok";
  ackStateProbe: ((executionId: string) => Promise<string | null>) | null = null;
  onCreateScope: (() => Promise<void>) | null = null;

  executeCalls: ExecuteCall[] = [];
  instructionRecords: InstructionRecord[] = [];
  /** Shared-projection items carried by each execute's context snapshot. */
  snapshotItems: SnapshotItem[][] = [];
  ackCalls: AckCall[] = [];
  cancelCalls: string[] = [];
  closeCalls: { scopeId: string; controllerId: string; leaseEpoch: number }[] = [];
  takeoverCalls: { scopeId: string; controllerId: string; leaseEpoch: number }[] = [];
  getExecutionCalls: string[] = [];
  createScopeCalls: { scopeId: string; controllerId: string }[] = [];
  activateCalls: string[] = [];
  ackTombstones = 0;

  private readonly prewarmFailures = new Set<string>();
  private readonly scopes = new Map<string, FakeScope>();
  private readonly scopeRequestIndex = new Map<string, string>();
  private readonly executions = new Map<string, FakeExecution>();
  private readonly plans = new Map<string, TurnPlan[]>();
  private readonly encoder = new TextEncoder();
  private scopeSeq = 0;

  plan(participantId: string, ...plans: TurnPlan[]): void {
    this.plans.set(participantId, [...plans]);
  }

  failPrewarmFor(participantId: string): void {
    this.prewarmFailures.add(participantId);
  }

  /** Simulated restart: new instance id, in-memory scopes/executions/logs gone. */
  restart(hostInstanceId: string): void {
    this.hostInstanceId = hostInstanceId;
    this.scopes.clear();
    this.scopeRequestIndex.clear();
    this.executions.clear();
    this.plans.clear();
    this.prewarmFailures.clear();
    this.executeCalls = [];
    this.instructionRecords = [];
    this.snapshotItems = [];
    this.ackCalls = [];
    this.cancelCalls = [];
    this.closeCalls = [];
    this.takeoverCalls = [];
    this.getExecutionCalls = [];
    this.createScopeCalls = [];
    this.activateCalls = [];
    this.ackTombstones = 0;
    this.ackBehavior = "ok";
    this.onCreateScope = null;
  }

  seedScope(input: {
    scopeId: string;
    controllerId: string;
    leaseEpoch: number;
    participantIds: string[];
  }): void {
    this.scopes.set(input.scopeId, {
      scopeId: input.scopeId,
      scopeRequestId: `req-seeded-${input.scopeId}`,
      controllerId: input.controllerId,
      leaseEpoch: input.leaseEpoch,
      state: "active",
      participants: new Map(
        input.participantIds.map((participantId) => [
          participantId,
          { runtime: "ready", modelId: "model-a" },
        ]),
      ),
    });
  }

  registerExecution(input: {
    executionId: string;
    participantId: string;
    scopeId: string;
    state?: "running" | "completed";
    terminalEvent?: RuntimeEvent;
  }): void {
    this.executions.set(input.executionId, {
      executionId: input.executionId,
      participantId: input.participantId,
      scopeId: input.scopeId,
      requestedModel: "model-a",
      state: input.state ?? "running",
      events: input.terminalEvent ? [input.terminalEvent] : [],
      lastSeq: input.terminalEvent?.seq ?? 0,
      terminal: input.terminalEvent ?? null,
      ackState: "pending",
      disposition: null,
      tombstone: false,
      autoClose: true,
      streams: new Set(),
    });
  }

  /** Append a stamped event, buffer it and fan it out to open streams. */
  emit(executionId: string, proto: EventProto): RuntimeEvent {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`fake host: unknown execution ${executionId}`);
    const stamped: Record<string, unknown> = {
      ...proto,
      executionId,
      seq: execution.lastSeq + 1,
      at: new Date().toISOString(),
    };
    if (proto.type === "completed") stamped.finalSeq = execution.lastSeq + 1;
    const event = runtimeEventSchema.parse(stamped);
    execution.events.push(event);
    execution.lastSeq = event.seq;
    if (event.type === "completed" || event.type === "failed" || event.type === "interrupted") {
      execution.terminal = event;
      execution.state = event.type;
    }
    for (const entry of [...execution.streams]) {
      if (!entry.closed && event.seq > entry.deliveredUpTo) {
        entry.controller.enqueue(this.encoder.encode(sseFrame(event)));
        entry.deliveredUpTo = event.seq;
      }
    }
    return event;
  }

  /** Manual-mode completion for a hanging execution. */
  complete(executionId: string, output: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`fake host: unknown execution ${executionId}`);
    this.emit(executionId, {
      type: "completed",
      output,
      requestedModel: execution.requestedModel,
      effectiveModel: execution.requestedModel,
      modelVerdict: "match",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
    });
  }

  /** Cleanly end every open stream without a terminal (connection dropped). */
  dropStreams(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) return;
    for (const entry of [...execution.streams]) {
      if (!entry.closed) {
        entry.closed = true;
        try {
          entry.controller.close();
        } catch {
          // already closed by the client
        }
      }
      execution.streams.delete(entry);
    }
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;

    if (method === "GET" && segments.length === 3 && segments[2] === "health") {
      return jsonResponse({
        apiVersion: "v1",
        hostInstanceId: this.hostInstanceId,
        node: { version: "v22.17.0", major: 22 },
        drivers: [],
      });
    }
    if (method === "POST" && segments.length === 3 && segments[2] === "scopes") {
      return this.handleCreateScope(body);
    }
    const scopeId = segments[3];
    if (!scopeId) return errorResponse(404, "NOT_FOUND", "unknown route");
    if (method === "GET" && segments.length === 4) return this.handleScopeStatus(scopeId);
    if (method === "POST" && segments.length === 5 && segments[4] === "activate") {
      return this.handleActivate(scopeId);
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "controller") {
      return this.handleTakeover(scopeId, body);
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "executions") {
      return this.handleExecute(scopeId, body);
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "close") {
      return this.handleClose(scopeId, body);
    }
    const executionId = segments[5];
    if (!executionId) return errorResponse(404, "NOT_FOUND", "unknown route");
    if (method === "GET" && segments.length === 6) {
      return this.handleExecutionStatus(scopeId, executionId);
    }
    if (method === "GET" && segments.length === 7 && segments[6] === "events") {
      return this.handleEvents(scopeId, executionId, url.searchParams.get("afterSeq"));
    }
    if (method === "POST" && segments.length === 7 && segments[6] === "ack") {
      return this.handleAck(scopeId, executionId, body);
    }
    if (method === "POST" && segments.length === 7 && segments[6] === "cancel") {
      return this.handleCancel(scopeId, executionId, body);
    }
    return errorResponse(404, "NOT_FOUND", "unknown route");
  };

  private requireScope(scopeId: string): FakeScope | Response {
    const scope = this.scopes.get(scopeId);
    if (!scope) return errorResponse(404, "SCOPE_NOT_FOUND", "unknown scope");
    return scope;
  }

  private fenced(scope: FakeScope, body: Record<string, unknown> | null): Response | null {
    if (
      body &&
      (body.controllerId !== scope.controllerId || body.leaseEpoch !== scope.leaseEpoch)
    ) {
      return errorResponse(409, "STALE_CONTROLLER", "controllerId/leaseEpoch is not current");
    }
    return null;
  }

  private scopeStatusData(scope: FakeScope) {
    return {
      scopeId: scope.scopeId,
      state: scope.state,
      hostInstanceId: this.hostInstanceId,
      leaseEpoch: scope.leaseEpoch,
      participants: [...scope.participants.entries()].map(([participantId, participant]) => ({
        participantId,
        runtime: participant.runtime,
        binding: null,
        readiness: null,
      })),
    };
  }

  private async handleCreateScope(body: Record<string, unknown> | null): Promise<Response> {
    const request = body as unknown as {
      scopeRequestId: string;
      participants: { participantId: string; modelId: string }[];
    };
    const existingId = this.scopeRequestIndex.get(request.scopeRequestId);
    if (existingId) {
      const existing = this.scopes.get(existingId) as FakeScope;
      return jsonResponse({
        scopeId: existing.scopeId,
        controllerId: existing.controllerId,
        leaseEpoch: existing.leaseEpoch,
        scope: this.scopeStatusData(existing),
      });
    }
    this.scopeSeq += 1;
    const scopeId = `scope-${String(this.scopeSeq).padStart(4, "0")}`;
    const scope: FakeScope = {
      scopeId,
      scopeRequestId: request.scopeRequestId,
      controllerId: `ctrl-${String(this.scopeSeq).padStart(4, "0")}`,
      leaseEpoch: 1,
      state: "active",
      participants: new Map(
        request.participants.map((spec) => [
          spec.participantId,
          {
            runtime: this.prewarmFailures.has(spec.participantId) ? "failed" : "ready",
            modelId: spec.modelId,
          },
        ]),
      ),
    };
    this.scopes.set(scopeId, scope);
    this.scopeRequestIndex.set(request.scopeRequestId, scopeId);
    this.createScopeCalls.push({ scopeId, controllerId: scope.controllerId });
    if (this.onCreateScope) await this.onCreateScope();
    return jsonResponse({
      scopeId,
      controllerId: scope.controllerId,
      leaseEpoch: 1,
      scope: this.scopeStatusData(scope),
    });
  }

  private handleScopeStatus(scopeId: string): Response {
    const scope = this.requireScope(scopeId);
    if (scope instanceof Response) return scope;
    return jsonResponse(this.scopeStatusData(scope));
  }

  private handleActivate(scopeId: string): Response {
    const scope = this.requireScope(scopeId);
    if (scope instanceof Response) return scope;
    this.activateCalls.push(scopeId);
    return jsonResponse(this.scopeStatusData(scope));
  }

  private handleTakeover(scopeId: string, body: Record<string, unknown> | null): Response {
    const scope = this.requireScope(scopeId);
    if (scope instanceof Response) return scope;
    scope.controllerId = String(body?.controllerId ?? "");
    scope.leaseEpoch += 1;
    this.takeoverCalls.push({
      scopeId,
      controllerId: scope.controllerId,
      leaseEpoch: scope.leaseEpoch,
    });
    return jsonResponse({
      scopeId,
      controllerId: scope.controllerId,
      leaseEpoch: scope.leaseEpoch,
    });
  }

  private executionStatusData(execution: FakeExecution) {
    return {
      executionId: execution.executionId,
      participantId: execution.participantId,
      state: execution.state,
      lastSeq: execution.lastSeq,
    };
  }

  private handleExecute(scopeId: string, body: Record<string, unknown> | null): Response {
    const scopeOrError = this.requireScope(scopeId);
    if (scopeOrError instanceof Response) return scopeOrError;
    const stale = this.fenced(scopeOrError, body);
    if (stale) return stale;
    const scope = scopeOrError;
    const request = body as unknown as {
      executionId: string;
      participantId: string;
      snapshot: {
        instruction: { kind: "message" | "summary"; instructionDigest: string; text: string };
        roomContext: { items: SnapshotItem[] };
      };
    };
    const existing = this.executions.get(request.executionId);
    if (existing) {
      // Idempotent reconnect: same record, never re-dispatched.
      return jsonResponse({ execution: this.executionStatusData(existing) });
    }
    const participant = scope.participants.get(request.participantId);
    if (!participant) return errorResponse(404, "PARTICIPANT_NOT_FOUND", "unknown participant");
    const queue = this.plans.get(request.participantId) ?? [];
    const plan: TurnPlan = queue.length > 0 ? (queue.shift() as TurnPlan) : { kind: "complete" };
    const execution: FakeExecution = {
      executionId: request.executionId,
      participantId: request.participantId,
      scopeId,
      requestedModel: participant.modelId,
      state: "running",
      events: [],
      lastSeq: 0,
      terminal: null,
      ackState: "pending",
      disposition: null,
      tombstone: false,
      autoClose: plan.kind !== "hang",
      streams: new Set(),
    };
    this.executions.set(execution.executionId, execution);
    this.executeCalls.push({
      executionId: execution.executionId,
      participantId: request.participantId,
      instructionKind: request.snapshot.instruction.kind,
    });
    this.instructionRecords.push({
      wireKind: request.snapshot.instruction.kind,
      text: request.snapshot.instruction.text,
      instructionDigest: request.snapshot.instruction.instructionDigest,
    });
    this.snapshotItems.push(request.snapshot.roomContext.items);
    this.emit(execution.executionId, { type: "started", requestedModel: participant.modelId });
    if (plan.kind === "complete") {
      const callNumber = this.executeCalls.filter(
        (call) => call.participantId === request.participantId,
      ).length;
      const output = plan.output ?? `reply-${request.participantId}-${callNumber}`;
      this.emit(execution.executionId, { type: "output.delta", text: output.slice(0, 4) });
      this.emit(execution.executionId, { type: "output.delta", text: output.slice(4) });
      this.emit(execution.executionId, {
        type: "usage",
        usage: { inputTokens: 120, outputTokens: 5 },
      });
      this.emit(execution.executionId, {
        type: "completed",
        output,
        requestedModel: participant.modelId,
        effectiveModel:
          plan.effectiveModel === undefined ? participant.modelId : plan.effectiveModel,
        modelVerdict: plan.modelVerdict ?? "match",
        toolState: plan.toolState ?? "none",
        dispatchState: "accepted",
        usage: { inputTokens: 120, outputTokens: 5 },
      });
    } else if (plan.kind === "fail") {
      this.emit(execution.executionId, {
        type: "failed",
        error: {
          code: plan.code ?? "MODEL_UNAVAILABLE",
          phase: plan.phase ?? "dispatch",
          message: "scripted failure",
          retryable: plan.retryable,
        },
        dispatchState: plan.dispatchState ?? "not_dispatched",
        toolState: "none",
        retryable: plan.retryable,
      });
    }
    return jsonResponse({ execution: this.executionStatusData(execution) });
  }

  private handleExecutionStatus(scopeId: string, executionId: string): Response {
    this.getExecutionCalls.push(executionId);
    const scope = this.requireScope(scopeId);
    if (scope instanceof Response) return scope;
    const execution = this.executions.get(executionId);
    if (!execution) return errorResponse(404, "EXECUTION_NOT_FOUND", "unknown execution");
    return jsonResponse(this.executionStatusData(execution));
  }

  private handleEvents(scopeId: string, executionId: string, afterSeqRaw: string | null): Response {
    const scope = this.requireScope(scopeId);
    if (scope instanceof Response) return scope;
    const execution = this.executions.get(executionId);
    if (!execution) return errorResponse(404, "EXECUTION_NOT_FOUND", "unknown execution");
    const afterSeq = afterSeqRaw ? Number.parseInt(afterSeqRaw, 10) : 0;
    if (!Number.isFinite(afterSeq) || afterSeq < 0) {
      return errorResponse(400, "BAD_REQUEST", "invalid afterSeq");
    }
    let entry: StreamEntry | null = null;
    const encoder = this.encoder;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const current: StreamEntry = { controller, deliveredUpTo: afterSeq, closed: false };
        entry = current;
        execution.streams.add(current);
        for (const event of execution.events) {
          if (event.seq > current.deliveredUpTo) {
            controller.enqueue(encoder.encode(sseFrame(event)));
            current.deliveredUpTo = event.seq;
          }
        }
        if (execution.autoClose) {
          current.closed = true;
          execution.streams.delete(current);
          controller.close();
        }
      },
      cancel: () => {
        if (entry) {
          entry.closed = true;
          execution.streams.delete(entry);
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  private async handleAck(
    scopeId: string,
    executionId: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    if (this.ackBehavior === "fail-network") {
      throw new TypeError("fetch failed (simulated network error)");
    }
    const scopeOrError = this.requireScope(scopeId);
    if (scopeOrError instanceof Response) return scopeOrError;
    const stale = this.fenced(scopeOrError, body);
    if (stale) return stale;
    const request = body as unknown as { finalSeq: number; disposition: "committed" | "discarded" };
    const execution = this.executions.get(executionId);

    const respond = async (data: {
      executionId: string;
      ackState: string;
      disposition: string | null;
    }): Promise<Response> => {
      this.ackCalls.push({
        executionId,
        disposition: request.disposition,
        result: data.ackState,
        stateAtAck: this.ackStateProbe ? await this.ackStateProbe(executionId) : null,
      });
      if (this.ackBehavior === "drop-response") {
        throw new TypeError("response lost (simulated)");
      }
      return jsonResponse(data);
    };

    if (!execution) {
      return respond({ executionId, ackState: "expired", disposition: null });
    }
    if (execution.tombstone || execution.ackState === "acknowledged") {
      if (execution.disposition === request.disposition) {
        return respond({
          executionId,
          ackState: "acknowledged",
          disposition: execution.disposition,
        });
      }
      return errorResponse(409, "EXECUTION_CONFLICT", "ACK disposition differs");
    }
    if (!execution.terminal) {
      return errorResponse(409, "EXECUTION_CONFLICT", "ACK before a terminal event");
    }
    if (execution.terminal.seq !== request.finalSeq) {
      return errorResponse(409, "EXECUTION_CONFLICT", "ACK finalSeq does not match the terminal");
    }
    execution.ackState = "acknowledged";
    execution.disposition = request.disposition;
    execution.tombstone = true;
    this.ackTombstones += 1;
    return respond({ executionId, ackState: "acknowledged", disposition: request.disposition });
  }

  private handleCancel(
    scopeId: string,
    executionId: string,
    body: Record<string, unknown> | null,
  ): Response {
    const scopeOrError = this.requireScope(scopeId);
    if (scopeOrError instanceof Response) return scopeOrError;
    const stale = this.fenced(scopeOrError, body);
    if (stale) return stale;
    const execution = this.executions.get(executionId);
    if (!execution) return errorResponse(404, "EXECUTION_NOT_FOUND", "unknown execution");
    if (execution.state === "running") {
      this.emit(executionId, {
        type: "interrupted",
        reason: "user_cancelled",
        dispatchState: "accepted",
        toolState: "none",
      });
    }
    this.cancelCalls.push(executionId);
    return jsonResponse({ executionId, state: "cancelling" });
  }

  private handleClose(scopeId: string, body: Record<string, unknown> | null): Response {
    const scopeOrError = this.requireScope(scopeId);
    if (scopeOrError instanceof Response) return scopeOrError;
    const stale = this.fenced(scopeOrError, body);
    if (stale) return stale;
    scopeOrError.state = "closed";
    this.closeCalls.push({
      scopeId,
      controllerId: String(body?.controllerId ?? ""),
      leaseEpoch: Number(body?.leaseEpoch ?? 0),
    });
    return jsonResponse({ scopeId, state: "closed" });
  }
}

// ---------------------------------------------------------------------------
// Seeds and fixtures
// ---------------------------------------------------------------------------

let db: CouncilKitRuntimeDB;
let host: FakeHost;
let uuidCounter = 0;

interface Seed {
  room: DiscussionRoom;
  p1: Participant;
  p2: Participant;
  agent1: DiscussionAgent;
  agent2: DiscussionAgent;
}

async function seedBase(mode: "brainstorm" | "planning" | "review" = "brainstorm"): Promise<Seed> {
  const ts = new Date().toISOString();
  await db.executionProfiles.put({
    id: "prof-1",
    name: "Profile 1",
    driverId: "codex-app-server",
    installationId: "inst-1",
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
    modelId: "model-a",
    color: "#a1b2c3",
  });
  const agent2 = createDiscussionAgent({
    name: "A2",
    personaPrompt: "p2 persona",
    executionProfileId: "prof-1",
    modelId: "model-b",
    color: "#b2c3d4",
  });
  await db.agents.bulkAdd([agent1, agent2]);
  const room = initializeRoomDigest(
    createDiscussionRoom({
      topic: "Topic",
      background: "bg",
      facilitatorParticipantId: "pending",
      mode,
    }),
  );
  await db.rooms.add(room);
  const p1 = createParticipant({ roomId: room.id, agent: agent1, profileDigest: "pd1" });
  const p2 = createParticipant({ roomId: room.id, agent: agent2, profileDigest: "pd2" });
  // Deterministic participant order: activeParticipants sorts by createdAt,
  // which would tie (and fall back to random id order) within one millisecond.
  p1.createdAt = "2026-07-17T00:00:00.000Z";
  p2.createdAt = "2026-07-17T00:00:00.001Z";
  await db.participants.bulkAdd([p1, p2]);
  room.facilitatorParticipantId = p1.id;
  await db.rooms.put(room);
  return { room, p1, p2, agent1, agent2 };
}

function makeOrchestrator(options: { locks?: LockProvider } = {}) {
  const previews: RuntimeEvent[] = [];
  const controlStates: ControlState[] = [];
  const client = new RuntimeClient({ baseUrl: "http://fake-host", csrfToken: "csrf-token" });
  const orchestrator = createDiscussionOrchestrator({
    db,
    client,
    locks: options.locks,
    display: {
      onPreview: (_roomId, event) => {
        previews.push(event);
      },
      onControlState: (_roomId, state) => {
        controlStates.push(state);
      },
    },
    ids: {
      uuid: () => `uuid-${String(++uuidCounter).padStart(4, "0")}`,
    },
  });
  return { orchestrator, client, previews, controlStates };
}

beforeEach(() => {
  db = new CouncilKitRuntimeDB(`test-${crypto.randomUUID()}`);
  uuidCounter = 0;
  host = new FakeHost();
  host.ackStateProbe = async (executionId) =>
    (await db.modelExecutions.get(executionId))?.state ?? null;
  vi.stubGlobal("fetch", host.fetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
  db.close();
});

// ---------------------------------------------------------------------------
// Pure functions: instruction templates & convergence parsing
// ---------------------------------------------------------------------------

describe("instruction templates & convergence parsing", () => {
  const modes: ("brainstorm" | "planning" | "review")[] = ["brainstorm", "planning", "review"];
  const kinds = ["focus", "message", "summary", "report"] as const;

  it("instructionText 三模式四 kind 全异（采样 12 组合），且模式/类别关键词落到对应模板", () => {
    const allTexts = new Set<string>();
    for (const mode of modes) {
      for (const kind of kinds) {
        const text = instructionText(mode, kind);
        expect(text.length).toBeGreaterThan(0);
        expect(allTexts.has(text)).toBe(false);
        allTexts.add(text);
      }
    }
    expect(allTexts.size).toBe(12);

    // Mode-specific keywords live in their own template families.
    expect(instructionText("brainstorm", "focus")).toContain("本轮方向");
    expect(instructionText("planning", "focus")).toContain("约束确认");
    expect(instructionText("review", "focus")).toContain("评审维度");

    // The message templates also carry the mode keywords (kept in plain prose
    // for the participants; the mode is borne by instruction text only).
    expect(instructionText("review", "message")).toContain("审查");
  });

  it("computeInstructionDigest：跨模式不同、同模式同 kind 稳定（digest 自变量是 text）", async () => {
    const { computeInstructionDigest } = await import("@/orchestrator/context-snapshot");
    const focusBrain = computeInstructionDigest({
      kind: wireKindOf("focus"),
      text: instructionText("brainstorm", "focus"),
    });
    const focusReview = computeInstructionDigest({
      kind: wireKindOf("focus"),
      text: instructionText("review", "focus"),
    });
    const focusBrainRepeat = computeInstructionDigest({
      kind: wireKindOf("focus"),
      text: instructionText("brainstorm", "focus"),
    });
    expect(focusBrain).not.toBe(focusReview);
    expect(focusBrain).toBe(focusBrainRepeat);

    // Same wire kind, different mode → different digest for every kind.
    for (const kind of kinds) {
      const b = computeInstructionDigest({
        kind: wireKindOf(kind),
        text: instructionText("brainstorm", kind),
      });
      const r = computeInstructionDigest({
        kind: wireKindOf(kind),
        text: instructionText("review", kind),
      });
      expect(b).not.toBe(r);
    }
  });

  it("summary 模板含收敛末行要求（三模式均含「收敛建议：是」「收敛建议：否」字样与 marker）", () => {
    for (const mode of modes) {
      const text = instructionText(mode, "summary");
      expect(text).toContain("收敛建议：是");
      expect(text).toContain("收敛建议：否");
      expect(text).toContain(CONVERGENCE_MARKER);
    }
  });

  it("parseConvergenceSuggestion：末行是/否/缺失/多行取末行/前后空白容错；非末行不生效", () => {
    expect(parseConvergenceSuggestion("正文\n收敛建议：是")).toBe(true);
    expect(parseConvergenceSuggestion("正文\n收敛建议：否")).toBe(false);
    expect(parseConvergenceSuggestion("只有正文，没有标记")).toBe(false);
    expect(parseConvergenceSuggestion("收敛建议：是\n收敛建议：否")).toBe(false);
    expect(parseConvergenceSuggestion("  正文  \n  收敛建议：是  ")).toBe(true);
    // A mid-text vote that is NOT the trimmed last line never triggers.
    expect(parseConvergenceSuggestion("收敛建议：是\n但又继续讨论了")).toBe(false);
    expect(parseConvergenceSuggestion("")).toBe(false);
    expect(parseConvergenceSuggestion("   ")).toBe(false);
  });

  it("report instruction：targetOutput 非空追加、空串/纯空白不追加", () => {
    const base = instructionText("brainstorm", "report", "");
    const blank = instructionText("brainstorm", "report", "   ");
    const filled = instructionText("brainstorm", "report", "一份迁移方案");
    expect(base).not.toContain("目标输出");
    expect(blank).toBe(base);
    expect(filled).toBe(`${base}\n目标输出：一份迁移方案`);
    // Non-report kinds ignore targetOutput entirely.
    expect(instructionText("brainstorm", "message", "ignored")).not.toContain("目标输出");
  });

  it("wireKindOf：focus→message、report→summary、message/summary 恒等", () => {
    expect(wireKindOf("focus")).toBe("message");
    expect(wireKindOf("report")).toBe("summary");
    expect(wireKindOf("message")).toBe("message");
    expect(wireKindOf("summary")).toBe("summary");
  });
});

// ---------------------------------------------------------------------------
// Decision orchestration (fake Host end-to-end)
// ---------------------------------------------------------------------------

describe("decision orchestration", () => {
  it("focus 先于首 Participant：execute 顺序 focus→p1→p2→summary", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);

    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");

    expect(host.executeCalls.map((call) => call.participantId)).toEqual([
      p1.id,
      p1.id,
      p2.id,
      p1.id,
    ]);
    // wire kinds: focus→message, message→message, message→message, summary→summary.
    expect(host.executeCalls.map((call) => call.instructionKind)).toEqual([
      "message",
      "message",
      "message",
      "summary",
    ]);
    // The recorded instruction texts differ per kind (focus ≠ message ≠ summary).
    const texts = host.instructionRecords.map((record) => record.text);
    expect(texts[0]).not.toBe(texts[1]);
    expect(texts[1]).not.toBe(texts[3]);
    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(storedRound.focusMessageId).not.toBeNull();
    expect(storedRound.nextParticipantIndex).toBe(2);
    // Focus lands a participant-role Message from the facilitator (p1).
    const focusMessage = await db.messages.get(storedRound.focusMessageId as string);
    expect(focusMessage?.role).toBe("participant");
    expect(focusMessage?.participantId).toBe(p1.id);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(4);
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(3);
  });

  it("focus 不推进 cursor 且 revision 照常 +1（focus 后是 1，round 完成是 4）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator, previews } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // Hang the focus to inspect the intermediate state before p1 speaks.
    host.plan(p1.id, { kind: "hang" });
    const roundPromise = orchestrator.startRound(room.id);
    await vi.waitFor(() => {
      expect(previews.some((event) => event.type === "started")).toBe(true);
    });
    const focusExecutionId = host.executeCalls[0]?.executionId as string;
    host.complete(focusExecutionId, "本轮方向：定义 X");
    const completedRound = await roundPromise;

    // After the focus lands, the loop continues: p1 message → p2 message →
    // summary (all default-complete), so the round finishes with revision 4
    // (focus + 2 messages + summary) and the cursor left at 2 (focus took no slot).
    const storedRound = (await db.rounds.get(completedRound?.id ?? "")) as DiscussionRound;
    expect(storedRound.phase).toBe("completed");
    expect(storedRound.nextParticipantIndex).toBe(2); // focus occupied no slot
    expect(storedRound.focusMessageId).not.toBeNull();
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(4);
  });

  it("三模式 instruction 差异（digest 断言）：brainstorm vs review 的 focus/message/summary digest 两两不同", async () => {
    const { computeInstructionDigest } = await import("@/orchestrator/context-snapshot");
    const brainstorm = await seedBase("brainstorm");
    const review = await seedBase("review");
    const a = makeOrchestrator();
    const b = makeOrchestrator();
    await a.orchestrator.ensureScope(brainstorm.room.id, [brainstorm.p1, brainstorm.p2]);
    await b.orchestrator.ensureScope(review.room.id, [review.p1, review.p2]);
    await a.orchestrator.startRound(brainstorm.room.id);
    await b.orchestrator.startRound(review.room.id);

    // The first four executes per room are focus/p1-message/p2-message/summary.
    const brainDigests = host.instructionRecords
      .slice(0, 4)
      .map((record) => record.instructionDigest);
    // The other room's executes start at index 4.
    const reviewDigests = host.instructionRecords
      .slice(4, 8)
      .map((record) => record.instructionDigest);

    // Same-mode digests are internally consistent with the pure function.
    expect(brainDigests[0]).toBe(
      computeInstructionDigest({
        kind: wireKindOf("focus"),
        text: instructionText("brainstorm", "focus"),
      }),
    );
    // Across modes, focus / message / summary digests all differ.
    for (let i = 0; i < 3; i += 1) {
      expect(brainDigests[i]).not.toBe(reviewDigests[i]);
    }
  });

  it("收敛=是 → 自动 report → concluded（report committed+acknowledged，commit 先于 ACK）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // The facilitator summary votes yes: the last line is the convergence vote.
    // p1's execute order this round: focus(1) → p1 message(2) → summary(3) → report(4).
    host.plan(
      p1.id,
      { kind: "complete" }, // focus
      { kind: "complete" }, // p1 message
      { kind: "complete", output: `方向 A 与 B\n${CONVERGENCE_MARKER}是` }, // summary votes yes
    );

    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");

    const storedRoom = await db.rooms.get(room.id);
    expect(storedRoom?.status).toBe("concluded");
    const reports = await db.reports.where("roomId").equals(room.id).toArray();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.sourceExecutionId).not.toBe("");

    // The report execution is the 5th execute (focus → p1 → p2 → summary → report).
    expect(host.executeCalls).toHaveLength(5);
    expect(host.executeCalls[4]?.participantId).toBe(p1.id);
    expect(host.executeCalls[4]?.instructionKind).toBe("summary"); // report wire kind
    expect(host.instructionRecords[4]?.text).toContain("决策报告");
    const reportExecs = (await db.modelExecutions.where("roomId").equals(room.id).toArray()).filter(
      (execution) => execution.resultKind === "report",
    );
    expect(reportExecs).toHaveLength(1);
    expect(reportExecs[0]?.state).toBe("committed");
    expect(reportExecs[0]?.ackState).toBe("acknowledged");
    expect(reportExecs[0]?.committedEntityId).toBe(reports[0]?.id);
    // Persist precedes ACK: the probe saw a committed Dexie state at ACK time.
    const reportAck = host.ackCalls.find(
      (call) => call.executionId === reportExecs[0]?.executionId,
    );
    expect(reportAck?.disposition).toBe("committed");
    expect(reportAck?.stateAtAck).toBe("committed");
    expect(reportAck?.result).toBe("acknowledged");
  });

  // F6/G4 regression: a report execution whose pre-dispatch failure is
  // retryable (not_dispatched) must auto-retry once — the retry re-dispatches
  // the report turn (expectedPhase "completed") with a fresh executionId that
  // carries the failed attempt's id on retryOfExecutionId. The retry commits,
  // concluding the room with exactly one report row. Without the report-aware
  // expectedPhase (a pre-report bug treated every retry as needing "running"),
  // the retry would be skipped and the room would never conclude.
  it("report not_dispatched 失败自动重试一次：新 executionId + retryOfExecutionId 链（phase completed），成功后 concluded + reports 一行", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // p1 execute order: focus(1) → p1 message(2) → summary(3=vote yes) →
    // report(4=fail not_dispatched retryable) → report retry(5=complete).
    // The failing report and its retry consume p1's plan slots 3 and 4.
    host.plan(
      p1.id,
      { kind: "complete" }, // focus
      { kind: "complete" }, // p1 message
      { kind: "complete", output: `方向 A 与 B\n${CONVERGENCE_MARKER}是` }, // summary votes yes
      { kind: "fail", retryable: true, dispatchState: "not_dispatched" }, // report original
      { kind: "complete", output: "最终决策报告" }, // report retry
    );

    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");

    // The room is concluded via the retried report.
    expect((await db.rooms.get(room.id))?.status).toBe("concluded");
    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(1);

    // Two report executions: the failed original + its committed retry, linked.
    const reportExecs = (await db.modelExecutions.where("roomId").equals(room.id).toArray())
      .filter((execution) => execution.resultKind === "report")
      .sort((a, b) => (a.executionId < b.executionId ? -1 : 1));
    expect(reportExecs).toHaveLength(2);
    const [original, retry] = reportExecs as [ModelExecution, ModelExecution];
    expect(original.state).toBe("failed");
    expect(original.error?.retryable).toBe(true);
    expect(retry.state).toBe("committed");
    expect(retry.ackState).toBe("acknowledged");
    expect(retry.retryOfExecutionId).toBe(original.executionId);
    // The report row is anchored on the RETRY (the one that committed).
    const reportRow = (await db.reports.where("roomId").equals(room.id).toArray())[0];
    expect(reportRow?.sourceExecutionId).toBe(retry.executionId);

    // focus → p1 msg → p2 msg → summary → report(fail) → report(retry) = 6 dispatches.
    expect(host.executeCalls).toHaveLength(6);
    // The two report executions used distinct executionIds (no re-dispatch).
    expect(new Set(reportExecs.map((execution) => execution.executionId)).size).toBe(2);
    expect(original.executionId).not.toBe(retry.executionId);
  });

  it("maxRounds=2 到点收敛：round1 summary 否不报告，round2 summary 否触发收敛并 concluded", async () => {
    const { room, p1, p2 } = await seedBase();
    await db.rooms.update(room.id, { maxRounds: 2 });
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // No plan → every facilitator summary defaults to a no-vote body (no marker).
    const round1 = await orchestrator.startRound(room.id);
    expect(round1?.phase).toBe("completed");
    expect((await db.rooms.get(room.id))?.status).toBe("open");
    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(0);
    // No report execution dispatched after round 1.
    expect(
      host.executeCalls.filter((call) => call.instructionKind === "summary").length,
    ).toBeGreaterThanOrEqual(1);
    const reportExecsAfter1 = (
      await db.modelExecutions.where("roomId").equals(room.id).toArray()
    ).filter((execution) => execution.resultKind === "report");
    expect(reportExecsAfter1).toHaveLength(0);

    const round2 = await orchestrator.startRound(room.id);
    expect(round2?.phase).toBe("completed");
    expect((await db.rooms.get(room.id))?.status).toBe("concluded");
    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(1);
    const reportExecsAfter2 = (
      await db.modelExecutions.where("roomId").equals(room.id).toArray()
    ).filter((execution) => execution.resultKind === "report");
    expect(reportExecsAfter2).toHaveLength(1);
  });

  it("解析失败不收敛不阻塞：summary 无标记行 → round completed、summary committed、reports 0、status open", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(
      p1.id,
      { kind: "complete" }, // focus
      { kind: "complete", output: "纯总结正文，没有任何收敛建议行" }, // summary without a vote
    );
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
    expect((await db.rooms.get(room.id))?.status).toBe("open");
    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(0);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(1);
    // Exactly the four round executions; no report execute was dispatched.
    expect(host.executeCalls).toHaveLength(4);
    expect(
      (await db.modelExecutions.where("roomId").equals(room.id).toArray()).filter(
        (execution) => execution.resultKind === "report",
      ),
    ).toHaveLength(0);
  });

  it("concluded 拒绝 startRound 与 startRoundWithUserMessage（ROOM_CONCLUDED）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // focus(1) → p1 message(2) → summary(3=vote yes)
    host.plan(
      p1.id,
      { kind: "complete" },
      { kind: "complete" },
      { kind: "complete", output: `总结\n${CONVERGENCE_MARKER}是` },
    );
    await orchestrator.startRound(room.id);
    expect((await db.rooms.get(room.id))?.status).toBe("concluded");

    await expect(orchestrator.startRound(room.id)).rejects.toMatchObject({
      code: "ROOM_CONCLUDED",
    });
    await expect(orchestrator.startRoundWithUserMessage(room.id, "再来一轮")).rejects.toMatchObject(
      { code: "ROOM_CONCLUDED" },
    );
  });

  it("startRoundWithUserMessage 顺序：消息落到新 round，focus snapshot items 含该用户消息", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);

    const round = await orchestrator.startRoundWithUserMessage(room.id, "用户给的起手上下文");
    expect(round?.phase).toBe("completed");

    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    // The seed user message belongs to the new round and bumps revision to 1
    // before the focus snapshot is built.
    const seedMessages = await db.messages
      .where("roundId")
      .equals(storedRound.id)
      .filter((message) => message.role === "user")
      .toArray();
    expect(seedMessages).toHaveLength(1);
    expect(seedMessages[0]?.content).toBe("用户给的起手上下文");
    // The focus snapshot's shared-projection items include that seed message.
    const focusItems = host.snapshotItems[0] ?? [];
    expect(
      focusItems.some((item) => item.role === "user" && item.content === "用户给的起手上下文"),
    ).toBe(true);
  });

  it("concludeRoom 手动路径等价：无收敛后调用产生 report → concluded；前置否定（运行中 execution throw、无 completed round throw、已 concluded 幂等）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // A round whose summary votes no (no plan → default reply text has no marker).
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
    expect((await db.rooms.get(room.id))?.status).toBe("open");

    await orchestrator.concludeRoom(room.id);
    expect((await db.rooms.get(room.id))?.status).toBe("concluded");
    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(1);

    // Idempotent on an already-concluded room: no second report, no throw.
    await orchestrator.concludeRoom(room.id);
    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(1);

    // A running execution blocks conclusion.
    const seed2 = await seedBase();
    const { orchestrator: orchestrator2 } = makeOrchestrator();
    await orchestrator2.ensureScope(seed2.room.id, [seed2.p1, seed2.p2]);
    host.plan(seed2.p1.id, { kind: "hang" });
    const round2Promise = orchestrator2.startRound(seed2.room.id);
    // Wait specifically for seed2's focus to be dispatched (id-distinct from
    // seed1), so the room has a live activeExecutionId when concludeRoom runs.
    await vi.waitFor(() => {
      expect(host.executeCalls.some((call) => call.participantId === seed2.p1.id)).toBe(true);
    });
    await expect(orchestrator2.concludeRoom(seed2.room.id)).rejects.toThrow(/execution is running/);
    const focusId = host.executeCalls.filter((call) => call.participantId === seed2.p1.id).at(-1)
      ?.executionId as string;
    host.complete(focusId, "方向");
    await round2Promise;

    // No completed round → throw.
    const seed3 = await seedBase();
    const { orchestrator: orchestrator3 } = makeOrchestrator();
    await orchestrator3.ensureScope(seed3.room.id, [seed3.p1, seed3.p2]);
    // Build a persisted but NOT-completed running round directly (no executions).
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(seed3.room.id)
      .filter((candidate) => candidate.state === "active")
      .first();
    const realToken = {
      controllerId: binding?.controllerId as string,
      leaseEpoch: binding?.leaseEpoch as number,
    };
    const pendingRound = await createRound(db, {
      roomId: seed3.room.id,
      token: realToken,
      participantOrder: [seed3.p1.id, seed3.p2.id],
    });
    await transitionRound(db, {
      roomId: seed3.room.id,
      roundId: pendingRound.id,
      token: realToken,
      to: "prewarming",
    });
    await transitionRound(db, {
      roomId: seed3.room.id,
      roundId: pendingRound.id,
      token: realToken,
      to: "running",
    });
    await expect(orchestrator3.concludeRoom(seed3.room.id)).rejects.toThrow(/no completed round/);
  });

  it("幂等：report 重放只一行（对 report execution 的 completed terminal 二次 handleCompletedExecution）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator, client } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // focus(1) → p1 message(2) → summary(3=vote yes) → report(4)
    host.plan(
      p1.id,
      { kind: "complete" },
      { kind: "complete" },
      { kind: "complete", output: `总结\n${CONVERGENCE_MARKER}是` },
    );
    await orchestrator.startRound(room.id);
    expect((await db.rooms.get(room.id))?.status).toBe("concluded");

    const reportExecs = (await db.modelExecutions.where("roomId").equals(room.id).toArray()).filter(
      (execution) => execution.resultKind === "report",
    );
    expect(reportExecs).toHaveLength(1);
    const reportExecution = reportExecs[0] as (typeof reportExecs)[number];
    const acksBefore = host.ackCalls.length;

    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((candidate) => candidate.state === "active")
      .first();
    const token = {
      controllerId: binding?.controllerId as string,
      leaseEpoch: binding?.leaseEpoch as number,
    };
    // Rebuild the completed terminal event the orchestrator originally saw, so
    // the facts (finalSeq + content digest) match the stored committed execution.
    const reportRow = (await db.reports
      .where("sourceExecutionId")
      .equals(reportExecution.executionId)
      .first()) as { content: string } | undefined;
    const completed: CompletedEvent = {
      executionId: reportExecution.executionId,
      seq: reportExecution.finalEventSeq ?? 5,
      at: new Date().toISOString(),
      type: "completed",
      output: reportRow?.content ?? "report body",
      requestedModel: "model-a",
      effectiveModel: "model-a",
      modelVerdict: "match",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: reportExecution.finalEventSeq ?? 5,
    };

    const deps = {
      db,
      client,
      scopeId: binding?.executionScopeId as string,
      token,
      currentHostInstanceId: host.hostInstanceId,
    };
    // Both calls replay the already-committed report (same finalSeq + digest).
    const first = await handleCompletedExecution(deps, reportExecution.executionId, completed);
    expect(first.kind).toBe("replayed");
    const second = await handleCompletedExecution(deps, reportExecution.executionId, completed);
    expect(second).toEqual({
      kind: "replayed",
      entityId: first.kind === "replayed" ? first.entityId : "",
    });

    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(1);
    // Two additional ACKs (one per handleCompletedExecution call).
    expect(host.ackCalls.length).toBe(acksBefore + 2);
  });

  it("concluding 中崩溃 → startupAudit 可解释：running report execution interrupted，round 仍 completed，room open，reports 0；随后 concludeRoom 成功 concluded", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    // Drive a completed round first (no convergence, so no report yet).
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
    expect((await db.rooms.get(room.id))?.status).toBe("open");
    const completedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;

    // Seed a prepared/running report execution directly (a concluding crash
    // left it mid-flight): the Host has no such execution (404).
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((candidate) => candidate.state === "active")
      .first();
    const { computeInstructionDigest } = await import("@/orchestrator/context-snapshot");
    const freshRoom = (await db.rooms.get(room.id)) as DiscussionRoom;
    const facilitator = (await db.participants.get(room.facilitatorParticipantId)) as Participant;
    const reportExecution: ModelExecution = {
      ...createModelExecution({
        executionId: `exec-report-crash-${uuidCounter}`,
        roomId: room.id,
        roundId: completedRound.id,
        participantId: room.facilitatorParticipantId,
        resultKind: "report",
        requestedModel: "model-a",
        contextRevision: freshRoom.contextRevision,
        expectedRoomDigest: freshRoom.contextDigest,
        participantSnapshotDigest: facilitator.participantSnapshotDigest,
        instructionDigest: computeInstructionDigest({
          kind: "summary",
          text: instructionText("brainstorm", "report"),
        }),
      }),
      state: "running",
      hostInstanceId: host.hostInstanceId,
      executionScopeId: binding?.executionScopeId ?? null,
    };
    await db.modelExecutions.put(reportExecution);

    const executeCallsBefore = host.executeCalls.length;
    const { orchestrator: auditor } = makeOrchestrator();
    await auditor.startupAudit();

    const persisted = (await db.modelExecutions.get(reportExecution.executionId)) as ModelExecution;
    expect(persisted.state).toBe("interrupted");
    expect(persisted.error?.code).toBe("SAFE_INTERRUPTION");
    expect((await db.rounds.get(completedRound.id))?.phase).toBe("completed");
    expect((await db.rooms.get(room.id))?.status).toBe("open");
    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(0);
    expect(host.executeCalls).toHaveLength(executeCallsBefore); // never re-invoked

    // After the crash is settled, the manual path concludes successfully.
    await auditor.concludeRoom(room.id);
    expect((await db.rooms.get(room.id))?.status).toBe("concluded");
    expect(await db.reports.where("roomId").equals(room.id).count()).toBe(1);
  });

  it("concluding 中已 committed + acknowledged 的 report execution 经 audit 后状态不动、reports 行原样", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // focus(1) → p1 message(2) → summary(3=vote yes) → report(4)
    host.plan(
      p1.id,
      { kind: "complete" },
      { kind: "complete" },
      { kind: "complete", output: `总结\n${CONVERGENCE_MARKER}是` },
    );
    await orchestrator.startRound(room.id);
    expect((await db.rooms.get(room.id))?.status).toBe("concluded");
    const reportBefore = (await db.reports.where("roomId").equals(room.id).toArray())[0];
    const reportExecBefore = (
      await db.modelExecutions.where("roomId").equals(room.id).toArray()
    ).filter((execution) => execution.resultKind === "report")[0];

    const { orchestrator: auditor } = makeOrchestrator();
    await auditor.startupAudit();

    const reportAfter = (await db.reports.where("roomId").equals(room.id).toArray())[0];
    expect(reportAfter).toEqual(reportBefore);
    const reportExecAfter = (await db.modelExecutions.get(
      reportExecBefore.executionId,
    )) as typeof reportExecBefore;
    expect(reportExecAfter.state).toBe("committed");
    expect(reportExecAfter.ackState).toBe("acknowledged");
    // The audit never re-dispatched the model.
    expect(
      host.executeCalls.filter((call) => call.executionId === reportExecBefore.executionId),
    ).toHaveLength(1);
  });

  it("legacy undefined focus Round：不补 focus 且能正常完成（三态语义：undefined 绕过 focus 注入）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // Manually seed a legacy round: a running round with focusMessageId absent
    // (pre-S2 row shape: the field simply is not present on the record).
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((candidate) => candidate.state === "active")
      .first();
    const token = {
      controllerId: binding?.controllerId as string,
      leaseEpoch: binding?.leaseEpoch as number,
    };
    const legacyRound = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    // createRound writes focusMessageId: null; strip the key and put a fresh copy
    // to emulate a true pre-S2 row whose Dexie record never had the field.
    const { focusMessageId: _omitted, ...legacyRow } = (await db.rounds.get(
      legacyRound.id,
    )) as DiscussionRound;
    void _omitted;
    await db.rounds.put(legacyRow as DiscussionRound);
    const legacyStored = (await db.rounds.get(legacyRound.id)) as DiscussionRound;
    expect(legacyStored.focusMessageId).toBeUndefined();
    await transitionRound(db, {
      roomId: room.id,
      roundId: legacyRound.id,
      token,
      to: "prewarming",
    });
    await transitionRound(db, {
      roomId: room.id,
      roundId: legacyRound.id,
      token,
      to: "running",
    });

    // Drain the loop manually: a legacy round is NOT awaiting focus.
    const { orchestrator: driver } = makeOrchestrator();
    const drive = driver as unknown as { runLoop(roomId: string): Promise<void> };
    const drivePromise = drive.runLoop(room.id);
    await vi.waitFor(() => {
      expect(host.executeCalls.some((call) => call.participantId === p1.id)).toBe(true);
    });
    await drivePromise;

    const stored = (await db.rounds.get(legacyRound.id)) as DiscussionRound;
    expect(stored.phase).toBe("completed");
    expect(stored.focusMessageId).toBeUndefined(); // never retro-focussed
    // The first execute is a MESSAGE (p1), NOT a focus — the focus dispatch
    // was skipped because focusMessageId !== null check used strict === null.
    expect(host.executeCalls[0]?.participantId).toBe(p1.id);
    expect(host.instructionRecords[0]?.wireKind).toBe("message");
    // The first instruction text is the brainstorm MESSAGE template, not the
    // brainstorm FOCUS template (which starts with 「你是本轮的主持人」).
    expect(host.instructionRecords[0]?.text).toBe(instructionText("brainstorm", "message"));
    expect(host.instructionRecords[0]?.text).not.toBe(instructionText("brainstorm", "focus"));
    // Exactly three executions (focus never dispatched) for this legacy round.
    expect(host.executeCalls).toHaveLength(3);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(1);
  });

  it("focus 失败按失败语义暂停且不阻塞「focus 完成前无人发言」：[fail, fail] → paused(execution_failed)，仅 2 次 focus 尝试，participant messages 0，focusMessageId null", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "fail", retryable: true }, { kind: "fail", retryable: false });

    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pausedFrom).toBe("running");
    expect(round?.pauseReason?.code).toBe("execution_failed");
    expect(round?.pauseReason?.participantId).toBe(p1.id);

    // Two focus attempts (original + one retry); no participant ever spoke.
    expect(host.executeCalls).toHaveLength(2);
    expect(host.executeCalls.every((call) => call.participantId === p1.id)).toBe(true);
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(0);
    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(storedRound.focusMessageId).toBeNull();
    expect(storedRound.nextParticipantIndex).toBe(0);
    // One focus original + one focus retry, both failed.
    const focusExecs = (await db.modelExecutions.where("roomId").equals(room.id).toArray()).filter(
      (execution) => execution.resultKind === "focus",
    );
    expect(focusExecs).toHaveLength(2);
    expect(focusExecs.every((execution) => execution.state === "failed")).toBe(true);
    expect(focusExecs[1]?.retryOfExecutionId).toBe(focusExecs[0]?.executionId);
  });

  it("focus 失败变体：modelVerdict mismatch → paused(model_mismatch)（focus 完成前无人发言）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, {
      kind: "complete",
      output: "wrong model output",
      effectiveModel: "other-model",
      modelVerdict: "mismatch",
    });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.code).toBe("model_mismatch");
    expect(host.executeCalls).toHaveLength(1);
    expect(host.executeCalls[0]?.participantId).toBe(p1.id);
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(0);
    const focusExec = (await db.modelExecutions.where("roomId").equals(room.id).toArray())[0];
    expect(focusExec?.state).toBe("discarded");
    expect(focusExec?.runtimeOutcome).toBe("model_mismatch");
  });

  it("focus 的 retry-once 链：[fail retryable, complete] → focus 两次 execution 且 retryOfExecutionId 链接、round 推进至 completed", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "fail", retryable: true }, { kind: "complete" });

    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
    const focusExecs = (await db.modelExecutions.where("roomId").equals(room.id).toArray())
      .filter((execution) => execution.resultKind === "focus")
      .sort((a, b) => (a.executionId < b.executionId ? -1 : 1));
    expect(focusExecs).toHaveLength(2);
    expect(focusExecs[0]?.state).toBe("failed");
    expect(focusExecs[1]?.state).toBe("committed");
    expect(focusExecs[1]?.retryOfExecutionId).toBe(focusExecs[0]?.executionId);
    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(storedRound.focusMessageId).not.toBeNull();
  });
});
