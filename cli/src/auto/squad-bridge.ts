import { randomUUID } from "node:crypto";
import {
  type FrozenIntegrateIdentity,
  SQUAD_BRIDGE_CONTRACT_VERSION,
  type SquadBridgeEventKind,
  type SquadBridgeFailureCode,
  type SquadJournalRefs,
  assertSquadBridgeVersion,
  canRequestPublish,
  inheritRepairHistory,
  isTrustedIntegrateReceipt,
  receiptContainsSecret,
  squadJournalRefsSchema,
} from "@shared/runtime/squad-bridge-contract";

export interface SquadBridgeStartRequest {
  requestedVersion: string;
  packageFields: { ancestorDir?: string };
  bridgeAncestorDir?: string | null;
  history?: unknown;
}

export type SquadBridgeStartResult =
  | { ok: true; taskId: string }
  | { ok: false; code: SquadBridgeFailureCode };

export interface SquadBridgeStatus {
  taskId: string;
  event: {
    kind: SquadBridgeEventKind;
    journal: SquadJournalRefs;
  };
}

export type SquadBridgePublishResult =
  | {
      ok: true;
      receipt: {
        action: "push-remote";
        passed: true;
        candidateSha: string;
        expectedOldSha: string;
        repo: string;
        ref: string;
      };
    }
  | { ok: false; code: SquadBridgeFailureCode };

export interface SquadBridge {
  start(request: SquadBridgeStartRequest): SquadBridgeStartResult;
  resume(request: { taskId: string }): SquadBridgeStatus;
  stop(request: { taskId: string }): { kind: "stopped" };
  status(request: { taskId: string }): SquadBridgeStatus;
  requestPublish(request: {
    taskId: string;
    identity: FrozenIntegrateIdentity;
  }): SquadBridgePublishResult;
}

export interface FakeSquadBridgeOptions {
  version: string | null;
  journal?: SquadJournalRefs;
  eventKind?: Exclude<SquadBridgeEventKind, "stopped">;
  observeClosed?: boolean;
  receiptOverride?: unknown;
  history?: unknown;
  bridgeAncestorDir?: string | null;
}

export class FakeSquadBridge implements SquadBridge {
  private readonly tasks = new Map<string, SquadJournalRefs>();
  private readonly stopped = new Set<string>();

  constructor(private readonly options: FakeSquadBridgeOptions) {}

  start(request: SquadBridgeStartRequest): SquadBridgeStartResult {
    const version = assertSquadBridgeVersion({
      requested: request.requestedVersion,
      actual: this.options.version,
    });
    if (!version.ok) return version;
    const history = inheritRepairHistory({
      packageFields: request.packageFields,
      bridgeAncestorDir:
        request.bridgeAncestorDir ?? this.options.bridgeAncestorDir ?? "/trusted/task",
      history: request.history ??
        this.options.history ?? {
          kind: "squad-repair-history",
          version: 1,
          source_hash: "b".repeat(64),
          project: "github.com/acme/repo",
        },
    });
    if (!history.ok) return history;
    const journal = squadJournalRefsSchema.parse({
      ...(this.options.journal ?? {
        candidateSha: "a".repeat(40),
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        gatePolicyHash: "gate-policy-1",
      }),
      ...(this.options.observeClosed === undefined
        ? {}
        : { observeClosed: this.options.observeClosed }),
    });
    const taskId = `fake-task-${randomUUID()}`;
    this.tasks.set(taskId, journal);
    return { ok: true, taskId };
  }

  resume(request: { taskId: string }): SquadBridgeStatus {
    return this.status(request);
  }

  stop(request: { taskId: string }): { kind: "stopped" } {
    if (!this.tasks.has(request.taskId)) {
      throw new Error(`unknown fake squad task ${request.taskId}`);
    }
    this.stopped.add(request.taskId);
    return { kind: "stopped" };
  }

  status(request: { taskId: string }): SquadBridgeStatus {
    const journal = this.tasks.get(request.taskId);
    if (!journal) throw new Error(`unknown fake squad task ${request.taskId}`);
    const kind: SquadBridgeEventKind = this.stopped.has(request.taskId)
      ? "stopped"
      : (this.options.eventKind ?? "candidate_ready");
    return {
      taskId: request.taskId,
      event: { kind, journal },
    };
  }

  requestPublish(request: {
    taskId: string;
    identity: FrozenIntegrateIdentity;
  }): SquadBridgePublishResult {
    const snapshot = this.status(request);
    if (
      !canRequestPublish(snapshot.event) ||
      snapshot.event.journal.candidateSha.toLowerCase() !==
        request.identity.candidateSha.toLowerCase()
    ) {
      return { ok: false, code: "JOURNAL_GATES_INCOMPLETE" };
    }
    if (this.options.receiptOverride !== undefined) {
      if (
        receiptContainsSecret(this.options.receiptOverride) ||
        !isTrustedIntegrateReceipt(this.options.receiptOverride)
      ) {
        return { ok: false, code: "UNTRUSTED_RECEIPT" };
      }
    }
    return {
      ok: true,
      receipt: {
        action: "push-remote",
        passed: true,
        candidateSha: request.identity.candidateSha,
        expectedOldSha: request.identity.expectedOldSha,
        repo: request.identity.repo,
        ref: request.identity.sourceBranch,
      },
    };
  }
}

export const DEFAULT_SQUAD_BRIDGE_VERSION = SQUAD_BRIDGE_CONTRACT_VERSION;
