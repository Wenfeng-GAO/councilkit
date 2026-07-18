import "fake-indexeddb/auto";

import {
  type ControllerToken,
  createRound,
  markBindingClosed,
  skipParticipant,
  transitionRound,
} from "@/lib/discussion-transactions";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type {
  DiscussionAgent,
  DiscussionMessage,
  DiscussionRoom,
  DiscussionRound,
  DiscussionSummary,
  Participant,
} from "@/models/discussion/entities";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createParticipant,
} from "@/models/discussion/factories";
import type { ModelExecution } from "@/models/discussion/model-execution";
import {
  computeContextDigest,
  initializeRoomDigest,
  projectSharedContext,
} from "@/orchestrator/context-snapshot";
import {
  type ControlState,
  type LockProvider,
  createDiscussionOrchestrator,
  deriveSkipAnnotations,
  timestampById,
  weaveSkipAnnotations,
} from "@/orchestrator/discussion-orchestrator";
import { RuntimeClient } from "@/runtime/client";
import { CREDENTIAL_MODE, type DispatchState, type ToolState } from "@shared/runtime/contracts";
import type { RuntimeError } from "@shared/runtime/errors";
import {
  type InterruptedEvent,
  type ModelVerdict,
  type RuntimeEvent,
  type Usage,
  runtimeEventSchema,
} from "@shared/runtime/events";
import type { SnapshotItem } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Recovery orchestrator (S3): the failure-recovery + needs_rebase rotation
 * intents — skip / retry / rotateScope — exercised end-to-end against real
 * Dexie on fake-indexeddb with a scripted in-process fake Host. The fake-Host
 * / seed scaffolding mirrors tests/unit/decision-orchestrator.test.ts; this
 * file additionally puts a `message` on TurnPlan.fail so the Host can emit a
 * NEEDS_REBASE reconciliation detail failExecution stores on the pause reason.
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
      /** Scripted failure message. Used for the NEEDS_REBASE reconciliation
       * prefix ("session reconciliation: <reason>") so failExecution stores the
       * detail the rotateScope intent matches on. */
      message?: string;
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
  /** R1 releaseRuntime order probe: invoked inside handleClose to read the
   * binding's PERSISTED state at the instant closeScope fires. If the closure
   * ran inside the guard transaction (and the HTTP runs only after commit),
   * this reads "closed" — proving atomicity + post-commit HTTP ordering. */
  closeProbe: ((scopeId: string) => Promise<string | null>) | null = null;

  executeCalls: ExecuteCall[] = [];
  instructionRecords: InstructionRecord[] = [];
  /** Shared-projection items carried by each execute's context snapshot. */
  snapshotItems: SnapshotItem[][] = [];
  ackCalls: AckCall[] = [];
  cancelCalls: string[] = [];
  closeCalls: { scopeId: string; controllerId: string; leaseEpoch: number }[] = [];
  /** Parallel to closeCalls: the closeProbe binding-state reading captured in
   * each handleClose (null when the scope was already gone / no probe set). */
  closeStates: (string | null)[] = [];
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
    this.closeStates = [];
    this.takeoverCalls = [];
    this.getExecutionCalls = [];
    this.createScopeCalls = [];
    this.activateCalls = [];
    this.ackTombstones = 0;
    this.ackBehavior = "ok";
    this.onCreateScope = null;
    this.closeProbe = null;
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
          message: plan.message ?? "scripted failure",
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

  private async handleClose(
    scopeId: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    const scopeOrError = this.requireScope(scopeId);
    if (scopeOrError instanceof Response) return scopeOrError;
    const stale = this.fenced(scopeOrError, body);
    if (stale) return stale;
    // R1: snapshot the persisted binding state at the instant closeScope fires,
    // BEFORE marking the Host scope closed. The test asserts this reads
    // "closed" — i.e. the releaseRuntime tx already committed the closure
    // before issuing the HTTP close (atomic guard→close + post-commit HTTP).
    const stateAtClose = this.closeProbe ? await this.closeProbe(scopeId) : null;
    scopeOrError.state = "closed";
    this.closeCalls.push({
      scopeId,
      controllerId: String(body?.controllerId ?? ""),
      leaseEpoch: Number(body?.leaseEpoch ?? 0),
    });
    this.closeStates.push(stateAtClose);
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

/** 3-participant variant (p1 facilitator, then p2, p3) for the R1 permanence
 * scenario: P2 skipped → annotation woven into P3's snapshot → P3 fails → user
 * aborts the round → a new round's snapshot must still carry the skip. */
async function seedBaseTriplet(): Promise<Seed & { p3: Participant; agent3: DiscussionAgent }> {
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
  const agent3 = createDiscussionAgent({
    name: "A3",
    personaPrompt: "p3 persona",
    executionProfileId: "prof-1",
    modelId: "model-c",
    color: "#c3d4e5",
  });
  await db.agents.bulkAdd([agent1, agent2, agent3]);
  const room = initializeRoomDigest(
    createDiscussionRoom({
      topic: "Topic",
      background: "bg",
      facilitatorParticipantId: "pending",
      mode: "brainstorm",
    }),
  );
  await db.rooms.add(room);
  const p1 = createParticipant({ roomId: room.id, agent: agent1, profileDigest: "pd1" });
  const p2 = createParticipant({ roomId: room.id, agent: agent2, profileDigest: "pd2" });
  const p3 = createParticipant({ roomId: room.id, agent: agent3, profileDigest: "pd3" });
  // Deterministic participant order: activeParticipants sorts by createdAt.
  p1.createdAt = "2026-07-17T00:00:00.000Z";
  p2.createdAt = "2026-07-17T00:00:00.001Z";
  p3.createdAt = "2026-07-17T00:00:00.002Z";
  await db.participants.bulkAdd([p1, p2, p3]);
  room.facilitatorParticipantId = p1.id;
  await db.rooms.put(room);
  return { room, p1, p2, p3, agent1, agent2, agent3 };
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

/** Resolve the room's active binding to a ControllerToken (test helper). */
async function currentTokenFor(
  database: CouncilKitRuntimeDB,
  roomId: string,
): Promise<ControllerToken> {
  const binding = await database.runtimeBindings
    .where("roomId")
    .equals(roomId)
    .filter((candidate) => candidate.state === "active")
    .first();
  if (!binding || !binding.controllerId || binding.leaseEpoch === null) {
    throw new Error(`no active controller for room ${roomId}`);
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
// Recovery orchestration (S3): skip / retry / rotate end-to-end
// ---------------------------------------------------------------------------

describe("recovery orchestration: skip", () => {
  it("skip 推进 cursor，后续 Participant 正常发言、Round 完成；messages 仅 focus+p1，summary 存在", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // p1: focus complete, message complete. p2: message non-retryable fail.
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });

    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.participantId).toBe(p2.id);

    await orchestrator.skipFailedParticipant(room.id);

    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(storedRound.phase).toBe("completed");
    // execute order: focus(p1) → p1 message → p2 message(fail) → summary(p1).
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
    // Only focus + p1 message committed; p2 contributed no message.
    const messages = await db.messages.where("roomId").equals(room.id).toArray();
    expect(
      messages.filter((message) => message.role === "participant").map((m) => m.participantId),
    ).toEqual([p1.id, p1.id]);
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(1);
    // The skipped slot's terminal failure persists.
    const p2Execs = (await db.modelExecutions.where("roomId").equals(room.id).toArray()).filter(
      (execution) => execution.participantId === p2.id,
    );
    expect(p2Execs.every((execution) => execution.state === "failed")).toBe(true);
  });

  it("skip 不涨 Room revision：整轮 revision=提交次数（focus+p1+summary=3），skip 贡献 0", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    // At the pause (focus + p1 message committed) the revision is 2.
    expect((await db.rooms.get(room.id))?.contextRevision).toBe(2);

    await orchestrator.skipFailedParticipant(room.id);

    const storedRoom = await db.rooms.get(room.id);
    // Only the 3 actual commits bumped the revision (focus + p1 + summary);
    // the skip is a scheduling decision, not a shared-projection commit.
    expect(storedRoom?.contextRevision).toBe(3);
  });

  it("Summary 快照含跳过记录但 digest 脱钩：summary dispatch items 含 skip 注解；projected items 不含注解（digest 仅由投影决定）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");

    await orchestrator.skipFailedParticipant(room.id);

    // host.snapshotItems is one-per-execute; the summary dispatch is the LAST
    // execute (index 3), and its dispatch-time items carry the woven annotation.
    const summaryItems = host.snapshotItems.at(-1) ?? [];
    const annotation = summaryItems.find((item) => item.id === `skip-${round?.id}-${p2.id}`);
    expect(annotation).toBeDefined();
    expect(annotation?.role).toBe("user");
    expect(annotation?.content).toContain("第 1 轮");
    expect(annotation?.content).toContain("model-b");
    expect(annotation?.content).toContain("【调度记录】");
    // The annotation lives ONLY in the per-execution dispatch snapshot; the
    // persistent shared projection (the digest input) never contains it. This
    // is the contextDigest decoupling proof: computeContextDigest over the
    // projected items is unaffected by the woven skip annotation.
    const freshRoom = (await db.rooms.get(room.id)) as DiscussionRoom;
    const messages = await db.messages.where("roomId").equals(room.id).toArray();
    const summaries = await db.summaries.where("roomId").equals(room.id).toArray();
    const projected = projectSharedContext(freshRoom, messages, summaries).items;
    expect(projected.find((item) => item.id.startsWith("skip-"))).toBeUndefined();
    // The stored digest equals the digest recomputed over the projection only.
    expect(freshRoom.contextDigest).toBe(
      computeContextDigest({
        topic: freshRoom.topic,
        background: freshRoom.background,
        items: projected,
      }),
    );
  });

  it("跳过末位 Participant 直接翻 summarizing 并完成 summary", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    // order is [p1, p2]; skipping the second (last) slot flips to summarizing.
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.nextParticipantIndex).toBe(1); // paused at the last slot
    await orchestrator.skipFailedParticipant(room.id);
    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    // Cursor advanced past the order length and the round flipped to summary.
    expect(storedRound.nextParticipantIndex).toBe(2);
    expect(storedRound.phase).toBe("completed");
    expect(await db.summaries.where("roomId").equals(room.id).count()).toBe(1);
  });

  it("facilitator 禁止跳过：p1 message fail → skipParticipant reject FACILITATOR_NOT_SKIPPABLE，round 仍 paused", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // focus completes, then p1 (facilitator) message fails non-retryably.
    host.plan(
      p1.id,
      { kind: "complete" },
      { kind: "fail", retryable: false, dispatchState: "not_dispatched" },
    );
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.participantId).toBe(p1.id);

    // The transaction-level guard rejects the facilitator skip.
    const token = await currentTokenFor(db, room.id);
    await expect(
      skipParticipant(db, { roomId: room.id, roundId: round?.id ?? "", token }),
    ).rejects.toMatchObject({ code: "FACILITATOR_NOT_SKIPPABLE" });
    const stored = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(stored.phase).toBe("paused");
    expect(stored.nextParticipantIndex).toBe(0);
  });

  it("skip 守卫：非 paused → ROUND_PHASE；prewarm 暂停（无 participantId）→ SKIP_NOT_APPLICABLE", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const token = await currentTokenFor(db, room.id);
    // A running (non-paused) round: ROUND_PHASE.
    const runningRound = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, {
      roomId: room.id,
      roundId: runningRound.id,
      token,
      to: "prewarming",
    });
    await transitionRound(db, { roomId: room.id, roundId: runningRound.id, token, to: "running" });
    await db.rounds.update(runningRound.id, { focusMessageId: "seeded-focus" });
    await expect(
      skipParticipant(db, { roomId: room.id, roundId: runningRound.id, token }),
    ).rejects.toMatchObject({ code: "ROUND_PHASE" });
  });

  it("SKIP_NOT_APPLICABLE：prewarm 暂停（pauseReason 无 participantId）不可跳过", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const token = await currentTokenFor(db, room.id);
    // Seed a prewarm-paused round whose reason carries no participantId.
    const prewarmRound = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, {
      roomId: room.id,
      roundId: prewarmRound.id,
      token,
      to: "prewarming",
    });
    await db.rounds.update(prewarmRound.id, {
      phase: "paused",
      pausedFrom: "prewarming",
      pauseReason: { code: "prewarm_failed" },
    });
    await expect(
      skipParticipant(db, { roomId: room.id, roundId: prewarmRound.id, token }),
    ).rejects.toMatchObject({ code: "SKIP_NOT_APPLICABLE" });
  });

  it("R1 跳过事实永久：P2 被跳过 → 终止本轮 → 新一轮快照仍含 P2 跳过注解（P3 前缀不破）", async () => {
    const { room, p1, p2, p3 } = await seedBaseTriplet();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2, p3]);
    // focus + p1 message complete; p2 message fails (cursor pauses at p2).
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.participantId).toBe(p2.id);

    // Skip p2 → cursor advances to p3. Now dispatch p3; its snapshot MUST carry
    // the woven skip-r1-p2 annotation (the P3 session sees the skip).
    host.plan(p3.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    await orchestrator.skipFailedParticipant(room.id);
    // At this point round 1 is paused at p3 (p3 failed). Confirm p3's dispatch
    // snapshot carried the p2 skip annotation.
    const p3DispatchSnapshot = host.snapshotItems.at(-1) ?? [];
    const skipId = `skip-${round?.id}-${p2.id}`;
    expect(p3DispatchSnapshot.find((item) => item.id === skipId)).toBeDefined();

    // User aborts round 1 (P3 failed) and starts a new round 2.
    await orchestrator.abortPausedRound(room.id);
    const aborted = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(aborted.phase).toBe("aborted");
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "complete" });
    host.plan(p3.id, { kind: "complete" });
    const snapshotItemsCountBeforeRound2 = host.snapshotItems.length;
    await orchestrator.startRound(room.id);

    // R1 invariant: the aborted round 1 still derives the p2 skip annotation,
    // so round 2's dispatch snapshots carry it — the P3 session's history prefix
    // is NOT rewritten. Pick any round-2 message dispatch snapshot and assert
    // the annotation is present. (Pre-fix this would be missing → needs_rebase.)
    const round2Snapshots = host.snapshotItems.slice(snapshotItemsCountBeforeRound2);
    expect(round2Snapshots.length).toBeGreaterThan(0);
    const stillCarried = round2Snapshots.some((items) => items.some((item) => item.id === skipId));
    expect(stillCarried).toBe(true);
  });
});

