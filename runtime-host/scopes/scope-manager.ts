import { randomUUID } from "node:crypto";
import { QUOTAS, TIMEOUTS } from "@shared/runtime/contracts";
import type {
  AckDisposition,
  ParticipantRuntimeState,
  ScopeState,
} from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";
import type {
  ContextSnapshot,
  CreateScopeRequest,
  CreateScopeResponse,
  ParticipantSpec,
  ParticipantStatus,
  ResolvedBinding,
  ScopeStatus,
} from "@shared/runtime/schemas";
import type { ParticipantDriver } from "../drivers/types";
import type { ExecutionRegistry } from "../executions/execution-registry";
import type { InstallationRegistry } from "../installations/registry";
import type { Logger } from "../logging";
import { buildBinding, resolveStatic } from "../profiles/resolver";
import { type HttpError, httpError } from "../server";
import { type SessionReconciler, createSessionReconciler } from "./session-reconciler";

/**
 * Scope manager: owns Execution Scopes, per-Participant driver processes,
 * controller fencing (controllerId + monotonically increasing leaseEpoch),
 * Host quotas and the Session Reconciler. Prewarm happens in parallel at
 * scope creation; any Participant failure is reported per Participant and
 * never silently skipped.
 */

interface ParticipantEntry {
  spec: ParticipantSpec;
  driver: ParticipantDriver;
  binding: ResolvedBinding | null;
  runtime: ParticipantRuntimeState;
  readiness: ParticipantStatus["readiness"];
  busyExecutionId: string | null;
}

interface Scope {
  scopeId: string;
  scopeRequestId: string;
  state: ScopeState;
  controllerId: string;
  leaseEpoch: number;
  participants: Map<string, ParticipantEntry>;
  createdAt: string;
  activatedAt: string | null;
  creatingTimer: NodeJS.Timeout | null;
}

export interface ScopeManagerDeps {
  installations: InstallationRegistry;
  executions: ExecutionRegistry;
  reconciler: SessionReconciler;
  /** Composed per-driver factories keyed by driverId. */
  driverFactories: Record<string, (participantId: string) => ParticipantDriver>;
  logger: Logger;
  hostInstanceId: string;
  /** Injectable for tests; defaults to TIMEOUTS.creatingScopeTtlMs. */
  creatingScopeTtlMs?: number;
  now?: () => number;
}

export interface ExecuteOutcome {
  executionId: string;
  state: "running" | "completed" | "failed" | "interrupted";
  lastSeq: number;
}

function err(status: number, error: RuntimeError): HttpError {
  return httpError(status, error);
}

