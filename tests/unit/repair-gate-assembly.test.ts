import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import { assembleRepairGateInput, evaluateRepairGate } from "@shared/runtime/repair-gate";
import { type RepairIdentityFacts, known, unknown } from "@shared/runtime/repair-identity";
import {
  SQUAD_REQUIRED_GATES_V1,
  SQUAD_REQUIRED_GATES_V2,
  attestTrustedSquadPolicy,
  freezeExpectedGatePolicy,
  hashRepairGatePolicy,
} from "@shared/runtime/repair-policy";
import { journalFromSquadStatus } from "@shared/runtime/squad-journal-map";
import { describe, expect, it } from "vitest";

const SHA = "9c0e83b83496b47590667532e71b2ffdca9fd7de";
const SOURCE = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const REVIEW = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4";
const PR = "https://github.com/acme/repo/pull/1";
const POLICY_V1 = hashRepairGatePolicy(SQUAD_REQUIRED_GATES_V1);
const POLICY_V2 = hashRepairGatePolicy(SQUAD_REQUIRED_GATES_V2);

const official = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/squad-status-official.json"),
    "utf8",
  ),
) as unknown;

function verified(id: string): LedgerFinding {
  return {
    id,
    severity: "nit",
    status: "closed",
    title: id,
    text: "closed with evidence",
    source: "consensus",
    reviewer: "review-correctness",
    files: ["src/a.ts"],
    verification: {
      outcome: "verified_closed",
      candidateSha: SHA,
      runId: REVIEW,
      attemptId: "attempt-0",
      reviewer: "review-correctness",
      method: "code_trace",
      reason: "gone",
      evidence: "src/a.ts:1",
      locations: ["src/a.ts:1"],
      runComplete: true,
    },
  };
}

function identity(overrides: Partial<RepairIdentityFacts> = {}): RepairIdentityFacts {
  return {
    sourceSha: known(SHA),
    candidateSha: SHA,
    publishedSha: known(SHA),
    remoteHead: known(SHA),
    baseUnchanged: known(true),
    prOpen: known(true),
    adoptedExistingRemote: false,
    ...overrides,
  };
}

function review(findings: LedgerFinding[] = [verified("F-nit")]) {
  return {
    runId: REVIEW,
    incomplete: false,
    seatsAllSuccess: true,
    aggregatorComplete: true,
    artifactsOk: true,
    sha: SHA,
    evidenceComplete: true as const,
    uncoveredIds: [] as string[],
    aggregatorVerdict: "approve" as const,
    findings,
  };
}

function squadFromJournal() {
  const journal = journalFromSquadStatus(official);
  return {
    taskId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
    invalidated: journal.invalidated,
    independentReview: journal.independentReview,
    independentVerify: journal.independentVerify,
    requiredGatesPassed: journal.requiredGatesPassed,
    sha: journal.candidateSha,
    gatePolicyHash: journal.gatePolicyHash,
  };
}