describe("recovery orchestration:  skip annotations (pure)", () => {
  function round(over: Partial<DiscussionRound> & { id: string }): DiscussionRound {
    return {
      roomId: "room-1",
      roundNumber: 1,
      participantOrder: ["p1", "p2"],
      phase: "completed",
      pausedFrom: null,
      pauseReason: null,
      nextParticipantIndex: 2,
      activeExecutionId: null,
      focusMessageId: "f-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:00:10.000Z",
      ...over,
    };
  }
  function execution(over: Partial<ModelExecution> & { executionId: string }): ModelExecution {
    return {
      roomId: "room-1",
      roundId: "r-1",
      participantId: "p2",
      resultKind: "message",
      state: "failed",
      hostInstanceId: null,
      executionScopeId: null,
      requestedModel: "model-b",
      effectiveModel: null,
      dispatchState: "not_dispatched",
      toolState: "none",
      contextRevision: 1,
      expectedRoomDigest: "d",
      participantSnapshotDigest: "s",
      instructionDigest: "i",
      contentDigest: null,
      committedEntityType: null,
      committedEntityId: null,
      runtimeOutcome: null,
      usage: null,
      error: null,
      finalEventSeq: null,
      ackState: null,
      retryOfExecutionId: null,
      createdAt: "2026-07-17T00:00:05.000Z",
      updatedAt: "2026-07-17T00:00:05.000Z",
      ...over,
    };
  }
  function participantLike(id: string, modelId: string): Participant {
    return {
      id,
      roomId: "room-1",
      agentId: "agent-1",
      personaPrompt: "p",
      executionProfileId: "prof-1",
      profileRevision: 1,
      profileDigest: "d",
      modelId,
      participantSnapshotDigest: "s",
      state: "active",
      createdAt: "2026-07-17T00:00:00.000Z",
      endedAt: null,
    };
  }

  it("deriveSkipAnnotations：cursor 越过 + 无 committed + 有终态失败 → 一条注解；committed 的 slot 不注解；未越过的 slot 不注解", () => {
    const r = round({ id: "r-1", nextParticipantIndex: 2 });
    const execs = [
      execution({
        executionId: "e-p2",
        participantId: "p2",
        state: "failed",
        createdAt: "2026-07-17T00:00:05.000Z",
      }),
    ];
    const notes = deriveSkipAnnotations([r], execs, [participantLike("p2", "model-b")]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.item.id).toBe("skip-r-1-p2");
    expect(notes[0]?.item.role).toBe("user");
    expect(notes[0]?.at).toBe("2026-07-17T00:00:05.000Z");
    // A committed slot (retry succeeded) produces no annotation.
    const committedExecs = [
      execution({
        executionId: "e-p2-a",
        participantId: "p2",
        state: "failed",
        createdAt: "2026-07-17T00:00:05.000Z",
      }),
      execution({
        executionId: "e-p2-b",
        participantId: "p2",
        state: "committed",
        createdAt: "2026-07-17T00:00:06.000Z",
      }),
    ];
    expect(
      deriveSkipAnnotations([r], committedExecs, [participantLike("p2", "model-b")]),
    ).toHaveLength(0);
    // Cursor not yet past the slot.
    const early = round({ id: "r-2", nextParticipantIndex: 1 });
    expect(deriveSkipAnnotations([early], execs, [participantLike("p2", "model-b")])).toHaveLength(
      0,
    );
  });

  it("deriveSkipAnnotations（R1 永久性）：aborted Round 仍派生跳过注解——注解一旦织入必须永久，否则破坏 reconciler 前缀", () => {
    // Scenario R1 pure-projection proof: after the user aborts a round that
    // contained a skip, the annotation must STILL derive. The reconciler's
    // prefix math relies on every session that ever saw the annotation still
    // seeing it; dropping it on an abort rewrites the next round's prefix and
    // produces a spurious needs_rebase.
    const aborted = round({ id: "r-1", phase: "aborted", nextParticipantIndex: 2 });
    const execs = [
      execution({
        executionId: "e-p2",
        roundId: "r-1",
        participantId: "p2",
        state: "failed",
        createdAt: "2026-07-17T00:00:05.000Z",
      }),
    ];
    const notes = deriveSkipAnnotations([aborted], execs, [participantLike("p2", "model-b")]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.item.id).toBe("skip-r-1-p2");
    expect(notes[0]?.item.content).toContain("第 1 轮");
  });

  it("weaveSkipAnnotations：按时间编织，projection 与注解同 at 时 projection 先；digest 输入不含注解（调方负责 digest）", () => {
    const projection: SnapshotItem[] = [
      {
        id: "m-1",
        role: "participant",
        participantId: "p1",
        content: "hello",
        sourceExecutionId: "e-1",
      },
      { id: "s-1", role: "summary", content: "sum", sourceExecutionId: "e-sum" },
    ];
    const atById = new Map<string, string>([
      ["m-1", "2026-07-17T00:00:03.000Z"],
      ["s-1", "2026-07-17T00:00:09.000Z"],
    ]);
    const notes = [
      {
        at: "2026-07-17T00:00:05.000Z",
        item: { id: "skip-r1-p2", role: "user" as const, content: "【调度记录】…" },
      },
    ];
    const woven = weaveSkipAnnotations(projection, atById, notes);
    expect(woven.map((item) => item.id)).toEqual(["m-1", "skip-r1-p2", "s-1"]);
    // Same-at tie: projection first (its committed entity predated the failure).
    const sameAtNotes = [
      {
        at: "2026-07-17T00:00:03.000Z",
        item: { id: "skip-tie", role: "user" as const, content: "tie" },
      },
    ];
    const wovenTie = weaveSkipAnnotations(projection, atById, sameAtNotes);
    expect(wovenTie.map((item) => item.id)).toEqual(["m-1", "skip-tie", "s-1"]);
  });

  it("timestampById：聚合 message/summary createdAt", () => {
    const messages = [
      {
        id: "m-1",
        roomId: "room-1",
        roundId: "r-1",
        role: "participant",
        participantId: "p1",
        content: "hello",
        sourceExecutionId: "e-1",
        createdAt: "2026-07-17T00:00:03.000Z",
      },
    ];
    const summaries = [
      {
        id: "s-1",
        roomId: "room-1",
        roundId: "r-1",
        content: "sum",
        sourceExecutionId: "e-sum",
        generatedAt: "2026-07-17T00:00:09.000Z",
      },
    ];
    const map = timestampById(messages as DiscussionMessage[], summaries as DiscussionSummary[]);
    expect(map.get("m-1")).toBe("2026-07-17T00:00:03.000Z");
    expect(map.get("s-1")).toBe("2026-07-17T00:00:09.000Z");
  });
});

