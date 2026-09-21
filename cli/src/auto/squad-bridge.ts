import { createHash, randomUUID } from "node:crypto";
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
import type { OfficialGatePolicyFreeze } from "@shared/runtime/squad-gate-policy";
import {
  SUPERVISED_REVIEW_VERIFY_POLICY,
  hashOfficialGatePolicyFile,
} from "@shared/runtime/squad-gate-policy";

export interface SquadBridgeDelivery {
  grantHash: string;
  repo: string;
  sourceBranch: string;
  sourceSha: string;
  expectedOldSha: string;
  remote: string;
  originUrl?: string;
  pushUrl?: string;
  parentRunId?: string;
  newRepairChain?: boolean;
  previousTaskId?: string;
  previousTaskDir?: string;
  historyExportPath?: string;
  historyExportHash?: string;
}

export interface SquadBridgeStartRequest {
  requestedVersion: string;
  packageFields: { ancestorDir?: string };
  bridgeAncestorDir?: string | null;
  history?: unknown;
  handoffPath?: string;
  baseSha?: string;
  delivery?: SquadBridgeDelivery;
}

export type SquadBridgeStartResult =
  | { ok: true; taskId: string; taskDir?: string }
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
  | {
      ok: false;
      code: SquadBridgeFailureCode;
      stage?: string;
      exitCode?: number | null;
      message?: string;
    };

export interface SquadBridge {
  start(request: SquadBridgeStartRequest): SquadBridgeStartResult;
  resume(request: { taskId: string }): SquadBridgeStatus | Promise<SquadBridgeStatus>;
  stop(request: { taskId: string }): { kind: "stopped" };
  status(request: { taskId: string }): SquadBridgeStatus;
  requestPublish(request: {
    taskId: string;
    identity: FrozenIntegrateIdentity;
  }): SquadBridgePublishResult | Promise<SquadBridgePublishResult>;
  prepare?(input: {
    taskId: string;
    baseSha: string;
    packagePath: string;
    delivery?: SquadBridgeDelivery;
  }): Promise<void>;
  exportHistory?(request: {
    taskId: string;
    allowedOrigins: Array<{ journalTaskId: string; taskDir: string }>;
    projectId: string;
    repairChainId: string;
  }):
    | {
        envelope: unknown;
        hash: string;
        historyPath: string;
      }
    | Promise<{
        envelope: unknown;
        hash: string;
        historyPath: string;
      }>;
  writerPids?(): number[];
  freezeOfficialGatePolicy?(request: {
    taskId: string;
  }):
    | { ok: true; freeze: OfficialGatePolicyFreeze }
    | { ok: false; reason: string }
    | Promise<{ ok: true; freeze: OfficialGatePolicyFreeze } | { ok: false; reason: string }>;
  readOfficialGatePolicy?(request: { taskId: string }): OfficialGatePolicyFreeze | null;
}

export interface FakeSquadBridgeOptions {
  version: string | null;
  journal?: SquadJournalRefs;
  eventKind?: Exclude<SquadBridgeEventKind, "stopped">;
  observeClosed?: boolean;
  receiptOverride?: unknown;
  history?: unknown;
  bridgeAncestorDir?: string | null;
  innerFails?: number;
  runningPolls?: number;
  writerPids?: number[];
  refusePublish?: boolean;
}

export class FakeSquadBridge implements SquadBridge {
  private readonly tasks = new Map<string, SquadJournalRefs>();
  private readonly taskDirs = new Map<string, string>();
  private readonly frozen = new Map<string, OfficialGatePolicyFreeze>();
  private readonly stopped = new Set<string>();
  private readonly statusCounts = new Map<string, number>();
  publishCalls = 0;

  constructor(private readonly options: FakeSquadBridgeOptions) {}

  writerPids(): number[] {
    return this.options.writerPids ?? [];
  }

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
    const provided = this.options.journal?.gatePolicyHash;
    const journal = squadJournalRefsSchema.parse({
      ...(this.options.journal ?? {
        candidateSha: "a".repeat(40),
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        gatePolicyHash: "unknown",
      }),
      gatePolicyHash:
        typeof provided === "string" && /^[a-f0-9]{64}$/.test(provided) ? provided : "unknown",
      ...(this.options.observeClosed === undefined
        ? {}
        : { observeClosed: this.options.observeClosed }),
    });
    const taskId = `fake-task-${randomUUID()}`;
    this.tasks.set(taskId, journal);
    this.taskDirs.set(taskId, request.bridgeAncestorDir ?? "/tmp/fake-squad");
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
    const seen = (this.statusCounts.get(request.taskId) ?? 0) + 1;
    this.statusCounts.set(request.taskId, seen);
    const innerFails = this.options.innerFails ?? 0;
    const runningPolls = this.options.runningPolls ?? 0;
    const gated =
      seen <= innerFails
        ? { ...journal, independentVerify: false, requiredGatesPassed: false }
        : journal;
    const kind: SquadBridgeEventKind = this.stopped.has(request.taskId)
      ? "stopped"
      : seen <= runningPolls
        ? "running"
        : (this.options.eventKind ?? "candidate_ready");
    return {
      taskId: request.taskId,
      event: { kind, journal: gated },
    };
  }

  requestPublish(request: {
    taskId: string;
    identity: FrozenIntegrateIdentity;
  }): SquadBridgePublishResult {
    this.publishCalls += 1;
    if (this.options.refusePublish) {
      return { ok: false, code: "JOURNAL_GATES_INCOMPLETE" };
    }
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

  freezeOfficialGatePolicy(request: {
    taskId: string;
  }): { ok: true; freeze: OfficialGatePolicyFreeze } | { ok: false; reason: string } {
    const existing = this.frozen.get(request.taskId);
    if (existing) return { ok: true, freeze: existing };
    const journal = this.tasks.get(request.taskId);
    if (!journal) return { ok: false, reason: `unknown fake squad task ${request.taskId}` };
    const already = journal.gatePolicyHash;
    const policyHash =
      typeof already === "string" && /^[a-f0-9]{64}$/.test(already)
        ? already
        : createHash("sha256").update(`fake-official-freeze:${request.taskId}`).digest("hex");
    const freeze: OfficialGatePolicyFreeze = {
      policyHash,
      briefHash: createHash("sha256").update(`fake-brief:${request.taskId}`).digest("hex"),
      taskId: request.taskId,
      taskDir: this.taskDirs.get(request.taskId) ?? "/tmp/fake-squad",
      requiredGates: SUPERVISED_REVIEW_VERIFY_POLICY.required_gates,
      independence: SUPERVISED_REVIEW_VERIFY_POLICY.independence,
      source: "squadctl-gate-policy-freeze",
      createdAt: new Date().toISOString(),
      alreadyFrozen: typeof already === "string" && /^[a-f0-9]{64}$/.test(already),
      policyFileHash: hashOfficialGatePolicyFile(SUPERVISED_REVIEW_VERIFY_POLICY),
    };
    this.frozen.set(request.taskId, freeze);
    this.tasks.set(request.taskId, { ...journal, gatePolicyHash: policyHash });
    return { ok: true, freeze };
  }

  readOfficialGatePolicy(request: { taskId: string }): OfficialGatePolicyFreeze | null {
    return this.frozen.get(request.taskId) ?? null;
  }
}

export const DEFAULT_SQUAD_BRIDGE_VERSION = SQUAD_BRIDGE_CONTRACT_VERSION;