describe("production gate assembly", () => {
  it("hashes two different controller policies independently and never uses a fixture constant as global expected", () => {
    expect(POLICY_V1).toHaveLength(64);
    expect(POLICY_V2).toHaveLength(64);
    expect(POLICY_V1).not.toBe(POLICY_V2);
    expect(freezeExpectedGatePolicy({ catalogId: "squad-required-gates-v1" })).toEqual({
      ok: true,
      hash: POLICY_V1,
      source: "catalog",
    });
    expect(freezeExpectedGatePolicy({})).toMatchObject({ ok: false });
  });

  it("passes each legal policy when expected and observed hashes match", () => {
    for (const hash of [POLICY_V1, POLICY_V2]) {
      const assembled = assembleRepairGateInput({
        frozenPolicyHash: hash,
        identity: identity(),
        source: { runId: SOURCE, prUrl: PR },
        squad: { ...squadFromJournal(), gatePolicyHash: hash },
        review: review(),
        checkedAt: "2026-09-21T00:00:00.000Z",
      });
      expect(evaluateRepairGate(assembled).passed).toBe(true);
    }
  });

  it("rejects a substituted policy even when the candidate still claims success", () => {
    const assembled = assembleRepairGateInput({
      frozenPolicyHash: POLICY_V1,
      identity: identity(),
      source: { runId: SOURCE, prUrl: PR },
      squad: { ...squadFromJournal(), gatePolicyHash: POLICY_V2 },
      review: review(),
      checkedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(evaluateRepairGate(assembled).passed).toBe(false);
  });

  it("does not copy a live candidate journal hash into expected policy", () => {
    const lying = { ...squadFromJournal(), gatePolicyHash: "a".repeat(64) };
    const assembled = assembleRepairGateInput({
      frozenPolicyHash: POLICY_V1,
      identity: identity(),
      source: { runId: SOURCE, prUrl: PR },
      squad: lying,
      review: review(),
      checkedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(assembled.policyHash).toBe(POLICY_V1);
    expect(assembled.policyHash).not.toBe(lying.gatePolicyHash);
    expect(evaluateRepairGate(assembled).passed).toBe(false);
  });

  it("attests a trusted official Squad record without making it a global default", () => {
    const attested = attestTrustedSquadPolicy(official, SQUAD_REQUIRED_GATES_V1);
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;
    expect(attested.hash).toBe(journalFromSquadStatus(official).gatePolicyHash);
    expect(attested.hash).not.toBe(POLICY_V1);
    expect(freezeExpectedGatePolicy({}).ok).toBe(false);
  });

  it("rejects when frozen policy is unknown instead of adopting the candidate hash", () => {
    const assembled = assembleRepairGateInput({
      frozenPolicyHash: null,
      identity: identity(),
      source: { runId: SOURCE, prUrl: PR },
      squad: { ...squadFromJournal(), gatePolicyHash: POLICY_V1 },
      review: review(),
      checkedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(assembled.policyHash).toBe("unknown");
    const result = evaluateRepairGate(assembled);
    expect(result.passed).toBe(false);
    expect(result.reasons.map((row) => row.code)).toContain("policy_unknown");
    expect(result.reasons.map((row) => row.code)).toContain("squad_candidate_invalid");
  });

  it("rejects unknown base, PR open, and publish receipt instead of coercing them to true", () => {
    const assembled = assembleRepairGateInput({
      frozenPolicyHash: POLICY_V1,
      identity: identity({
        publishedSha: unknown("publish receipt missing"),
        baseUnchanged: unknown("observed base SHA missing"),
        prOpen: unknown("PR open state not reported"),
      }),
      source: { runId: SOURCE, prUrl: PR },
      squad: { ...squadFromJournal(), gatePolicyHash: POLICY_V1 },
      review: review(),
      checkedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(assembled.publishedSha).toBe("unknown");
    expect(assembled.baseUnchanged).toBe("unknown");
    expect(assembled.prOpen).toBe("unknown");
    const result = evaluateRepairGate(assembled);
    expect(result.passed).toBe(false);
    expect(result.reasons.map((row) => row.code)).toContain("identity_unknown");
  });

  it("allows adopting an existing remote candidate with an explicit verification record", () => {
    const assembled = assembleRepairGateInput({
      frozenPolicyHash: POLICY_V1,
      identity: identity({
        publishedSha: unknown("receipt lost"),
        adoptedExistingRemote: true,
      }),
      source: { runId: SOURCE, prUrl: PR },
      squad: { ...squadFromJournal(), gatePolicyHash: POLICY_V1 },
      review: review(),
      checkedAt: "2026-09-21T00:00:00.000Z",
    });
    const result = evaluateRepairGate(assembled);
    expect(result.passed).toBe(true);
  });

  it("does not treat a local-candidate stage as a published PR approval", () => {
    const assembled = assembleRepairGateInput({
      frozenPolicyHash: POLICY_V1,
      identity: identity({
        publishedSha: known(null),
        remoteHead: unknown("not published yet"),
        prOpen: unknown("not published yet"),
        baseUnchanged: unknown("not published yet"),
      }),
      source: { runId: SOURCE, prUrl: PR },
      squad: { ...squadFromJournal(), gatePolicyHash: POLICY_V1 },
      review: review(),
      checkedAt: "2026-09-21T00:00:00.000Z",
      stage: "local_candidate",
    });
    const result = evaluateRepairGate(assembled);
    expect(result.passed).toBe(true);
    expect(result.stage).toBe("local_candidate");
  });
});
