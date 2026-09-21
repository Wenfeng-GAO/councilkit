import { createHash } from "node:crypto";
import { canonicalJson } from "./digest";
import { journalFromSquadStatus } from "./squad-journal-map";

const POLICY_HASH = /^[a-f0-9]{64}$/;

export const REPAIR_GATE_POLICY_IDS = [
  "squad-required-gates-v1",
  "squad-required-gates-v2",
] as const;
export type RepairGatePolicyId = (typeof REPAIR_GATE_POLICY_IDS)[number];

export interface RepairGatePolicyDocument {
  id: RepairGatePolicyId;
  version: string;
  source: "councilkit-controller";
  requiredGates: readonly string[];
  independenceRequired: boolean;
}

/** Controller-owned policy content. Hash this; never a live candidate journal. */
export const SQUAD_REQUIRED_GATES_V1: RepairGatePolicyDocument = {
  id: "squad-required-gates-v1",
  version: "1",
  source: "councilkit-controller",
  requiredGates: ["independent_review", "independent_verify", "required_gates_passed"],
  independenceRequired: true,
};

export const SQUAD_REQUIRED_GATES_V2: RepairGatePolicyDocument = {
  id: "squad-required-gates-v2",
  version: "2",
  source: "councilkit-controller",
  requiredGates: ["independent_review", "independent_verify", "required_gates_passed", "format"],
  independenceRequired: true,
};

export const REPAIR_GATE_POLICY_CATALOG: Record<RepairGatePolicyId, RepairGatePolicyDocument> = {
  "squad-required-gates-v1": SQUAD_REQUIRED_GATES_V1,
  "squad-required-gates-v2": SQUAD_REQUIRED_GATES_V2,
};

export const DEFAULT_GATE_POLICY_ID: RepairGatePolicyId = "squad-required-gates-v1";

export function hashRepairGatePolicy(policy: RepairGatePolicyDocument): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        id: policy.id,
        version: policy.version,
        source: policy.source,
        requiredGates: [...policy.requiredGates],
        independenceRequired: policy.independenceRequired,
      }),
    )
    .digest("hex");
}

export function isFrozenPolicyHash(value: string | null | undefined): value is string {
  return typeof value === "string" && POLICY_HASH.test(value);
}

/** Trusted expected hash: frozen controller value, or unknown. Never the candidate. */
export function expectedGatePolicyHash(frozen: string | null | undefined): string | "unknown" {
  return isFrozenPolicyHash(frozen) ? frozen : "unknown";
}

export function policyHashMatches(expected: string | "unknown", observed: string): boolean {
  if (expected === "unknown") return false;
  return expected === observed;
}

export function freezeExpectedGatePolicy(input: {
  persisted?: string | null;
  catalogId?: string | null;
  profileHash?: string | null;
}):
  | { ok: true; hash: string; source: "persisted" | "catalog" | "profile" }
  | { ok: false; reason: string } {
  if (isFrozenPolicyHash(input.persisted)) {
    return { ok: true, hash: input.persisted, source: "persisted" };
  }
  if (isFrozenPolicyHash(input.profileHash)) {
    return { ok: true, hash: input.profileHash, source: "profile" };
  }
  const catalogId = input.catalogId;
  if (catalogId && catalogId in REPAIR_GATE_POLICY_CATALOG) {
    return {
      ok: true,
      hash: hashRepairGatePolicy(REPAIR_GATE_POLICY_CATALOG[catalogId as RepairGatePolicyId]),
      source: "catalog",
    };
  }
  return {
    ok: false,
    reason: "no frozen gate policy; refuse to default to a fixture or candidate hash",
  };
}

/**
 * Explicit freeze from a trusted Squad status record (not a live candidate).
 * Checks minimum required gates, then persists the attested hash.
 */
export function attestTrustedSquadPolicy(
  status: unknown,
  required: RepairGatePolicyDocument,
): { ok: true; hash: string } | { ok: false; reason: string } {
  const journal = journalFromSquadStatus(status);
  if (!isFrozenPolicyHash(journal.gatePolicyHash)) {
    return { ok: false, reason: "trusted Squad record has no policy hash" };
  }
  for (const gate of required.requiredGates) {
    if (gate === "independent_review" && !journal.independentReview) {
      return { ok: false, reason: "trusted record missing independent_review" };
    }
    if (gate === "independent_verify" && !journal.independentVerify) {
      return { ok: false, reason: "trusted record missing independent_verify" };
    }
    if (gate === "required_gates_passed" && !journal.requiredGatesPassed) {
      return { ok: false, reason: "trusted record missing required_gates_passed" };
    }
  }
  if (required.independenceRequired && !journal.requiredGatesPassed) {
    return { ok: false, reason: "trusted record failed independence gates" };
  }
  return { ok: true, hash: journal.gatePolicyHash };
}
