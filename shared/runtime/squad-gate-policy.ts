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

/** Official freeze identity: SHA-256 of canonical {schema_version, brief_hash, required_gates, independence[, delivery_authority]}. */
export function hashOfficialFrozenPolicy(
  policy: OfficialGatePolicyFile,
  briefHash: string,
): string {
  const body: Record<string, unknown> = {
    schema_version: 1,
    brief_hash: briefHash,
    independence: policy.independence,
    required_gates: policy.required_gates,
  };
  if (policy.delivery_authority) body.delivery_authority = policy.delivery_authority;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export interface RegisteredPolicyIntent {
  policyFileHash: string;
  taskId: string;
  taskDir: string;
  required_gates: OfficialRequiredGate[];
  independence: OfficialIndependence;
  delivery_authority?: OfficialDeliveryAuthority;
}

export function officialPolicyFromIntent(intent: RegisteredPolicyIntent): OfficialGatePolicyFile {
  return {
    required_gates: intent.required_gates,
    independence: intent.independence,
    ...(intent.delivery_authority ? { delivery_authority: intent.delivery_authority } : {}),
  };
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
  input: {
    taskId: string;
    taskDir: string;
    policyFileHash: string;
    alreadyFrozen?: boolean;
    policy?: OfficialGatePolicyFile;
  },
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
  const stdoutGates = Array.isArray(parsed.required_gates)
    ? (parsed.required_gates as OfficialRequiredGate[])
    : [];
  const expected = input.policy;
  const requiredGates =
    expected?.required_gates ?? (stdoutGates.length > 0 ? stdoutGates : []);
  if (requiredGates.length === 0) {
    return { ok: false, reason: "official freeze missing required_gates" };
  }
  const independence = expected?.independence ??
    (isIndependence(parsed.independence) ? parsed.independence : undefined);
  if (!independence) {
    return { ok: false, reason: "official freeze missing independence" };
  }
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
  intent: RegisteredPolicyIntent,
): { ok: true; freeze: OfficialGatePolicyFreeze } | { ok: false; reason: string } {
  const policy = officialPolicyFromIntent(intent);
  if (!hasSupervisedReviewerAndVerifier(policy)) {
    return { ok: false, reason: "registered intent is missing supervised reviewer and verifier" };
  }
  if (hashOfficialGatePolicyFile(policy) !== intent.policyFileHash) {
    return { ok: false, reason: "registered intent hash does not match intent policy body" };
  }
  const recordedObj = asRecord(recorded);
  const projection = asRecord(officialProjection);
  const recordedHash = readHash(recordedObj.policyHash) ?? readHash(recordedObj.policy_hash);
  const projectionHash = readHash(projection.policy_hash) ?? readHash(projection.policyHash);
  const briefHash =
    readHash(recordedObj.briefHash) ??
    readHash(recordedObj.brief_hash) ??
    readHash(projection.brief_hash) ??
    readHash(projection.briefHash);
  if (!briefHash) return { ok: false, reason: "official freeze missing brief_hash" };
  const reconstructed = hashOfficialFrozenPolicy(policy, briefHash);
  const recordedFileHash =
    typeof recordedObj.policyFileHash === "string" ? recordedObj.policyFileHash : null;
  const recordedTaskId = typeof recordedObj.taskId === "string" ? recordedObj.taskId : null;
  const completeRecord =
    Boolean(recordedHash) &&
    Boolean(recordedFileHash) &&
    Array.isArray(recordedObj.requiredGates) &&
    isIndependence(recordedObj.independence);

  if (completeRecord && recordedHash && recordedFileHash) {
    if (recordedFileHash !== intent.policyFileHash) {
      return { ok: false, reason: "recovered freeze does not match registered policy intent" };
    }
    if (recordedTaskId && recordedTaskId !== intent.taskId) {
      return { ok: false, reason: "recovered freeze task does not match registered intent" };
    }
    if (!gatesMatch(recordedObj.requiredGates, intent.required_gates)) {
      return { ok: false, reason: "recovered freeze gates do not match registered intent" };
    }
    if (
      !isIndependence(recordedObj.independence) ||
      !independenceMatch(recordedObj.independence, intent.independence)
    ) {
      return {
        ok: false,
        reason: "recovered freeze independence does not match registered intent",
      };
    }
    if (projectionHash && projectionHash !== recordedHash) {
      return { ok: false, reason: "recorded freeze does not match official journal projection" };
    }
    if (
      Array.isArray(projection.required_gates) &&
      !gatesMatch(projection.required_gates, intent.required_gates)
    ) {
      return {
        ok: false,
        reason: "official projection was tampered relative to registered intent",
      };
    }
    return {
      ok: true,
      freeze: {
        policyHash: recordedHash,
        briefHash,
        taskId: intent.taskId,
        taskDir: intent.taskDir,
        requiredGates: intent.required_gates,
        independence: intent.independence,
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

  if (!projectionHash) {
    return { ok: false, reason: "no official freeze record to recover" };
  }
  if (!gatesMatch(projection.required_gates, intent.required_gates)) {
    return { ok: false, reason: "official projection does not match registered policy intent" };
  }
  if (
    !isIndependence(projection.independence) ||
    !independenceMatch(projection.independence, intent.independence)
  ) {
    return {
      ok: false,
      reason: "official projection independence does not match registered intent",
    };
  }
  if (projectionHash !== reconstructed) {
    return {
      ok: false,
      reason: "official projection hash does not match registered intent canonical freeze",
    };
  }
  return {
    ok: true,
    freeze: {
      policyHash: projectionHash,
      briefHash,
      taskId: intent.taskId,
      taskDir: intent.taskDir,
      requiredGates: intent.required_gates,
      independence: intent.independence,
      source: SQUAD_GATE_POLICY_FREEZE_SOURCE,
      createdAt: new Date().toISOString(),
      alreadyFrozen: true,
      policyFileHash: intent.policyFileHash,
    },
  };
}

function gatesMatch(left: unknown, right: OfficialRequiredGate[]): boolean {
  return Array.isArray(left) && canonicalJson(left) === canonicalJson(right);
}

function independenceMatch(left: OfficialIndependence, right: OfficialIndependence): boolean {
  return canonicalJson(left) === canonicalJson(right);
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
