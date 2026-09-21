import {
  buildGoalContract,
  evaluateVerificationAsset,
  generateTaskCard,
  goalIdentityFingerprint,
} from "@shared/runtime/repair-contract";
import { SQUAD_REQUIRED_GATES_V1, hashRepairGatePolicy } from "@shared/runtime/repair-policy";
import { describe, expect, it } from "vitest";

const SHA = "b".repeat(40);
const POLICY = hashRepairGatePolicy(SQUAD_REQUIRED_GATES_V1);

describe("goal contract and verification assets", () => {
  it("freezes the controller policy hash rather than a candidate-claimed value", () => {
    const contract = buildGoalContract({
      sourceRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      originalRequest: "keep Ready after retry",
      goal: "Ready invariant holds",
      invariants: ["Ready stays Ready"],
      allowedScope: ["src/ready.ts"],
      acceptance: [
        {
          assertionId: "A-E1-v1",
          precondition: "instance is Ready",
          trigger: "inject failure",
          allowedStimuli: ["release barrier", "observe"],
          observation: "returns to Ready without extra Retry",
          environment: "isolated testdb",
          evidenceKind: "regression_test",
        },
      ],
      chainId: "ck-chain-1",
      frozenPolicyHash: POLICY,
    });
    expect(contract.frozenPolicyHash).toBe(POLICY);
    expect(contract.frozenPolicyHash).toHaveLength(64);
  });

  it("rejects dirty trees, zero tests, skips, and builder-certified receipts", () => {
    const base = {
      assertionId: "A-E1-v1",
      snapshotSha: SHA,
      testAssetVersion: "tests-v1",
      extraProbesDeclared: false,
    };
    expect(
      evaluateVerificationAsset(
        {
          ...base,
          receipts: [
            {
              command: "go test ./...",
              cwd: "/tmp/x",
              exitCode: 0,
              logPath: "/tmp/x.log",
              snapshotSha: SHA,
              testAssetVersion: "tests-v1",
              dirtyTree: true,
              skipped: false,
              ranZeroTests: false,
              role: "controller",
            },
          ],
        },
        "A-E1-v1",
      ).ok,
    ).toBe(false);
    expect(
      evaluateVerificationAsset(
        {
          ...base,
          receipts: [
            {
              command: "go test ./...",
              cwd: "/tmp/x",
              exitCode: 0,
              logPath: "/tmp/x.log",
              snapshotSha: SHA,
              testAssetVersion: "tests-v1",
              dirtyTree: false,
              skipped: true,
              ranZeroTests: false,
              role: "independent_adjudicator",
            },
          ],
        },
        "A-E1-v1",
      ).reason,
    ).toMatch(/skip/);
    expect(
      evaluateVerificationAsset(
        {
          ...base,
          receipts: [
            {
              command: "go test ./...",
              cwd: "/tmp/x",
              exitCode: 0,
              logPath: "/tmp/x.log",
              snapshotSha: SHA,
              testAssetVersion: "tests-v1",
              dirtyTree: false,
              skipped: false,
              ranZeroTests: true,
              role: "controller",
            },
          ],
        },
        "A-E1-v1",
      ).ok,
    ).toBe(false);
    expect(
      evaluateVerificationAsset(
        {
          ...base,
          receipts: [
            {
              command: "go test ./...",
              cwd: "/tmp/x",
              exitCode: 0,
              logPath: "/tmp/x.log",
              snapshotSha: SHA,
              testAssetVersion: "tests-v1",
              dirtyTree: false,
              skipped: false,
              ranZeroTests: false,
              role: "builder",
            },
          ],
        },
        "A-E1-v1",
      ).reason,
    ).toMatch(/builder/);
  });

  it("rejects mismatched test asset versions and undeclared extra probes", () => {
    const result = evaluateVerificationAsset(
      {
        assertionId: "A1",
        snapshotSha: SHA,
        testAssetVersion: "expected-v1",
        extraProbesDeclared: false,
        receipts: [
          {
            command: "test",
            cwd: "/tmp/test",
            exitCode: 0,
            logPath: "/tmp/test.log",
            snapshotSha: SHA,
            testAssetVersion: "different-v2",
            dirtyTree: false,
            skipped: false,
            ranZeroTests: false,
            role: "independent_adjudicator",
          },
        ],
      },
      "A1",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/version|undeclared extra probe/i);
  });

  it("keeps chain identity stable when finding titles change", () => {
    expect(goalIdentityFingerprint("Keep the same PR goal")).toBe(
      goalIdentityFingerprint("Keep the same PR goal"),
    );
    expect(goalIdentityFingerprint("Keep the same PR goal")).not.toBe(
      goalIdentityFingerprint("a different user goal"),
    );
  });

  it("accepts an independent receipt on the immutable snapshot", () => {
    const result = evaluateVerificationAsset(
      {
        assertionId: "A-E1-v1",
        snapshotSha: SHA,
        testAssetVersion: "tests-v1",
        extraProbesDeclared: false,
        receipts: [
          {
            command: "go test ./ready -count=1",
            cwd: "/tmp/candidate",
            exitCode: 0,
            logPath: "/tmp/candidate.log",
            snapshotSha: SHA,
            testAssetVersion: "tests-v1",
            dirtyTree: false,
            skipped: false,
            ranZeroTests: false,
            role: "independent_adjudicator",
          },
        ],
      },
      "A-E1-v1",
    );
    expect(result).toEqual({ ok: true, reason: "verified" });
  });

  it("builds a task card from the contract instead of storing a second authority", () => {
    const contract = buildGoalContract({
      sourceRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      originalRequest: "fix Ready",
      goal: "Ready invariant",
      invariants: ["Ready"],
      allowedScope: ["src/ready.ts"],
      acceptance: [
        {
          assertionId: "A-E1-v1",
          precondition: "Ready",
          trigger: "fail",
          allowedStimuli: ["observe"],
          observation: "Ready",
          environment: "test",
          evidenceKind: "regression_test",
        },
      ],
      chainId: "ck-chain-1",
      frozenPolicyHash: POLICY,
    });
    const card = generateTaskCard({
      contract,
      candidateSha: SHA,
      responsibleAssertions: ["A-E1-v1"],
      originalCounterexamples: ["fail then Ready"],
      rejectedApproaches: ["sleep then retry"],
      missingEvidence: [],
      remainingBudget: "2 source-fix left",
    });
    expect(card.contractVersion).toBe(1);
    expect(card.goal).toBe("Ready invariant");
    expect(card.responsibleAssertions).toEqual(["A-E1-v1"]);
  });
});