export function createScopeManager(deps: ScopeManagerDeps) {
  const { installations, executions, reconciler, logger, hostInstanceId } = deps;
  const scopes = new Map<string, Scope>();
  const scopeRequestIndex = new Map<string, string>();
  const scopeCreateTimestamps: number[] = [];
  const now = deps.now ?? Date.now;

  function checkScopeCreateRate(): void {
    const cutoff = now() - 60_000;
    while (scopeCreateTimestamps.length > 0 && (scopeCreateTimestamps[0] as number) < cutoff) {
      scopeCreateTimestamps.shift();
    }
    if (scopeCreateTimestamps.length >= QUOTAS.scopeCreatesPerMinute) {
      throw err(
        429,
        makeError("RATE_LIMITED", "quota", "Scope create rate exceeded (10/min).", {
          retryable: true,
          retryAfterMs: 60_000,
        }),
      );
    }
  }

  function activeScopeCount(): number {
    let count = 0;
    for (const scope of scopes.values()) {
      if (scope.state === "creating" || scope.state === "active") count += 1;
    }
    return count;
  }

  function liveDriverProcessCount(): number {
    let count = 0;
    for (const scope of scopes.values()) {
      for (const entry of scope.participants.values()) {
        if (
          entry.runtime === "ready" ||
          entry.runtime === "busy" ||
          entry.runtime === "prewarming"
        ) {
          count += 1;
        }
      }
    }
    return count;
  }

  function toStatus(scope: Scope): ScopeStatus {
    const participants: ParticipantStatus[] = [...scope.participants.values()].map((entry) => ({
      participantId: entry.spec.participantId,
      runtime: entry.runtime,
      binding: entry.binding,
      readiness: entry.readiness,
    }));
    return {
      scopeId: scope.scopeId,
      state: scope.state,
      hostInstanceId,
      leaseEpoch: scope.leaseEpoch,
      participants,
    };
  }

  function fenced(scope: Scope, controllerId: string, leaseEpoch: number): void {
    if (scope.state === "closed" || scope.state === "closing") {
      throw err(409, makeError("SCOPE_CLOSED", "close", "Scope is closing or closed."));
    }
    if (scope.controllerId !== controllerId || scope.leaseEpoch !== leaseEpoch) {
      throw err(
        409,
        makeError("STALE_CONTROLLER", "security", "controllerId/leaseEpoch is not current.", {
          retryable: false,
        }),
      );
    }
  }

  function scheduleCreatingSweep(scope: Scope) {
    const ttl = deps.creatingScopeTtlMs ?? TIMEOUTS.creatingScopeTtlMs;
    scope.creatingTimer = setTimeout(() => {
      if (scope.state === "creating") {
        logger.warn("scope.creating_ttl_expired", { scopeId: scope.scopeId });
        void closeScopeInternal(scope, "creating-ttl");
      }
    }, ttl);
    scope.creatingTimer.unref?.();
  }

  async function prewarmParticipant(scope: Scope, entry: ParticipantEntry): Promise<void> {
    entry.runtime = "prewarming";
    const spec = entry.spec;
    try {
      const staticResolution = resolveStatic(spec.profile, spec.modelId, installations);
      if (!staticResolution.installation || staticResolution.readiness.state !== "ready") {
        entry.runtime = "failed";
        entry.readiness = staticResolution.readiness;
        return;
      }
      // Re-validate fingerprint immediately before spawn (U2 boundary).
      const installation = installations.assertExecutable(
        staticResolution.installation.installationId,
      );
      const prewarm = await entry.driver.prewarm({
        participantId: spec.participantId,
        spec,
        installation,
      });
      const resolved = buildBinding(spec, installation, prewarm);
      entry.binding = resolved.binding;
      entry.readiness = resolved.readiness;
      entry.runtime = resolved.binding ? "ready" : "failed";
    } catch (error) {
      entry.runtime = "failed";
      const runtimeCode = (error as { runtimeCode?: string }).runtimeCode;
      entry.readiness = {
        state:
          runtimeCode === "AUTH_REQUIRED" || runtimeCode === "INCOMPATIBLE_DRIVER"
            ? "runtime_unavailable"
            : runtimeCode === "MODEL_UNAVAILABLE"
              ? "model_unavailable"
              : "runtime_unavailable",
        detail: error instanceof Error ? error.message.slice(0, 256) : "prewarm failed",
      };
      logger.warn("scope.prewarm_failed", {
        scopeId: scope.scopeId,
        participantId: spec.participantId,
        code: runtimeCode ?? "UNKNOWN",
      });
    }
  }

  async function createScope(request: CreateScopeRequest): Promise<CreateScopeResponse> {
    const existingScopeId = scopeRequestIndex.get(request.scopeRequestId);
    if (existingScopeId) {
      const existing = scopes.get(existingScopeId);
      if (existing && existing.state !== "closed") {
        return {
          scopeId: existing.scopeId,
          controllerId: existing.controllerId,
          leaseEpoch: existing.leaseEpoch,
          scope: toStatus(existing),
        };
      }
    }

    checkScopeCreateRate();
    if (activeScopeCount() >= QUOTAS.maxActiveScopes) {
      throw err(429, makeError("RESOURCE_LIMIT", "quota", "Maximum active scopes reached."));
    }
    if (request.participants.length > QUOTAS.maxParticipantsPerScope) {
      throw err(429, makeError("RESOURCE_LIMIT", "quota", "Too many participants in one scope."));
    }
    if (liveDriverProcessCount() + request.participants.length > QUOTAS.maxDriverProcesses) {
      throw err(429, makeError("RESOURCE_LIMIT", "quota", "Global driver process quota reached."));
    }

    const scopeId = `scope-${randomUUID()}`;
    const controllerId = `ctrl-${randomUUID()}`;
    const scope: Scope = {
      scopeId,
      scopeRequestId: request.scopeRequestId,
      state: "creating",
      controllerId,
      leaseEpoch: 1,
      participants: new Map(),
      createdAt: new Date().toISOString(),
      activatedAt: null,
      creatingTimer: null,
    };
    for (const spec of request.participants) {
      const factory = deps.driverFactories[spec.profile.driverId];
      if (!factory) {
        throw err(400, makeError("PROFILE_INVALID", "prewarm", "unknown driverId in profile"));
      }
      const driver = factory(spec.participantId);
      scope.participants.set(spec.participantId, {
        spec,
        driver,
        binding: null,
        runtime: "cold",
        readiness: null,
        busyExecutionId: null,
      });
    }
    scopes.set(scopeId, scope);
    scopeRequestIndex.set(request.scopeRequestId, scopeId);
    scopeCreateTimestamps.push(now());
    scheduleCreatingSweep(scope);

    // Parallel prewarm; failures are per-Participant, never silently skipped.
    await Promise.all(
      [...scope.participants.values()].map((entry) => prewarmParticipant(scope, entry)),
    );

    return { scopeId, controllerId, leaseEpoch: scope.leaseEpoch, scope: toStatus(scope) };
  }

  function getScope(scopeId: string): Scope {
    const scope = scopes.get(scopeId);
    if (!scope) {
      throw err(404, makeError("SCOPE_NOT_FOUND", "dispatch", "Unknown scope."));
    }
    return scope;
  }

  function activateScope(scopeId: string, controllerId: string, leaseEpoch: number): ScopeStatus {
    const scope = getScope(scopeId);
    fenced(scope, controllerId, leaseEpoch);
    if (scope.state === "creating") {
      scope.state = "active";
      scope.activatedAt = new Date().toISOString();
      if (scope.creatingTimer) clearTimeout(scope.creatingTimer);
      scope.creatingTimer = null;
    }
    return toStatus(scope);
  }

  function takeover(scopeId: string, newControllerId: string) {
    const scope = getScope(scopeId);
    if (scope.state === "closed" || scope.state === "closing") {
      throw err(409, makeError("SCOPE_CLOSED", "close", "Scope is closing or closed."));
    }
    scope.controllerId = newControllerId;
    scope.leaseEpoch += 1;
    logger.info("scope.controller_takeover", { scopeId, leaseEpoch: scope.leaseEpoch });
    return { scopeId, controllerId: scope.controllerId, leaseEpoch: scope.leaseEpoch };
  }

  async function execute(
    scopeId: string,
    request: {
      controllerId: string;
      leaseEpoch: number;
      executionId: string;
      participantId: string;
      snapshot: ContextSnapshot;
    },
  ): Promise<ExecuteOutcome> {
    const scope = getScope(scopeId);
    fenced(scope, request.controllerId, request.leaseEpoch);
    if (scope.state !== "active") {
      throw err(409, makeError("SCOPE_CLOSED", "dispatch", "Scope is not active."));
    }
    const entry = scope.participants.get(request.participantId);
    if (!entry) {
      throw err(404, makeError("PARTICIPANT_NOT_FOUND", "dispatch", "Unknown participant."));
    }
    if (entry.runtime !== "ready") {
      throw err(
        409,
        makeError("PARTICIPANT_BUSY", "dispatch", `participant is ${entry.runtime}, not ready.`),
      );
    }
    if (entry.busyExecutionId) {
      throw err(
        409,
        makeError("PARTICIPANT_BUSY", "dispatch", "participant has a running execution."),
      );
    }
    if (executions.runningCount() >= QUOTAS.maxConcurrentExecutions) {
      throw err(429, makeError("RESOURCE_LIMIT", "quota", "Concurrent execution quota reached."));
    }

    const { record, created } = executions.begin(
      request.executionId,
      request.participantId,
      scopeId,
    );
    if (!created) {
      // Same executionId: reconnect semantics only — never re-dispatch.
      return { executionId: record.executionId, state: record.state, lastSeq: record.lastSeq };
    }

    const binding = entry.binding;
    if (!binding) {
      executions.emit(request.executionId, {
        type: "failed",
        error: makeError("PROFILE_INVALID", "prewarm", "participant has no resolved binding"),
        dispatchState: "not_dispatched",
        toolState: "none",
        retryable: false,
      });
      return { executionId: request.executionId, state: "failed", lastSeq: 1 };
    }

    const outcome = reconciler.reconcile(
      request.participantId,
      request.snapshot,
      entry.driver.sessionEpoch,
      entry.driver.contextWindowTokens(),
    );
    if (outcome.kind === "needs_rebase") {
      executions.emit(request.executionId, {
        type: "started",
        requestedModel: binding.requestedModel,
      });
      executions.emit(request.executionId, {
        type: "failed",
        error: makeError("NEEDS_REBASE", "dispatch", `session reconciliation: ${outcome.reason}`, {
          executionId: request.executionId,
          participantId: request.participantId,
          driverId: binding.driverId,
        }),
        dispatchState: "not_dispatched",
        toolState: "none",
        retryable: false,
      });
      const recordAfter = executions.get(request.executionId);
      return {
        executionId: request.executionId,
        state: "failed",
        lastSeq: recordAfter?.lastSeq ?? 2,
      };
    }

    entry.busyExecutionId = request.executionId;
    entry.runtime = "busy";
    const emit = (proto: Parameters<ExecutionRegistry["emit"]>[1]) => {
      const event = executions.emit(request.executionId, proto);
      if (event && event.type === "completed") {
        reconciler.recordApplied(
          request.participantId,
          request.snapshot,
          request.executionId,
          entry.driver.sessionEpoch,
          event.usage,
        );
      }
    };

    // Fire-and-follow: the HTTP response returns immediately; the terminal
    // lands in the event stream. The driver emits started itself.
    void entry.driver
      .execute(
        {
          executionId: request.executionId,
          prompt: outcome.prompt,
          modelId: binding.canonicalModelId,
          coldStart: outcome.basis === "full",
        },
        emit,
      )
      .catch((error: unknown) => {
        executions.emit(request.executionId, {
          type: "failed",
          error: makeError(
            "INTERNAL",
            "dispatch",
            error instanceof Error ? error.message.slice(0, 256) : "execute failed",
            { executionId: request.executionId, participantId: request.participantId },
          ),
          dispatchState: "unknown",
          toolState: "unknown",
          retryable: false,
        });
      })
      .finally(() => {
        entry.busyExecutionId = null;
        if (entry.runtime === "busy") entry.runtime = "ready";
      });

    return { executionId: request.executionId, state: "running", lastSeq: 0 };
  }

  async function cancel(
    scopeId: string,
    executionId: string,
    controller: { controllerId: string; leaseEpoch: number },
  ): Promise<void> {
    const scope = getScope(scopeId);
    fenced(scope, controller.controllerId, controller.leaseEpoch);
    const record = executions.get(executionId);
    if (!record) {
      throw err(404, makeError("EXECUTION_NOT_FOUND", "cancel", "Unknown execution."));
    }
    const entry = scope.participants.get(record.participantId);
    await entry?.driver.cancel(executionId);
  }

  function ack(
    scopeId: string,
    executionId: string,
    finalSeq: number,
    disposition: AckDisposition,
    controller: { controllerId: string; leaseEpoch: number },
  ) {
    const scope = getScope(scopeId);
    fenced(scope, controller.controllerId, controller.leaseEpoch);
    const result = executions.ack(executionId, finalSeq, disposition);
    if (result.outcome === "conflict") {
      throw err(409, result.error ?? makeError("EXECUTION_CONFLICT", "commit", "ACK conflict."));
    }
    return { executionId, ackState: result.outcome, disposition: result.disposition };
  }

  async function closeScopeInternal(scope: Scope, reason: string): Promise<void> {
    if (scope.state === "closed" || scope.state === "closing") return;
    scope.state = "closing";
    logger.info("scope.closing", { scopeId: scope.scopeId, reason });
    if (scope.creatingTimer) clearTimeout(scope.creatingTimer);
    await Promise.all(
      [...scope.participants.values()].map(async (entry) => {
        try {
          await entry.driver.close();
        } catch {
          // best effort; watchdog reaps leftovers
        }
        entry.runtime = "cold";
        // The Execution Session ends with the Scope: drop the reconciler
        // record so a future Scope with the same Participant starts cold.
        reconciler.invalidate(entry.spec.participantId);
      }),
    );
    executions.releaseScope(scope.scopeId);
    scope.state = "closed";
    scopeRequestIndex.delete(scope.scopeRequestId);
  }

  async function closeScope(
    scopeId: string,
    controller: { controllerId: string; leaseEpoch: number },
  ): Promise<{ scopeId: string; state: ScopeState }> {
    const scope = getScope(scopeId);
    fenced(scope, controller.controllerId, controller.leaseEpoch);
    await closeScopeInternal(scope, "controller-close");
    return { scopeId, state: "closed" };
  }

  async function closeAll(reason: string): Promise<void> {
    await Promise.all([...scopes.values()].map((scope) => closeScopeInternal(scope, reason)));
  }

  return {
    createScope,
    getScopeStatus(scopeId: string): ScopeStatus {
      return toStatus(getScope(scopeId));
    },
    activateScope,
    takeover,
    execute,
    cancel,
    ack,
    closeScope,
    closeAll,
    counts() {
      return {
        activeScopes: activeScopeCount(),
        liveDriverProcesses: liveDriverProcessCount(),
        runningExecutions: executions.runningCount(),
        eventConnections: executions.eventConnectionCount(),
      };
    },
    _scopes: scopes,
  };
}

export type ScopeManager = ReturnType<typeof createScopeManager>;

export { createSessionReconciler };
