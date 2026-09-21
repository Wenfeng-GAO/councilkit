import { createHash } from "node:crypto";
import { canonicalJson } from "./digest";
import { isFrozenPolicyHash } from "./repair-policy";

const POLICY_HASH = /^[a-f0-9]{64}$/;

export const SQUAD_GATE_POLICY_FREEZE_SOURCE = "squadctl-gate-policy-freeze" as const;

/** Official `gate policy-freeze --policy-file` body (not a CouncilKit catalog object). */
export interface OfficialGatePolicyFile {
  required_gates: OfficialRequiredGate[];
  independence: OfficialIndependence;
  delivery_authority?: OfficialDeliveryAuthority;
}

export interface OfficialRequiredGate {
  gate_id: string;
  role: "reviewer" | "verifier" | "host" | "build" | "unit" | "lint";
  min_realism_tier: "unit_mock" | "framework_contract" | "runtime_executable" | "external_live";
  baseline_required: boolean;
  evidence_kind: "supervised" | "external_attestation";
}

export interface OfficialIndependence {
  distinct_runs: boolean;
  distinct_sessions: boolean;
  distinct_worktrees: boolean;
}

export interface OfficialDeliveryAuthority {
  push: boolean;
  pr_mutation: boolean;
  remote: string | null;
  target_ref: string | null;
  authority_ref: string | null;
}

export interface OfficialGatePolicyFreeze {
  policyHash: string;
  briefHash: string;
  taskId: string;
  taskDir: string;
  requiredGates: OfficialRequiredGate[];
  independence: OfficialIndependence;
  source: typeof SQUAD_GATE_POLICY_FREEZE_SOURCE;
  createdAt: string;
  alreadyFrozen: boolean;
  policyFileHash: string;
}

export const SUPERVISED_REVIEW_VERIFY_POLICY: OfficialGatePolicyFile = {
  required_gates: [
    {
      gate_id: "review",
      role: "reviewer",
      min_realism_tier: "framework_contract",
      baseline_required: false,
      evidence_kind: "supervised",
    },
    {
      gate_id: "verify",
      role: "verifier",
      min_realism_tier: "runtime_executable",
      baseline_required: false,
      evidence_kind: "supervised",
    },
  ],
  independence: {
    distinct_runs: true,
    distinct_sessions: true,
    distinct_worktrees: true,
  },
};

export const SUPERVISED_REVIEW_VERIFY_FORMAT_POLICY: OfficialGatePolicyFile = {
  required_gates: [
    ...SUPERVISED_REVIEW_VERIFY_POLICY.required_gates,
    {
      gate_id: "format",
      role: "lint",
      min_realism_tier: "unit_mock",
      baseline_required: false,
      evidence_kind: "supervised",
    },
  ],
  independence: { ...SUPERVISED_REVIEW_VERIFY_POLICY.independence },
};

export function hashOfficialGatePolicyFile(policy: OfficialGatePolicyFile): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

export function hasSupervisedReviewerAndVerifier(policy: OfficialGatePolicyFile): boolean {
  const roles = new Set(policy.required_gates.map((row) => row.role));
  const kinds = policy.required_gates.filter(
    (row) =>
      (row.role === "reviewer" || row.role === "verifier") && row.evidence_kind === "supervised",
  );
  return roles.has("reviewer") && roles.has("verifier") && kinds.length >= 2;
}

