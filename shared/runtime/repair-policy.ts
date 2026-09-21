import { journalFromSquadStatus } from "./squad-journal-map";

const POLICY_HASH = /^[a-f0-9]{64}$/;

/**
 * Trusted Squad gate-policy record. This is the official status snapshot used
 * by `journalFromSquadStatus` (same object as tests/fixtures/squad-status-official.json).
 * Expected policy is frozen from this mapping, never from a live candidate journal.
 */
export const TRUSTED_SQUAD_GATE_STATUS_SNAPSHOT = {
  phase: "reviewing",
  control_status: "active",
  candidate: {
    status: "completed",
    candidate_sha: "9c0e83b83496b47590667532e71b2ffdca9fd7de",
    policy_hash: "b07590c09986aadf0b193743e3cf82026709003d2ffa8cec95a86ceaffbaf263",
  },
  independence: {
    policy_status: "satisfied",
    bound_same_sha: true,
    provenance_complete: true,
    shared_run: false,
    shared_session: false,
    shared_worktree: false,
    actual_identity_complete: false,
  },
  projection: {
    aggregate_verdict: {
      approved: true,
      binding_gaps: [],
      candidate_sha: "9c0e83b83496b47590667532e71b2ffdca9fd7de",
      independence_gaps: [],
      required_gate_gaps: [],
      reviewer_pass: true,
      verdict: "pass",
      verifier_pass: true,
    },
  },
} as const;

/** Trusted expected hash: mapped from the official Squad snapshot, not a CK-invented document. */
export function frozenRepairGatePolicyHash(): string {
  const hash = journalFromSquadStatus(TRUSTED_SQUAD_GATE_STATUS_SNAPSHOT).gatePolicyHash;
  if (!isFrozenPolicyHash(hash)) {
    throw new Error("trusted Squad gate policy hash missing from official snapshot mapping");
  }
  return hash;
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
