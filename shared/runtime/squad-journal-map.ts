import {
  type SquadBridgeEventKind,
  type SquadJournalRefs,
  canRequestPublish,
  squadJournalRefsSchema,
} from "./squad-bridge-contract";

const ZERO_SHA = "0".repeat(40);
const FULL_SHA = /^[0-9a-f]{40}$/i;
const POLICY_HASH = /^[a-f0-9]{64}$/;

export function journalFromSquadStatus(view: unknown): SquadJournalRefs {
  const row = asRecord(view);
  const candidate = asRecord(row.candidate);
  const sha = fullSha(candidate.candidate_sha) ?? ZERO_SHA;
  const completed = candidate.status === "completed";
  const policyHash =
    typeof candidate.policy_hash === "string" && POLICY_HASH.test(candidate.policy_hash)
      ? candidate.policy_hash
      : "unknown";
  const projection = asRecord(row.projection);
  const aggregate = asRecord(projection.aggregate_verdict);
  const independence = asRecord(row.independence);
  const sameSha = completed && sha !== ZERO_SHA && fullSha(aggregate.candidate_sha) === sha;
  const gapsEmpty =
    isEmptyArray(aggregate.binding_gaps) &&
    isEmptyArray(aggregate.independence_gaps) &&
    isEmptyArray(aggregate.required_gate_gaps);
  const policyOk =
    independence.policy_status === "satisfied" &&
    independence.bound_same_sha === true &&
    independence.provenance_complete === true &&
    independence.shared_run === false &&
    independence.shared_session === false &&
    independence.shared_worktree === false;
  const independentReview = sameSha && aggregate.reviewer_pass === true;
  const independentVerify = sameSha && aggregate.verifier_pass === true;
  const requiredGatesPassed =
    sameSha &&
    independentReview &&
    independentVerify &&
    aggregate.approved === true &&
    aggregate.verdict === "pass" &&
    gapsEmpty &&
    policyOk &&
    policyHash !== "unknown";
  return squadJournalRefsSchema.parse({
    candidateSha: sha.toLowerCase(),
    invalidated: candidate.invalidated === true || candidate.status === "invalidated",
    independentReview,
    independentVerify,
    requiredGatesPassed,
    gatePolicyHash: policyHash,
    observeClosed: projection.observe_status === "closed",
  });
}

export function eventKindFromSquadStatus(
  view: unknown,
  opts?: { stopped?: boolean },
): SquadBridgeEventKind {
  if (opts?.stopped) return "stopped";
  const row = asRecord(view);
  const control = typeof row.control_status === "string" ? row.control_status : "";
  const phase = typeof row.phase === "string" ? row.phase : "";
  if (control === "stopped" || control === "paused") return "stopped";
  if (control === "blocked" || phase === "blocked") return "blocked";
  if (control === "failed" || phase === "failed") return "failed";
  const journal = journalFromSquadStatus(view);
  if (phase === "integrating" && canRequestPublish({ kind: "candidate_ready", journal })) {
    return "candidate_ready";
  }
  return "running";
}

export function mapSquadStatus(
  view: unknown,
  opts?: { stopped?: boolean },
): { kind: SquadBridgeEventKind; journal: SquadJournalRefs } {
  return {
    kind: eventKindFromSquadStatus(view, opts),
    journal: journalFromSquadStatus(view),
  };
}

function fullSha(value: unknown): string | null {
  return typeof value === "string" && FULL_SHA.test(value) ? value.toLowerCase() : null;
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