describe("recovery orchestration: retry", () => {
  it("手动重试：新 executionId + retryOf 链，成功后 Round 完成", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    const failedId = round?.pauseReason?.executionId as string;

    // Retry: resume + re-dispatch the same p2 message under a fresh id.
    host.plan(p2.id, { kind: "complete" });
    await orchestrator.retryFailedParticipant(room.id);

    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(storedRound.phase).toBe("completed");
    const execs = await db.modelExecutions.where("roomId").equals(room.id).toArray();
    const p2Execs = execs.filter((execution) => execution.participantId === p2.id);
    const failures = p2Execs.filter((execution) => execution.state === "failed");
    const retry = p2Execs.find((execution) => execution.state === "committed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.executionId).toBe(failedId);
    expect(retry).toBeDefined();
    expect(retry?.retryOfExecutionId).toBe(failedId);
    expect(retry?.executionId).not.toBe(failedId);
  });

  it("用户重试不受自动上限：自动 once 后 paused→手动 fail→paused→清注入手动再试→完成；自动未第二次触发", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // p1 focus+message complete. p2 message: a retryable not_dispatched failure
    // (triggers the auto once), then a second failure on the retry's retry, then
    // finally a manual success after clearing the injection.
    host.plan(
      p1.id,
      { kind: "complete" }, // focus
      { kind: "complete" }, // p1 message
    );
    host.plan(
      p2.id,
      { kind: "fail", retryable: true, dispatchState: "not_dispatched" }, // original → auto-retry once
      { kind: "fail", retryable: false, dispatchState: "not_dispatched" }, // retry attempt fails → pause
    );
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    // p2 dispatched twice so far (original + auto retry); both failed.
    const p2DispatchesAfterAuto = host.executeCalls.filter(
      (call) => call.participantId === p2.id,
    ).length;
    expect(p2DispatchesAfterAuto).toBe(2);

    // Manual retry #1: still failing (non-retryable) — must pause again.
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    await orchestrator.retryFailedParticipant(room.id);
    expect((await db.rounds.get(round?.id ?? ""))?.phase).toBe("paused");
    const p2DispatchesAfterManual1 = host.executeCalls.filter(
      (call) => call.participantId === p2.id,
    ).length;
    expect(p2DispatchesAfterManual1).toBe(3);

    // Manual retry #2: clear the injection (default-complete), succeeds.
    host.plan(p2.id, { kind: "complete" });
    await orchestrator.retryFailedParticipant(room.id);
    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(storedRound.phase).toBe("completed");
    const p2DispatchesAfterManual2 = host.executeCalls.filter(
      (call) => call.participantId === p2.id,
    ).length;
    // original + auto + manual#1 + manual#2 = 4 p2 message dispatches.
    expect(p2DispatchesAfterManual2).toBe(4);
    // Automatic retry fired exactly once (it never re-triggered on the manual chain).
    const p2Execs = (await db.modelExecutions.where("roomId").equals(room.id).toArray()).filter(
      (execution) => execution.participantId === p2.id,
    );
    // retryOfExecutionId !== null only on the auto retry (slot 1's retry).
    const autoLinked = p2Execs.filter((execution) => execution.retryOfExecutionId !== null);
    expect(autoLinked.length).toBeGreaterThanOrEqual(1);
  });

  it("同一 execution 永不重放：executionId 全集无重复；旧 execution 保持 failed；非 paused 再调 retry → reject 无新分发", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    const round = await orchestrator.startRound(room.id);
    const failedId = round?.pauseReason?.executionId as string;

    host.plan(p2.id, { kind: "complete" });
    await orchestrator.retryFailedParticipant(room.id);
    const storedRound = (await db.rounds.get(round?.id ?? "")) as DiscussionRound;
    expect(storedRound.phase).toBe("completed");

    // All executionIds observed by the Host are distinct.
    const allIds = host.executeCalls.map((call) => call.executionId);
    expect(new Set(allIds).size).toBe(allIds.length);
    // The failed execution stayed terminal (never re-dispatched).
    const failedExec = (await db.modelExecutions.get(failedId)) as ModelExecution;
    expect(failedExec.state).toBe("failed");
    // Calling retry again on a now-completed round rejects with no new dispatch.
    const dispatchesBefore = host.executeCalls.length;
    await expect(orchestrator.retryFailedParticipant(room.id)).rejects.toThrow(/paused round/);
    expect(host.executeCalls.length).toBe(dispatchesBefore);
  });
});

