import "fake-indexeddb/auto";

import {
  type ControllerToken,
  activateRuntimeBinding,
  appendUserMessage,
  beginExecution,
  commitModelMessage,
  createRound,
  createRuntimeBindingTx,
  markAcknowledged,
  markBindingClosed,
  markBindingClosing,
  markExecutionDispatched,
  pauseRound,
  transitionRound,
} from "@/lib/discussion-transactions";
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
import { handleCompletedExecution } from "@/orchestrator/commit-execution";
import {
  buildContextSnapshot,
  computeInstructionDigest,
  initializeRoomDigest,
} from "@/orchestrator/context-snapshot";
import {
  type ControlState,
  type LockHandle,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Discussion Orchestrator (U5) against real Dexie on fake-indexeddb with a
 * scripted in-process fake Host (single fetch handler, SSE via ReadableStream).
 * Covers the handoff cases 1-15: happy path, persist→ACK boundaries, Host
 * restart, the three structured discards, prewarm gate, stale context, SSE
 * reconnect, startup audit classification, dual-client control, creating
 * binding convergence, Dexie-only restore, pause/abort and retry-once.
 *
 * Notes on test-side decisions (documented in the U5 verification record):
 * - The first scope of a room is booted via the public `ensureScope` API:
 *   `startRound` requires an active binding token before it can create the
 *   first Round, so scope creation must precede the first `startRound`.
 * - The U5-review bugs (missing Host activate, missing retryOfExecutionId
 *   link, run loop stopping after a successful retry, stale Round return on
 *   the prewarm-pause path) were fixed in the U6 pre-pass; their former
 *   it.fails pins are ordinary regression tests at the bottom of this file.
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
  /** Auto-script executions close their SSE streams after replay. */
  autoClose: boolean;
  streams: Set<StreamEntry>;
}