export function parseOfficialPolicyFreezeStdout(
  stdout: string,
  input: { taskId: string; taskDir: string; policyFileHash: string; alreadyFrozen?: boolean },
): { ok: true; freeze: OfficialGatePolicyFreeze } | { ok: false; reason: string } {
  const parsed = parseJsonObject(stdout);
  if (!parsed) return { ok: false, reason: "official policy freeze stdout was not JSON" };
  const policyHash =
    readHash(parsed.policy_hash) ??
    readHash(parsed.policyHash) ??
    readHash(parsed.gate_policy_hash);
  const briefHash = readHash(parsed.brief_hash) ?? readHash(parsed.briefHash);
  if (!policyHash) return { ok: false, reason: "official freeze stdout missing policy_hash" };
  if (!briefHash) return { ok: false, reason: "official freeze stdout missing brief_hash" };
  const requiredGates = Array.isArray(parsed.required_gates)
    ? (parsed.required_gates as OfficialRequiredGate[])
    : [];
  const independence = isIndependence(parsed.independence)
    ? parsed.independence
    : SUPERVISED_REVIEW_VERIFY_POLICY.independence;
  const createdAt =
    typeof parsed.created_at === "string" && parsed.created_at.length > 0
      ? parsed.created_at
      : new Date().toISOString();
  return {
    ok: true,
    freeze: {
      policyHash,
      briefHash,
      taskId: input.taskId,
      taskDir: input.taskDir,
      requiredGates,
      independence,
      source: SQUAD_GATE_POLICY_FREEZE_SOURCE,
      createdAt,
      alreadyFrozen: input.alreadyFrozen === true,
      policyFileHash: input.policyFileHash,
    },
  };
}

export function recoverOfficialPolicyFreeze(
  recorded: unknown,
  officialProjection: unknown,
  intent: { policyFileHash: string; taskId: string; taskDir: string },
): { ok: true; freeze: OfficialGatePolicyFreeze } | { ok: false; reason: string } {
  const recordedObj = asRecord(recorded);
  const recordedHash = readHash(recordedObj.policyHash) ?? readHash(recordedObj.policy_hash);
  const projection = asRecord(officialProjection);
  const projectionHash = readHash(projection.policy_hash) ?? readHash(projection.policyHash);
  if (!recordedHash && !projectionHash) {
    return { ok: false, reason: "no official freeze record to recover" };
  }
  if (recordedHash && projectionHash && recordedHash !== projectionHash) {
    return { ok: false, reason: "recorded freeze does not match official journal projection" };
  }
  const policyHash = recordedHash ?? projectionHash;
  if (!policyHash) return { ok: false, reason: "official policy hash unknown" };
  const briefHash =
    readHash(recordedObj.briefHash) ??
    readHash(recordedObj.brief_hash) ??
    readHash(projection.brief_hash);
  if (!briefHash) return { ok: false, reason: "official freeze missing brief_hash" };
  const recordedFileHash =
    typeof recordedObj.policyFileHash === "string" ? recordedObj.policyFileHash : null;
  if (recordedFileHash && recordedFileHash !== intent.policyFileHash) {
    return { ok: false, reason: "recovered freeze does not match registered policy intent" };
  }
  return {
    ok: true,
    freeze: {
      policyHash,
      briefHash,
      taskId: intent.taskId,
      taskDir: intent.taskDir,
      requiredGates: Array.isArray(recordedObj.requiredGates)
        ? (recordedObj.requiredGates as OfficialRequiredGate[])
        : Array.isArray(projection.required_gates)
          ? (projection.required_gates as OfficialRequiredGate[])
          : [],
      independence: isIndependence(recordedObj.independence)
        ? recordedObj.independence
        : isIndependence(projection.independence)
          ? projection.independence
          : SUPERVISED_REVIEW_VERIFY_POLICY.independence,
      source: SQUAD_GATE_POLICY_FREEZE_SOURCE,
      createdAt:
        typeof recordedObj.createdAt === "string"
          ? recordedObj.createdAt
          : new Date().toISOString(),
      alreadyFrozen: true,
      policyFileHash: intent.policyFileHash,
    },
  };
}

function readHash(value: unknown): string | null {
  return typeof value === "string" && POLICY_HASH.test(value) ? value : null;
}

function isIndependence(value: unknown): value is OfficialIndependence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.distinct_runs === "boolean" &&
    typeof row.distinct_sessions === "boolean" &&
    typeof row.distinct_worktrees === "boolean"
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return asRecord(JSON.parse(trimmed.slice(start, end + 1)));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && Array.isArray(value) === false) {
    return value as Record<string, unknown>;
  }
  return {};
}

export { isFrozenPolicyHash };
