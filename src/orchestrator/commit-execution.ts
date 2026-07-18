import type { ControllerToken } from "@/lib/discussion-transactions";
import {
  commitFocusMessage,
  commitModelMessage,
  commitReport,
  commitSummary,
  discardExecution,
  markAckExpired,
  markAcknowledged,
  markExecutionSucceededUncommitted,
} from "@/lib/discussion-transactions";
import type { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { RoundPhase } from "@/models/discussion/entities";
import type {
  ModelExecution,
  ModelExecutionError,
  RuntimeOutcome,
} from "@/models/discussion/model-execution";
import type { RuntimeClient } from "@/runtime/client";
import { RuntimeClientError } from "@/runtime/client";
import type { CompletedEvent } from "@shared/runtime/events";

/**
 * persist → ACK pipeline (U5): only the completed event's full normalized
 * output may enter a commit transaction; deltas/snapshots stay preview-only.
 * The Dexie transaction ALWAYS precedes its ACK — persist first, ACK second.
 * Model mismatch, toolState unknown, and empty output are discarded with a
 * structured outcome and never retried automatically.
 */

export interface CommitPipelineDeps {
  db: CouncilKitRuntimeDB;
  client: RuntimeClient;
  scopeId: string;
  token: ControllerToken;
  /** health().hostInstanceId of the Host this page is talking to. */
  currentHostInstanceId: string;
}

export type CompletedHandling =
  | { kind: "committed"; entityId: string; roundPhase: RoundPhase }
  | { kind: "discarded"; runtimeOutcome: RuntimeOutcome }
  | { kind: "replayed"; entityId: string };

function structuredError(code: string, message: string): ModelExecutionError {
  return { code, phase: "stream", message, retryable: false };
}

/** Classify a completed terminal: commit-worthy, or a structured discard. */
function classifyCompleted(
  execution: ModelExecution,
  event: CompletedEvent,
): { kind: "commit" } | { kind: "discard"; outcome: RuntimeOutcome; error: ModelExecutionError } {
  if (event.effectiveModel === null || event.modelVerdict !== "match") {
    return {
      kind: "discard",
      outcome: "model_mismatch",
      error: structuredError(
        "MODEL_MISMATCH",
        `requested ${execution.requestedModel}, effective ${event.effectiveModel ?? "unknown"}, verdict ${event.modelVerdict}`,
      ),
    };
  }
  if (event.toolState === "unknown") {
    return {
      kind: "discard",
      outcome: "tool_state_unknown",
      error: structuredError(
        "TOOL_STATE_UNKNOWN",
        "tool activity can no longer be proven; preview dropped",
      ),
    };
  }
  if (event.output.trim().length === 0) {
    return {
      kind: "discard",
      outcome: "empty_output",
      error: structuredError("EMPTY_OUTPUT", "completed with empty normalized output"),
    };
  }
  return { kind: "commit" };
}

/** Send the ACK only after its Dexie transaction succeeded; failures leave
 * ackState pending for the recovery scan. */
async function ackAfterPersist(
  deps: CommitPipelineDeps,
  execution: ModelExecution,
  disposition: "committed" | "discarded",
): Promise<void> {
  const finalSeq = execution.finalEventSeq;
  if (finalSeq === null) return;
  if (execution.hostInstanceId !== deps.currentHostInstanceId) {
    // Host restarted since dispatch: the terminal is gone — converge, never
    // re-invoke the model.
    await markAckExpired(deps.db, execution.executionId);
    return;
  }
  try {
    const response = await deps.client.ack(deps.scopeId, execution.executionId, {
      controllerId: deps.token.controllerId,
      leaseEpoch: deps.token.leaseEpoch,
      finalSeq,
      disposition,
    });
    if (response.ackState === "acknowledged") {
      await markAcknowledged(deps.db, execution.executionId);
    } else if (response.ackState === "expired") {
      await markAckExpired(deps.db, execution.executionId);
    }
    // "pending": the Host kept the tombstone; the recovery scan retries.
  } catch (error) {
    if (error instanceof RuntimeClientError && error.status === 404) {
      await markAckExpired(deps.db, execution.executionId);
      return;
    }
    // Network/5xx: leave pending; never re-persist or re-dispatch.
  }
}

/**
 * Handle a Host `completed` terminal: commit the output (or discard it with
 * a structured outcome), then send the matching ACK. Idempotent end to end:
 * a replayed terminal returns the existing commit and re-ACKs.
 */
export async function handleCompletedExecution(
  deps: CommitPipelineDeps,
  executionId: string,
  event: CompletedEvent,
): Promise<CompletedHandling> {
  const current = await deps.db.modelExecutions.get(executionId);
  if (!current) {
    throw new Error(`handleCompletedExecution: unknown execution ${executionId}`);
  }
  if (current.state === "running") {
    await markExecutionSucceededUncommitted(deps.db, {
      executionId,
      effectiveModel: event.effectiveModel,
      usage: event.usage,
      finalEventSeq: event.finalSeq,
      dispatchState: event.dispatchState,
      toolState: event.toolState,
    });
  }
  const execution = (await deps.db.modelExecutions.get(executionId)) as ModelExecution;

  const verdict = classifyCompleted(execution, event);
  if (verdict.kind === "discard") {
    const discarded = await discardExecution(deps.db, {
      executionId,
      token: deps.token,
      outcome: verdict.outcome,
      finalEventSeq: event.finalSeq,
      error: verdict.error,
    });
    if (discarded.outcome !== "replayed") {
      await ackAfterPersist(deps, execution, "discarded");
      return { kind: "discarded", runtimeOutcome: verdict.outcome };
    }
    await ackAfterPersist(deps, execution, "discarded");
    return { kind: "replayed", entityId: execution.committedEntityId ?? executionId };
  }

  const commitInput = {
    executionId,
    token: deps.token,
    content: event.output,
    effectiveModel: event.effectiveModel,
    usage: event.usage,
    finalEventSeq: event.finalSeq,
    dispatchState: event.dispatchState,
    toolState: event.toolState,
  };
  // Four-way commit dispatch (S2): focus commits a Message, report commits a
  // DecisionReport — both flow through the same persist→ACK pipeline. The wire
  // instruction.kind stays "message"/"summary"; mode/category live in the
  // instruction text (ADR-0010), so no shared-schema change is needed here.
  const result =
    execution.resultKind === "summary"
      ? await commitSummary(deps.db, commitInput)
      : execution.resultKind === "focus"
        ? await commitFocusMessage(deps.db, commitInput)
        : execution.resultKind === "report"
          ? await commitReport(deps.db, commitInput)
          : await commitModelMessage(deps.db, commitInput);

  if (result.outcome === "discarded") {
    // Commit-time staleness was persisted as stale_context + paused inside
    // the same transaction; the body never landed.
    await ackAfterPersist(deps, execution, "discarded");
    return { kind: "discarded", runtimeOutcome: result.runtimeOutcome };
  }
  await ackAfterPersist(deps, execution, "committed");
  if (result.outcome === "replayed") {
    return { kind: "replayed", entityId: result.entityId };
  }
  return { kind: "committed", entityId: result.entityId, roundPhase: result.roundPhase };
}