interface ExecuteCall {
  executionId: string;
  participantId: string;
  instructionKind: "message" | "summary";
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
      snapshot: { instruction: { kind: "message" | "summary" } };
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
// Controllable in-memory LockProvider
// ---------------------------------------------------------------------------

function createFakeLocks(): LockProvider {
  const held = new Set<string>();
  const waiters = new Map<string, ((handle: LockHandle | null) => void)[]>();
  const makeHandle = (name: string): LockHandle => ({
    release() {
      if (!held.delete(name)) return;
      const queue = waiters.get(name);
      const next = queue?.shift();
      if (queue && queue.length === 0) waiters.delete(name);
      if (next) {
        held.add(name);
        next(makeHandle(name));
      }
    },
  });
  return {
    tryAcquire: (name) => {
      if (held.has(name)) return Promise.resolve(null);
      held.add(name);
      return Promise.resolve(makeHandle(name));
    },
    acquire: (name) =>
      new Promise((resolvePromise) => {
        if (!held.has(name)) {
          held.add(name);
          resolvePromise(makeHandle(name));
          return;
        }
        const queue = waiters.get(name) ?? [];
        queue.push(resolvePromise);
        waiters.set(name, queue);
      }),
  };
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

async function seedBase(): Promise<Seed> {
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
    createDiscussionRoom({ topic: "Topic", background: "bg", facilitatorParticipantId: "pending" }),
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

async function activeToken(roomId: string): Promise<ControllerToken> {
  const binding = await db.runtimeBindings
    .where("roomId")
    .equals(roomId)
    .filter((candidate) => candidate.state === "active")
    .first();
  if (!binding?.controllerId || binding.leaseEpoch === null) {
    throw new Error("test: no active binding");
  }
  return { controllerId: binding.controllerId, leaseEpoch: binding.leaseEpoch };
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
// Tests
// ---------------------------------------------------------------------------

describe("discussion orchestrator (U5)", () => {
  it("1. drives two full rounds: fixed order, cursor/phase, revision +3/round, commit before ACK", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);

    const round1 = await orchestrator.startRound(room.id);
    expect(round1?.phase).toBe("completed");
    expect(host.executeCalls.map((call) => call.participantId)).toEqual([p1.id, p2.id, p1.id]);
    expect(host.executeCalls.map((call) => call.instructionKind)).toEqual([
      "message",
      "message",
      "summary",
    ]);
    const storedRound1 = (await db.rounds.get(round1?.id ?? "")) as DiscussionRound;
    expect(storedRound1.nextParticipantIndex).toBe(2);
    expect(storedRound1.phase).toBe("completed");
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(3);
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(2);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(1);

    // Persist precedes every ACK; every execution terminally acknowledged.
    expect(host.ackCalls).toHaveLength(3);
    for (const call of host.ackCalls) {
      expect(call.disposition).toBe("committed");
      expect(call.result).toBe("acknowledged");
      expect(call.stateAtAck).toBe("committed");
    }
    const executions1 = await db.modelExecutions.where("roundId").equals(storedRound1.id).toArray();
    expect(executions1).toHaveLength(3);
    for (const execution of executions1) {
      expect(execution.state).toBe("committed");
      expect(execution.ackState).toBe("acknowledged");
    }

    const round2 = await orchestrator.startRound(room.id);
    expect(round2?.phase).toBe("completed");
    expect(round2?.roundNumber).toBe(2);
    expect(host.executeCalls.map((call) => call.participantId)).toEqual([
      p1.id,
      p2.id,
      p1.id,
      p1.id,
      p2.id,
      p1.id,
    ]);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(6);
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(4);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(2);
    const all = await db.modelExecutions.where("roomId").equals(room.id).toArray();
    expect(all).toHaveLength(6);
    for (const execution of all) {
      expect(execution.ackState).toBe("acknowledged");
    }
  });

  it("2a. a replayed completed terminal commits exactly one body and re-ACKs", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator, client } = makeOrchestrator();
    const { token } = await orchestrator.ensureScope(room.id, [p1, p2]);
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((candidate) => candidate.state === "active")
      .first();
    const scopeId = binding?.executionScopeId as string;

    const round = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "running" });
    const execution = createModelExecution({
      executionId: "exec-replay-0001",
      roomId: room.id,
      roundId: round.id,
      participantId: p1.id,
      resultKind: "message",
      requestedModel: p1.modelId,
      contextRevision: room.contextRevision,
      expectedRoomDigest: room.contextDigest,
      participantSnapshotDigest: p1.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest({ kind: "message", text: "answer" }),
    });
    await beginExecution(db, { execution, token });
    await markExecutionDispatched(db, {
      executionId: execution.executionId,
      hostInstanceId: host.hostInstanceId,
      executionScopeId: scopeId,
      dispatchState: "unknown",
    });

    const completed: CompletedEvent = {
      executionId: execution.executionId,
      seq: 5,
      at: new Date().toISOString(),
      type: "completed",
      output: "replay body",
      requestedModel: p1.modelId,
      effectiveModel: p1.modelId,
      modelVerdict: "match",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: 5,
    };
    host.registerExecution({
      executionId: execution.executionId,
      participantId: p1.id,
      scopeId,
      state: "completed",
      terminalEvent: completed,
    });

    const deps = { db, client, scopeId, token, currentHostInstanceId: host.hostInstanceId };
    const first = await handleCompletedExecution(deps, execution.executionId, completed);
    if (first.kind !== "committed") throw new Error("expected first handling to commit");
    const second = await handleCompletedExecution(deps, execution.executionId, completed);
    expect(second).toEqual({ kind: "replayed", entityId: first.entityId });

    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(1);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(1);
    expect((await db.rounds.get(round.id))?.nextParticipantIndex).toBe(1);
    expect(host.ackCalls).toHaveLength(2);
    for (const call of host.ackCalls) {
      expect(call.disposition).toBe("committed");
      expect(call.result).toBe("acknowledged");
    }
  });

  it("2b. an ACK lost to a network error stays pending and is resent by the startup audit", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.ackBehavior = "fail-network";
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
    const pending = await db.modelExecutions.where("roomId").equals(room.id).toArray();
    expect(pending).toHaveLength(3);
    for (const execution of pending) {
      expect(execution.state).toBe("committed");
      expect(execution.ackState).toBe("pending");
    }
    expect(host.ackCalls).toHaveLength(0); // never reached the Host

    host.ackBehavior = "ok";
    const executeCallsBefore = host.executeCalls.length;
    const { orchestrator: auditor } = makeOrchestrator();
    await auditor.startupAudit();

    expect(host.executeCalls).toHaveLength(executeCallsBefore); // never re-invoked
    expect(host.ackCalls).toHaveLength(3);
    for (const call of host.ackCalls) {
      expect(call.disposition).toBe("committed");
      expect(call.result).toBe("acknowledged");
    }
    const after = await db.modelExecutions.where("roomId").equals(room.id).toArray();
    for (const execution of after) {
      expect(execution.ackState).toBe("acknowledged");
    }
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(2);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(3);
  });

  it("2c. an ACK processed but lost in flight converges via tombstone without re-committing", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.ackBehavior = "drop-response"; // Host processes, response never arrives
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
    expect(host.ackTombstones).toBe(3);
    const pending = await db.modelExecutions.where("roomId").equals(room.id).toArray();
    for (const execution of pending) {
      expect(execution.ackState).toBe("pending");
    }

    host.ackBehavior = "ok";
    const executeCallsBefore = host.executeCalls.length;
    const { orchestrator: auditor } = makeOrchestrator();
    await auditor.startupAudit();

    expect(host.executeCalls).toHaveLength(executeCallsBefore);
    expect(host.ackTombstones).toBe(3); // tombstone replay, no re-processing
    expect(host.ackCalls).toHaveLength(6); // 3 lost + 3 resent
    const after = await db.modelExecutions.where("roomId").equals(room.id).toArray();
    for (const execution of after) {
      expect(execution.ackState).toBe("acknowledged");
    }
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(2);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(3);
  });

  it("3. expires pending ACKs after a Host restart; committed bodies survive untouched", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.ackBehavior = "fail-network";
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");

    host.restart("host-2");
    const { orchestrator: auditor } = makeOrchestrator();
    await auditor.startupAudit();

    const after = await db.modelExecutions.where("roomId").equals(room.id).toArray();
    expect(after).toHaveLength(3);
    for (const execution of after) {
      expect(execution.state).toBe("committed");
      expect(execution.ackState).toBe("expired");
    }
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(2);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(1);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(3);
    expect((await db.rounds.get(round?.id ?? ""))?.phase).toBe("completed");
    expect(host.executeCalls).toHaveLength(0);
    expect(host.ackCalls).toHaveLength(0); // no HTTP attempt against the new Host
  });

  it("4. discards a model mismatch with a structured pause and never retries", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, {
      kind: "complete",
      output: "mismatched output",
      effectiveModel: "other-model",
      modelVerdict: "mismatch",
    });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pausedFrom).toBe("running");
    expect(round?.pauseReason).toMatchObject({ code: "model_mismatch", participantId: p1.id });
    const execution = (await db.modelExecutions.where("roomId").equals(room.id).toArray())[0];
    expect(execution?.state).toBe("discarded");
    expect(execution?.runtimeOutcome).toBe("model_mismatch");
    expect(execution?.requestedModel).toBe(p1.modelId);
    expect(execution?.effectiveModel).toBe("other-model");
    expect(execution?.error?.code).toBe("MODEL_MISMATCH");
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(0);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(0);
    expect(host.executeCalls).toHaveLength(1); // no retry
    expect(host.ackCalls).toEqual([
      expect.objectContaining({
        disposition: "discarded",
        result: "acknowledged",
        stateAtAck: "discarded",
      }),
    ]);
  });

  it("5. discards toolState unknown: preview never lands, structured pause, no retry", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator, previews } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete", output: "tool preview text", toolState: "unknown" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason).toMatchObject({ code: "tool_state_unknown", participantId: p1.id });
    // The preview was displayed but is dropped, never persisted.
    expect(previews.filter((event) => event.type === "output.delta")).toHaveLength(2);
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(0);
    const execution = (await db.modelExecutions.where("roomId").equals(room.id).toArray())[0];
    expect(execution?.state).toBe("discarded");
    expect(execution?.runtimeOutcome).toBe("tool_state_unknown");
    expect(execution?.error?.code).toBe("TOOL_STATE_UNKNOWN");
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(0);
    expect(host.executeCalls).toHaveLength(1);
    expect(host.ackCalls).toEqual([expect.objectContaining({ disposition: "discarded" })]);
  });

  it("6. discards empty output with a structured pause", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete", output: "   " });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason).toMatchObject({ code: "empty_output", participantId: p1.id });
    const execution = (await db.modelExecutions.where("roomId").equals(room.id).toArray())[0];
    expect(execution?.state).toBe("discarded");
    expect(execution?.runtimeOutcome).toBe("empty_output");
    expect(execution?.error?.code).toBe("EMPTY_OUTPUT");
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(0);
    expect(host.executeCalls).toHaveLength(1);
    expect(host.ackCalls).toEqual([expect.objectContaining({ disposition: "discarded" })]);
  });

  it("7. pauses at prewarm when a participant is not ready; nobody speaks", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    host.failPrewarmFor(p2.id);
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pausedFrom).toBe("prewarming");
    expect(round?.pauseReason).toMatchObject({ code: "prewarm_failed", participantId: p2.id });
    // Durable row agrees with the returned Round.
    const stored = await db.rounds.get(round?.id ?? "");
    expect(stored?.phase).toBe("paused");
    expect(host.executeCalls).toHaveLength(0);
    expect(await db.modelExecutions.where("roomId").equals(room.id).count()).toBe(0);
  });

  it("8. a shared-context write mid-execution discards the stale completion", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator, previews } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "hang" });
    const roundPromise = orchestrator.startRound(room.id);
    await vi.waitFor(() => {
      expect(previews.some((event) => event.type === "started")).toBe(true);
    });

    // Shared-context write while the execution streams: the completion must
    // not land, the cursor must not advance, the revision must not bump again.
    const token = await activeToken(room.id);
    const activeRoundId = (await db.rooms.get(room.id))?.activeRoundId as string;
    await appendUserMessage(db, {
      roomId: room.id,
      roundId: activeRoundId,
      token,
      content: "user interjects mid-turn",
    });
    const executionId = host.executeCalls[0]?.executionId as string;
    host.complete(executionId, "late model output");
    const round = await roundPromise;

    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.code).toBe("stale_context");
    const messages = await db.messages.where("roomId").equals(room.id).toArray();
    expect(messages.filter((message) => message.role === "participant")).toHaveLength(0);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(1); // user message only
    const execution = (await db.modelExecutions.where("roomId").equals(room.id).toArray())[0];
    expect(execution?.state).toBe("discarded");
    expect(execution?.runtimeOutcome).toBe("stale_context");
    expect(host.executeCalls).toHaveLength(1); // no retry
    expect(host.ackCalls).toEqual([
      expect.objectContaining({ disposition: "discarded", result: "acknowledged" }),
    ]);
  });

  it("8b. reconnects the event stream with afterSeq after a mid-execution disconnect", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator, previews } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "hang" });
    const roundPromise = orchestrator.startRound(room.id);
    await vi.waitFor(() => {
      expect(previews.filter((event) => event.type === "started")).toHaveLength(1);
    });
    const executionId = host.executeCalls[0]?.executionId as string;

    // The connection dies without a terminal; the orchestrator checks the
    // Host record (still running) and reconnects from afterSeq.
    host.dropStreams(executionId);
    await vi.waitFor(() => {
      expect(host.getExecutionCalls).toContain(executionId);
    });
    host.complete(executionId, "resumed output");
    const round = await roundPromise;

    expect(round?.phase).toBe("completed");
    // The disconnected execution was never re-dispatched...
    expect(host.executeCalls.filter((call) => call.executionId === executionId)).toHaveLength(1);
    // ...and the replay was strictly greater-than: this execution's
    // `started` (seq 1) was never re-delivered on the reconnect.
    expect(
      previews.filter((event) => event.type === "started" && event.executionId === executionId),
    ).toHaveLength(1);
    const bodies = await db.messages.where("roomId").equals(room.id).toArray();
    expect(bodies.some((message) => message.content === "resumed output")).toBe(true);
  });

  it("9. startup audit classifies prepared / running-404 / running-known / committed", async () => {
    async function seedRoomWithExecution(index: number): Promise<{
      room: DiscussionRoom;
      p1: Participant;
      token: ControllerToken;
      round: DiscussionRound;
      executionId: string;
    }> {
      const { room, p1, p2 } = await seedBase();
      const binding = await createRuntimeBindingTx(db, {
        roomId: room.id,
        scopeRequestId: `req-audit-${index}-x`,
      });
      await activateRuntimeBinding(db, {
        id: binding.id,
        hostInstanceId: "host-1",
        executionScopeId: `scope-audit-${index}`,
        controllerId: `ctrl-audit-${index}`,
        leaseEpoch: 1,
      });
      const token = { controllerId: `ctrl-audit-${index}`, leaseEpoch: 1 };
      const round = await createRound(db, {
        roomId: room.id,
        token,
        participantOrder: [p1.id, p2.id],
      });
      await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
      await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "running" });
      const execution = createModelExecution({
        executionId: `exec-audit-${index}-01`,
        roomId: room.id,
        roundId: round.id,
        participantId: p1.id,
        resultKind: "message",
        requestedModel: p1.modelId,
        contextRevision: room.contextRevision,
        expectedRoomDigest: room.contextDigest,
        participantSnapshotDigest: p1.participantSnapshotDigest,
        instructionDigest: computeInstructionDigest({ kind: "message", text: "answer" }),
      });
      await beginExecution(db, { execution, token });
      return { room, p1, token, round, executionId: execution.executionId };
    }

    // A: persisted before execute (prepared, never dispatched).
    const a = await seedRoomWithExecution(1);
    // B: dispatched, but the Host has no such execution (404).
    const b = await seedRoomWithExecution(2);
    await markExecutionDispatched(db, {
      executionId: b.executionId,
      hostInstanceId: "host-1",
      executionScopeId: "scope-audit-2",
      dispatchState: "unknown",
    });
    // C: dispatched and the Host still has it (outcome unknown).
    const c = await seedRoomWithExecution(3);
    await markExecutionDispatched(db, {
      executionId: c.executionId,
      hostInstanceId: "host-1",
      executionScopeId: "scope-audit-3",
      dispatchState: "unknown",
    });
    host.seedScope({
      scopeId: "scope-audit-3",
      controllerId: "ctrl-audit-3",
      leaseEpoch: 1,
      participantIds: [c.p1.id],
    });
    host.registerExecution({
      executionId: c.executionId,
      participantId: c.p1.id,
      scopeId: "scope-audit-3",
      state: "running",
    });
    // D: committed and acknowledged — the audit must never downgrade it.
    const d = await seedRoomWithExecution(4);
    await markExecutionDispatched(db, {
      executionId: d.executionId,
      hostInstanceId: "host-1",
      executionScopeId: "scope-audit-4",
      dispatchState: "unknown",
    });
    await commitModelMessage(db, {
      executionId: d.executionId,
      token: d.token,
      content: "committed body",
      effectiveModel: "model-a",
      usage: null,
      finalEventSeq: 5,
      dispatchState: "accepted",
      toolState: "none",
    });
    await markAcknowledged(db, d.executionId);

    const { orchestrator } = makeOrchestrator();
    await orchestrator.startupAudit();

    const executionA = await db.modelExecutions.get(a.executionId);
    expect(executionA?.state).toBe("failed");
    expect(executionA?.error?.code).toBe("SAFE_INTERRUPTION");
    expect(executionA?.ackState).toBeNull();
    expect((await db.rounds.get(a.round.id))?.phase).toBe("paused");
    expect((await db.rounds.get(a.round.id))?.pauseReason?.code).toBe("execution_failed");

    const executionB = await db.modelExecutions.get(b.executionId);
    expect(executionB?.state).toBe("interrupted");
    expect(executionB?.error?.code).toBe("SAFE_INTERRUPTION");
    expect((await db.rounds.get(b.round.id))?.phase).toBe("paused");

    const executionC = await db.modelExecutions.get(c.executionId);
    expect(executionC?.state).toBe("interrupted");
    expect(executionC?.error?.code).toBe("INTERRUPTED_UNKNOWN");
    expect((await db.rounds.get(c.round.id))?.phase).toBe("paused");

    const executionD = await db.modelExecutions.get(d.executionId);
    expect(executionD?.state).toBe("committed");
    expect(executionD?.ackState).toBe("acknowledged");
    expect(await db.messages.where("roomId").equals(d.room.id).count()).toBe(1);

    // The Host was queried for B and C, never for the undispatched A.
    expect(host.getExecutionCalls).toContain(b.executionId);
    expect(host.getExecutionCalls).toContain(c.executionId);
    expect(host.getExecutionCalls).not.toContain(a.executionId);
  });

  it("10. hands control to a second client with a higher epoch; the old token is rejected", async () => {
    const { room, p1, p2 } = await seedBase();
    const locks = createFakeLocks();
    const a = makeOrchestrator({ locks });
    const b = makeOrchestrator({ locks });
    await a.orchestrator.ensureScope(room.id, [p1, p2]);

    const handleA = await a.orchestrator.controlRoom(room.id);
    expect(handleA).not.toBeNull();
    expect(a.controlStates).toEqual(["acquiring", "controlling"]);

    const bPromise = b.orchestrator.controlRoom(room.id);
    await vi.waitFor(() => {
      expect(b.controlStates).toContain("observing");
    });
    handleA?.release();
    const handleB = await bPromise;
    expect(handleB).not.toBeNull();
    expect(b.controlStates).toEqual(["acquiring", "observing", "controlling"]);

    // Two takeovers: A (epoch 2) then B (epoch 3); the binding follows B.
    expect(host.takeoverCalls).toHaveLength(2);
    expect(host.takeoverCalls[0]?.leaseEpoch).toBe(2);
    expect(host.takeoverCalls[1]?.leaseEpoch).toBe(3);
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((candidate) => candidate.state === "active")
      .first();
    expect(binding?.leaseEpoch).toBe(3);
    expect(binding?.controllerId).toBe(host.takeoverCalls[1]?.controllerId);

    // A's stale token: the Dexie CAS rejects the write...
    const tokenA = {
      controllerId: host.takeoverCalls[0]?.controllerId as string,
      leaseEpoch: 2,
    };
    await expect(
      appendUserMessage(db, { roomId: room.id, roundId: "any-round", token: tokenA, content: "x" }),
    ).rejects.toMatchObject({ code: "STALE_CONTROLLER" });
    // ...and the Host fences it too.
    const snapshot = buildContextSnapshot({
      room,
      participant: p1,
      instruction: { kind: "message", text: "x" },
      items: [],
    });
    await expect(
      b.client.execute(binding?.executionScopeId as string, {
        ...tokenA,
        executionId: "exec-stale-token1",
        participantId: p1.id,
        snapshot,
      }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_CONTROLLER" });
    handleB?.release();
  });

  it("11. creating bindings: idempotent row, compensated close on CAS failure, audit convergence", async () => {
    const { room } = await seedBase();
    // Same scopeRequestId retry returns the same row — never a duplicate.
    const first = await createRuntimeBindingTx(db, {
      roomId: room.id,
      scopeRequestId: "req-creating-0001",
    });
    const second = await createRuntimeBindingTx(db, {
      roomId: room.id,
      scopeRequestId: "req-creating-0001",
    });
    expect(second.id).toBe(first.id);
    expect(await db.runtimeBindings.where("roomId").equals(room.id).count()).toBe(1);

    // The Host create succeeded but the active CAS failed: compensate close
    // with the returned token so no warm Scope leaks.
    const seed2 = await seedBase();
    const { orchestrator } = makeOrchestrator();
    host.onCreateScope = async () => {
      const creating = await db.runtimeBindings.where("roomId").equals(seed2.room.id).first();
      if (creating) await markBindingClosed(db, creating.id);
    };
    await expect(
      orchestrator.ensureScope(seed2.room.id, [seed2.p1, seed2.p2]),
    ).rejects.toMatchObject({ code: "BINDING_STALE" });
    expect(host.closeCalls).toHaveLength(1);
    expect(host.closeCalls[0]?.scopeId).toBe(host.createScopeCalls[0]?.scopeId);
    expect(host.closeCalls[0]?.controllerId).toBe(host.createScopeCalls[0]?.controllerId);
    expect(host.closeCalls[0]?.leaseEpoch).toBe(1);
    expect((await db.runtimeBindings.where("roomId").equals(seed2.room.id).first())?.state).toBe(
      "closed",
    );

    // Startup audit: creating/closing bindings never stay forever.
    const seed3 = await seedBase();
    await createRuntimeBindingTx(db, {
      roomId: seed3.room.id,
      scopeRequestId: "req-creating-0002",
    });
    const seed4 = await seedBase();
    const closing = await createRuntimeBindingTx(db, {
      roomId: seed4.room.id,
      scopeRequestId: "req-creating-0003",
    });
    await activateRuntimeBinding(db, {
      id: closing.id,
      hostInstanceId: "host-1",
      executionScopeId: "scope-closing-1",
      controllerId: "ctrl-closing-1",
      leaseEpoch: 1,
    });
    await markBindingClosing(db, closing.id);
    host.seedScope({
      scopeId: "scope-closing-1",
      controllerId: "ctrl-closing-1",
      leaseEpoch: 1,
      participantIds: [],
    });

    const { orchestrator: auditor } = makeOrchestrator();
    await auditor.startupAudit();
    expect((await db.runtimeBindings.get(first.id))?.state).toBe("closed");
    expect((await db.runtimeBindings.where("roomId").equals(seed3.room.id).first())?.state).toBe(
      "closed",
    );
    expect((await db.runtimeBindings.get(closing.id))?.state).toBe("closed");
    // The closing binding's scope was asked to close (best-effort compensation).
    expect(
      host.closeCalls.some(
        (call) => call.scopeId === "scope-closing-1" && call.controllerId === "ctrl-closing-1",
      ),
    ).toBe(true);
  });

  it("12. restores a completed room purely from Dexie: audit does zero execute/ack calls", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");

    const { orchestrator: auditor } = makeOrchestrator();
    await auditor.startupAudit();

    expect(host.executeCalls).toHaveLength(3);
    expect(host.ackCalls).toHaveLength(3);
    expect(host.getExecutionCalls).toHaveLength(0);
    expect(await db.messages.where("roomId").equals(room.id).count()).toBe(2);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(1);
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(3);
    expect((await db.rounds.get(round?.id ?? ""))?.phase).toBe("completed");
  });

  it("13. pauseRoom cancels the in-flight execution; the discarded terminal is ACKed via audit", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator, previews } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "hang" });
    const roundPromise = orchestrator.startRound(room.id);
    await vi.waitFor(() => {
      expect(previews.some((event) => event.type === "started")).toBe(true);
    });

    await orchestrator.pauseRoom(room.id);
    expect((await db.rooms.get(room.id))?.runState).toBe("paused");
    expect(host.cancelCalls).toHaveLength(1);

    const round = await roundPromise;
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.code).toBe("user_cancelled");
    const execution = (await db.modelExecutions.where("roomId").equals(room.id).toArray())[0];
    expect(execution?.state).toBe("discarded");
    expect(execution?.runtimeOutcome).toBe("user_cancelled");
    expect(execution?.error?.code).toBe("USER_CANCELLED");
    // Interrupted terminals carry no inline ACK (by design ackState=null for
    // failed/interrupted; user_cancelled discards keep pending) — the
    // recovery scan delivers the discarded ACK.
    expect(execution?.ackState).toBe("pending");
    expect(host.ackCalls).toHaveLength(0);

    const { orchestrator: auditor } = makeOrchestrator();
    await auditor.startupAudit();
    expect(host.ackCalls).toEqual([
      expect.objectContaining({ disposition: "discarded", result: "acknowledged" }),
    ]);
    expect((await db.modelExecutions.get(execution?.executionId ?? ""))?.ackState).toBe(
      "acknowledged",
    );
  });

  it("14. abortPausedRound ends only a paused round", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    const { token } = await orchestrator.ensureScope(room.id, [p1, p2]);
    const round = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "running" });

    await expect(orchestrator.abortPausedRound(room.id)).rejects.toThrow(
      "only a paused round can be ended",
    );

    await pauseRound(db, {
      roomId: room.id,
      roundId: round.id,
      token,
      reason: { code: "execution_failed", detail: "seeded" },
    });
    await orchestrator.abortPausedRound(room.id);
    const stored = await db.rounds.get(round.id);
    expect(stored?.phase).toBe("aborted");
    expect(stored?.activeExecutionId).toBeNull();
    const roomRow = await db.rooms.get(room.id);
    expect(roomRow?.activeRoundId).toBeNull();
    expect(roomRow?.runState).toBe("idle");
  });

  it("15. retries a retryable pre-dispatch failure once, then a failing retry pauses", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(
      p1.id,
      { kind: "fail", retryable: true, dispatchState: "not_dispatched" },
      { kind: "complete" },
    );
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
    // p1 twice (original + retry), then p2, then the facilitator summary.
    expect(host.executeCalls.map((call) => call.participantId)).toEqual([
      p1.id,
      p1.id,
      p2.id,
      p1.id,
    ]);
    expect(host.executeCalls.map((call) => call.instructionKind)).toEqual([
      "message",
      "message",
      "message",
      "summary",
    ]);
    expect(host.executeCalls[0]?.executionId).not.toBe(host.executeCalls[1]?.executionId);
    const attempts = (await db.modelExecutions.where("roomId").equals(room.id).toArray())
      .filter(
        (execution) => execution.participantId === p1.id && execution.resultKind === "message",
      )
      .sort((x, y) => (x.executionId < y.executionId ? -1 : 1));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.state).toBe("failed");
    expect(attempts[0]?.error?.retryable).toBe(true);
    expect(attempts[1]?.state).toBe("committed");

    // A failing retry pauses the round — no third dispatch.
    const seed2 = await seedBase();
    const { orchestrator: orchestrator2 } = makeOrchestrator();
    await orchestrator2.ensureScope(seed2.room.id, [seed2.p1, seed2.p2]);
    host.plan(
      seed2.p1.id,
      { kind: "fail", retryable: true, dispatchState: "not_dispatched" },
      { kind: "fail", retryable: false, dispatchState: "not_dispatched" },
    );
    const round2 = await orchestrator2.startRound(seed2.room.id);
    expect(round2?.phase).toBe("paused");
    expect(round2?.pauseReason?.code).toBe("execution_failed");
    expect(host.executeCalls.filter((call) => call.participantId === seed2.p1.id)).toHaveLength(2);
  });

  // Regression guards for U5-review bugs fixed in the U6 pre-pass (previously
  // pinned with it.fails): Host scope activation, the retry chain link, and
  // run-loop continuation after a successful retry.
  it("ensureScope activates the Host scope before the first execute", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    expect(host.activateCalls).toHaveLength(1);
  });

  it("the retried execution carries retryOfExecutionId (at-most-once enforced)", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(
      p1.id,
      { kind: "fail", retryable: true, dispatchState: "not_dispatched" },
      { kind: "complete" },
    );
    await orchestrator.startRound(room.id);
    const attempts = (await db.modelExecutions.where("roomId").equals(room.id).toArray())
      .filter(
        (execution) => execution.participantId === p1.id && execution.resultKind === "message",
      )
      .sort((x, y) => (x.executionId < y.executionId ? -1 : 1));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.retryOfExecutionId).toBe(attempts[0]?.executionId);
  });

  it("startRound continues the round after a successful retry", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(
      p1.id,
      { kind: "fail", retryable: true, dispatchState: "not_dispatched" },
      { kind: "complete" },
    );
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
  });

  // The at-most-once limit itself: a second retryable pre-dispatch failure
  // must pause, never dispatch a third time.
  it("a retryable failure on the RETRY pauses without a third dispatch", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(
      p1.id,
      { kind: "fail", retryable: true, dispatchState: "not_dispatched" },
      { kind: "fail", retryable: true, dispatchState: "not_dispatched" },
    );
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.code).toBe("execution_failed");
    expect(host.executeCalls.filter((call) => call.participantId === p1.id)).toHaveLength(2);
  });
});