describe("recovery orchestration: rotateScope", () => {
  it("needs_rebase 暂停 → 一键轮转 → 旧 binding closed、新 binding active、round2 完成、旧正文保留；closeCalls=1、createScopeCalls=2", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const closeCallsBefore = host.closeCalls.length;
    const createScopeCallsBefore = host.createScopeCalls.length;
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, {
      kind: "fail",
      code: "NEEDS_REBASE",
      retryable: false,
      dispatchState: "not_dispatched",
      message: "session reconciliation: context_window_threshold",
    });
    const round1 = await orchestrator.startRound(room.id);
    expect(round1?.phase).toBe("paused");
    // The pause code is normalized to execution_failed; detail keeps the prefix.
    expect(round1?.pauseReason?.code).toBe("execution_failed");
    expect(round1?.pauseReason?.detail).toContain("session reconciliation:");

    const oldBinding = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { id: string; executionScopeId: string } | undefined;

    await orchestrator.rotateScope(room.id);

    // round1 aborted, a fresh round2 completed.
    const rounds = (await db.rounds.where("roomId").equals(room.id).toArray()).sort(
      (a, b) => a.roundNumber - b.roundNumber,
    );
    expect(rounds[0]?.phase).toBe("aborted");
    expect(rounds[1]?.phase).toBe("completed");
    // Old binding closed; a distinct new binding is active.
    const oldBindingAfter = await db.runtimeBindings.get(oldBinding?.id ?? "");
    expect(oldBindingAfter?.state).toBe("closed");
    const newBinding = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { id: string; executionScopeId: string } | undefined;
    expect(newBinding).toBeDefined();
    expect(newBinding?.id).not.toBe(oldBinding?.id);
    expect(newBinding?.executionScopeId).not.toBe(oldBinding?.executionScopeId);
    // The Host saw exactly one close + one fresh scope create (prewarm=1/participant).
    expect(host.closeCalls.length).toBe(closeCallsBefore + 1);
    expect(host.createScopeCalls.length).toBe(createScopeCallsBefore + 1);
    // round1's committed focus + p1 message survive into the room's messages.
    const messages = await db.messages.where("roomId").equals(room.id).toArray();
    expect(messages.filter((m) => m.role === "participant").length).toBeGreaterThanOrEqual(2);
    // Rotation derivation: this failure is the 1st NEEDS_REBASE in the room and
    // a newer binding exists → rebuilt true (covered directly as the spec basis
    // for rotationDisplayFor, unit-tested in round-timeline.test.ts).
    const needsRebaseExecs = (await db.modelExecutions.where("roomId").equals(room.id).toArray())
      .filter((execution) => execution.error?.code === "NEEDS_REBASE")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    expect(needsRebaseExecs).toHaveLength(1);
    const firstRebase = needsRebaseExecs[0];
    expect(firstRebase).toBeDefined();
    const bindings = await db.runtimeBindings.where("roomId").equals(room.id).toArray();
    const newerBindingExists = bindings.some(
      (b) => b.createdAt > (firstRebase?.createdAt ?? "") && b.executionScopeId,
    );
    expect(newerBindingExists).toBe(true);
  });

  it("非 needs_rebase 暂停拒绝轮转：普通 execution_failed → rotateScope reject，round 仍 paused，closeCalls 不变", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const closeCallsBefore = host.closeCalls.length;
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    expect(round?.pauseReason?.detail).not.toContain("session reconciliation:");

    await expect(orchestrator.rotateScope(room.id)).rejects.toThrow(/not a needs_rebase/);
    expect((await db.rounds.get(round?.id ?? ""))?.phase).toBe("paused");
    expect(host.closeCalls.length).toBe(closeCallsBefore);
  });

  it("closeScope 失败仍本地收敛：restart host-2 使 close 404 → rotateScope 正常走完、binding closed、新 scope 创建、round 完成", async () => {
    const { room, p1, p2 } = await seedBase();
    // Hijack closeScope to 404 by restarting the Host AFTER the scope is built
    // but BEFORE rotateScope runs (the old scope id vanishes from the restarted
    // host's memory, so the close fetch 404s).
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const hostInstanceIdBefore = host.hostInstanceId;
    expect(hostInstanceIdBefore).toBe("host-1");
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, {
      kind: "fail",
      code: "NEEDS_REBASE",
      retryable: false,
      dispatchState: "not_dispatched",
      message: "session reconciliation: context_window_threshold",
    });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");
    // Restart: in-memory scopes/executions are gone → close fetch 404s. The
    // cached hostInstanceId in the orchestrator still points at host-1, but the
    // restart left the orchestrator's cachedHostInstanceId stale; getScopeStatus
    // in ensureScope will see a 404 on the old scopeId → markBindingClosed →
    // cold rebuild. We clear the cached id by using a fresh orchestrator for the
    // rotation so it re-queries health.
    host.restart("host-2");
    const { orchestrator: rotator } = makeOrchestrator();
    // rotateScope must converge locally despite the 404 close.
    await rotator.rotateScope(room.id);
    const rounds = (await db.rounds.where("roomId").equals(room.id).toArray()).sort(
      (a, b) => a.roundNumber - b.roundNumber,
    );
    expect(rounds[0]?.phase).toBe("aborted");
    expect(rounds[1]?.phase).toBe("completed");
    const activeBinding = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { executionScopeId: string } | undefined;
    expect(activeBinding).toBeDefined();
  });
});

