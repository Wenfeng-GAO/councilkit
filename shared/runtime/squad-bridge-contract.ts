import { z } from "zod";
import { FULL_COMMIT_SHA } from "./cli-ledger";

export const SQUAD_BRIDGE_CONTRACT_VERSION = "squad-bridge.v1";

export const SQUAD_BRIDGE_EVENT_KINDS = [
  "candidate_ready",
  "blocked",
  "failed",
  "stopped",
] as const;
export type SquadBridgeEventKind = (typeof SQUAD_BRIDGE_EVENT_KINDS)[number];

export type SquadBridgeFailureCode =
  | "BRIDGE_VERSION_MISSING"
  | "BRIDGE_VERSION_MISMATCH"
  | "ANCESTOR_FROM_PACKAGE"
  | "HISTORY_INVALID"
  | "JOURNAL_GATES_INCOMPLETE"
  | "UNTRUSTED_RECEIPT";

export const squadJournalRefsSchema = z
  .object({
    candidateSha: z.string().regex(FULL_COMMIT_SHA),
    invalidated: z.boolean(),
    independentReview: z.boolean(),
    independentVerify: z.boolean(),
    requiredGatesPassed: z.boolean(),
    gatePolicyHash: z.string().min(1).max(128),
    observeClosed: z.boolean().optional(),
    modelClaimedPassed: z.boolean().optional(),
  })
  .strict();
export type SquadJournalRefs = z.infer<typeof squadJournalRefsSchema>;

export const repairHistoryV1Schema = z
  .object({
    kind: z.literal("squad-repair-history"),
    version: z.literal(1),
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    project: z.string().min(1).max(400),
  })
  .strict();
export type RepairHistoryV1 = z.infer<typeof repairHistoryV1Schema>;

export interface FrozenIntegrateIdentity {
  repo: string;
  sourceBranch: string;
  expectedOldSha: string;
  candidateSha: string;
}

export function assertSquadBridgeVersion(input: {
  requested: string;
  actual: string | null | undefined;
}): { ok: true } | { ok: false; code: SquadBridgeFailureCode } {
  if (input.actual === null || input.actual === undefined || input.actual.length === 0) {
    return { ok: false, code: "BRIDGE_VERSION_MISSING" };
  }
  if (input.actual !== input.requested) {
    return { ok: false, code: "BRIDGE_VERSION_MISMATCH" };
  }
  return { ok: true };
}

export function isPublishableCandidate(refs: SquadJournalRefs): boolean {
  return (
    !refs.invalidated &&
    refs.independentReview &&
    refs.independentVerify &&
    refs.requiredGatesPassed &&
    FULL_COMMIT_SHA.test(refs.candidateSha) &&
    refs.gatePolicyHash.length > 0
  );
}

export function canRequestPublish(event: {
  kind: string;
  journal: SquadJournalRefs;
}): boolean {
  return event.kind === "candidate_ready" && isPublishableCandidate(event.journal);
}

export function receiptContainsSecret(receipt: unknown): boolean {
  const text = JSON.stringify(receipt ?? {});
  return /GH_TOKEN|GITHUB_TOKEN|GIT_ASKPASS|ANTCODE_TOKEN|ghp_|gho_|github_pat_|BEGIN [A-Z ]+PRIVATE KEY/i.test(
    text,
  );
}

export function isTrustedIntegrateReceipt(receipt: unknown): boolean {
  if (receiptContainsSecret(receipt)) return false;
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const row = receipt as Record<string, unknown>;
  if (row.action !== "check-remote" && row.action !== "push-remote") return false;
  return row.passed === true;
}

export function inheritRepairHistory(input: {
  packageFields: { ancestorDir?: string };
  bridgeAncestorDir: string | null;
  history: unknown;
}):
  | { ok: true; history: RepairHistoryV1 }
  | {
      ok: false;
      code: Extract<SquadBridgeFailureCode, "ANCESTOR_FROM_PACKAGE" | "HISTORY_INVALID">;
    } {
  if (input.packageFields.ancestorDir !== undefined && input.packageFields.ancestorDir.length > 0) {
    return { ok: false, code: "ANCESTOR_FROM_PACKAGE" };
  }
  if (input.bridgeAncestorDir === null || input.bridgeAncestorDir.length === 0) {
    return { ok: false, code: "HISTORY_INVALID" };
  }
  const parsed = repairHistoryV1Schema.safeParse(input.history);
  if (!parsed.success) return { ok: false, code: "HISTORY_INVALID" };
  return { ok: true, history: parsed.data };
}

export function parentOuterCycleDelta(event: { kind: string }): 0 | 1 {
  if (event.kind === "subtask.started" || event.kind === "outer_cycle.intent") return 1;
  return 0;
}

const AGENT_SEAT_STRIP = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GIT_ASKPASS",
  "GIT_TERMINAL_PROMPT",
  "ANTCODE_TOKEN",
  "CODEX_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CI_JOB_TOKEN",
  "CIRCLE_TOKEN",
];

export function agentSeatEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of AGENT_SEAT_STRIP) {
    delete next[key];
  }
  return next;
}

export function integrateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env };
}

export function frozenIntegrateCommand(input: {
  verb: "check-remote" | "push-remote";
  identity: FrozenIntegrateIdentity;
  fromPackage?: { argv?: string[]; repo?: string; ref?: string };
}):
  | { ok: true; executable: "squadctl"; argv: string[] }
  | { ok: false; code: "UNTRUSTED_RECEIPT" } {
  void input.fromPackage;
  if (
    !FULL_COMMIT_SHA.test(input.identity.expectedOldSha) ||
    !FULL_COMMIT_SHA.test(input.identity.candidateSha)
  ) {
    return { ok: false, code: "UNTRUSTED_RECEIPT" };
  }
  return {
    ok: true,
    executable: "squadctl",
    argv: [
      "integrate",
      input.verb,
      "--repo",
      input.identity.repo,
      "--ref",
      input.identity.sourceBranch,
      "--expected-old-sha",
      input.identity.expectedOldSha,
      "--candidate-sha",
      input.identity.candidateSha,
    ],
  };
}