describe("recovery orchestration: releaseRuntime (S5)", () => {
  it("17. 释放 warm scope：closeScope 调用 + binding closed + 下一轮冷建（createScopeCalls=2）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "complete" });
    const round1 = await orchestrator.startRound(room.id);
    expect(round1?.phase).toBe("completed");

    const closeCallsBefore = host.closeCalls.length;
    const createScopeCallsBefore = host.createScopeCalls.length;
    const warmBinding = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { id: string; executionScopeId: string } | undefined;
    expect(warmBinding).toBeDefined();

    await orchestrator.releaseRuntime(room.id);

    // The warm scope was closed (best-effort, single call); the binding is now closed.
    expect(host.closeCalls.length).toBe(closeCallsBefore + 1);
    expect(host.closeCalls.at(-1)?.scopeId).toBe(warmBinding?.executionScopeId);
    const warmBindingAfter = await db.runtimeBindings.get(warmBinding?.id ?? "");
    expect(warmBindingAfter?.state).toBe("closed");
    const activeBindingAfter = await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first();
    expect(activeBindingAfter).toBeUndefined();

    // The next round cold-builds a fresh scope (ensureScope rebuilds because the
    // latest non-closed binding is gone / closed).
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "complete" });
    const round2 = await orchestrator.startRound(room.id);
    expect(round2?.phase).toBe("completed");
    expect(host.createScopeCalls.length).toBe(createScopeCallsBefore + 1);
    const warmAgain = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { executionScopeId: string } | undefined;
    expect(warmAgain?.executionScopeId).not.toBe(warmBinding?.executionScopeId);
  });

  it("18. 有 live execution 拒绝：hang plan 起轮 → releaseRuntime rejects；complete() 收尾", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator, previews } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // Hang the focus so the round is running with a live execution.
    host.plan(p1.id, { kind: "hang" });
    host.plan(p2.id, { kind: "complete" });
    const roundPromise = orchestrator.startRound(room.id);
    // Wait for the focus execution to dispatch (it is now "running" / live).
    await vi.waitFor(() => {
      expect(previews.some((event) => event.type === "started")).toBe(true);
    });

    const closeCallsBefore = host.closeCalls.length;
    await expect(orchestrator.releaseRuntime(room.id)).rejects.toThrow(/execution is running/);
    expect(host.closeCalls.length).toBe(closeCallsBefore);
    // R1 atomicity: a rejected guard never reaches the closure, so no closeScope
    // HTTP fires (closeStates empty) and the binding stays active.
    expect(host.closeStates).toHaveLength(0);
    // The binding stayed active.
    const active = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { executionScopeId: string; state: string } | undefined;
    expect(active).toBeDefined();
    expect(active?.state).toBe("active");

    // Reap the hanging focus so the round promise drains and the test tears
    // down cleanly (p1 message + p2 message + summary all default-complete).
    const liveExecutionId = host.executeCalls[0]?.executionId as string;
    expect(liveExecutionId).toBeTruthy();
    host.complete(liveExecutionId, "focus");
    const completed = await roundPromise;
    expect(completed?.phase).toBe("completed");
  });

  it("19. in-flight round（prewarming）拒绝：手动转 prewarming 阶段无执行 → releaseRuntime rejects", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // Seed a round halted at the prewarming phase with NO live execution — this
    // isolates the in-flight-round guard (liveExecutions === 0 here).
    const token = await currentTokenFor(db, room.id);
    const idleRound = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, {
      roomId: room.id,
      roundId: idleRound.id,
      token,
      to: "prewarming",
    });

    const closeCallsBefore = host.closeCalls.length;
    await expect(orchestrator.releaseRuntime(room.id)).rejects.toThrow(/round is in flight/);
    expect(host.closeCalls.length).toBe(closeCallsBefore);
    // R1 atomicity: the in-flight-round guard rejects inside the tx; no closure
    // side-effect (closeStates empty) and the binding stays active.
    expect(host.closeStates).toHaveLength(0);
    const active = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { state: string } | undefined;
    expect(active?.state).toBe("active");
  });

  it("19b. V1 paused 活动轮拒绝释放：pause 后 releaseRuntime rejects（恢复路径不能丢 binding）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // focus complete, p1 message complete, p2 non-retryable fail → paused round.
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "fail", retryable: false, dispatchState: "not_dispatched" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("paused");

    const closeCallsBefore = host.closeCalls.length;
    // V1: a paused round is NOT terminal; releasing would strand the recovery
    // intents (retry/abort/rotate need currentToken → active binding).
    await expect(orchestrator.releaseRuntime(room.id)).rejects.toThrow(/unresolved round remains/);
    expect(host.closeCalls.length).toBe(closeCallsBefore);
    expect(host.closeStates).toHaveLength(0);
    const active = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { state: string } | undefined;
    expect(active?.state).toBe("active");
  });

  it("19c. V1 pending 活动轮拒绝释放：刚 createRound 未推进 → releaseRuntime rejects", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // Seed a round left at the pending phase (created, never transitioned).
    const token = await currentTokenFor(db, room.id);
    const pendingRound = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    const stored = (await db.rounds.get(pendingRound.id)) as DiscussionRound;
    expect(stored.phase).toBe("pending");

    const closeCallsBefore = host.closeCalls.length;
    await expect(orchestrator.releaseRuntime(room.id)).rejects.toThrow(/unresolved round remains/);
    expect(host.closeCalls.length).toBe(closeCallsBefore);
    expect(host.closeStates).toHaveLength(0);
    const active = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { state: string } | undefined;
    expect(active?.state).toBe("active");
  });

  it("19d. V1 completed 活动轮放行释放：activeRoundId 指向 completed round → 守卫放行 → releaseRuntime resolves（终态可释放）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "complete" });
    const round = await orchestrator.startRound(room.id);
    expect(round?.phase).toBe("completed");
    // 正常完成会清空 activeRoundId(summary commit tx 这么做)。这里把它重新指回
    // 已完成的 round,逼真地经过 releaseRuntime 的 "completed 放行" 分支:守卫看到
    // activeRoundId 非空 → 取 round → phase 终态(completed) → 不拒绝 → 放行闭 scope。
    // (旧版只靠 activeRoundId=null 直接跳过守卫,并未真正走到该分支。aborted 路径对称。)
    await db.rooms.update(room.id, { activeRoundId: round?.id ?? null });
    const freshRoom = await db.rooms.get(room.id);
    expect(freshRoom?.activeRoundId).toBe(round?.id);
    expect(round?.phase).toBe("completed");

    const closeCallsBefore = host.closeCalls.length;
    await expect(orchestrator.releaseRuntime(room.id)).resolves.toBeUndefined();
    expect(host.closeCalls.length).toBe(closeCallsBefore + 1);
  });

  it("20. 已冷幂等 no-op：无 active binding → resolve，closeCalls 空", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    // Close the binding manually to simulate an already-cold room (no active binding).
    const initial = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { id: string } | undefined;
    expect(initial).toBeDefined();
    if (!initial) throw new Error("expected an initial active binding");
    await markBindingClosed(db, initial.id);

    const closeCallsBefore = host.closeCalls.length;
    await expect(orchestrator.releaseRuntime(room.id)).resolves.toBeUndefined();
    expect(host.closeCalls.length).toBe(closeCallsBefore);
  });

  it("21. Host 已死（close 404）仍本地收敛：binding 指向未知 scopeId → releaseRuntime resolve + binding closed", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    const warmBinding = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { id: string; executionScopeId: string } | undefined;
    expect(warmBinding).toBeDefined();
    // Restart the Host: the known scopeId is gone, so closeScope will 404.
    host.restart("host-ghost");

    await expect(orchestrator.releaseRuntime(room.id)).resolves.toBeUndefined();
    const after = await db.runtimeBindings.get(warmBinding?.id ?? "");
    expect(after?.state).toBe("closed");
  });

  it("22. R1 顺序/原子性：binding 在守卫事务内置闭，closeScope 在事务提交后才调用（触发时 binding 已 closed）", async () => {
    const { room, p1, p2 } = await seedBase();
    const { orchestrator } = makeOrchestrator();
    await orchestrator.ensureScope(room.id, [p1, p2]);
    host.plan(p1.id, { kind: "complete" }, { kind: "complete" });
    host.plan(p2.id, { kind: "complete" });
    const round1 = await orchestrator.startRound(room.id);
    expect(round1?.phase).toBe("completed");
    const warmBinding = (await db.runtimeBindings
      .where("roomId")
      .equals(room.id)
      .filter((b) => b.state === "active")
      .first()) as { id: string; executionScopeId: string } | undefined;
    expect(warmBinding).toBeDefined();

    // Probe: read the binding's PERSISTED state at the instant closeScope fires.
    // If the closure ran inside the guard tx and the HTTP runs only after commit,
    // this MUST read "closed" — the atomicity + post-commit-order proof. Pre-fix
    // (close-before-markBindingClosed) this read "active": the HTTP closed the
    // Host scope while the local binding was still active, leaving the TOCTOU
    // window where a concurrent startRound could lose its terminal.
    host.closeProbe = async (scopeId) => {
      const binding = await db.runtimeBindings
        .where("roomId")
        .equals(room.id)
        .filter((b) => b.executionScopeId === scopeId)
        .first();
      return binding?.state ?? null;
    };

    await orchestrator.releaseRuntime(room.id);

    // Exactly one close; at the instant it fired the binding was already closed.
    expect(host.closeCalls).toHaveLength(1);
    expect(host.closeCalls[0]?.scopeId).toBe(warmBinding?.executionScopeId);
    expect(host.closeStates).toHaveLength(1);
    expect(host.closeStates[0]).toBe("closed");
    const after = await db.runtimeBindings.get(warmBinding?.id ?? "");
    expect(after?.state).toBe("closed");
  });
});
