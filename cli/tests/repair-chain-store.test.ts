import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSourceFix, newRepairBudget } from "@shared/runtime/repair-chain";
import { goalIdentityFingerprint } from "@shared/runtime/repair-contract";
import { evaluateRepairGate } from "@shared/runtime/repair-gate";
import { SQUAD_REQUIRED_GATES_V1, hashRepairGatePolicy } from "@shared/runtime/repair-policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeLockedRetry,
  consumeLockedSourceFix,
  loadOrCreateChain,
  peekLockedRetry,
  readRepairChain,
} from "../src/auto/repair-chain-store";
import { assembleProductionGate } from "../src/auto/repair-protocol";

let home: string;
let previous: string | undefined;

describe("repair chain store identity and locked budget", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-chain-store-"));
    previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
    else process.env.COUNCILKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("inherits the same PR chain when finding titles change but the original request does not", () => {
    const first = loadOrCreateChain({
      repo: "github.com/acme/repo",
      prUrl: "https://github.com/acme/repo/pull/1",
      goalFingerprint: goalIdentityFingerprint("Keep the same PR goal"),
      parentRunId: "ck-repair-1",
      nowMs: 10,
    });
    const used = consumeLockedSourceFix(first.chain.chainId, 11);
    expect(used.ok).toBe(true);
    const second = loadOrCreateChain({
      repo: "github.com/acme/repo",
      prUrl: "https://github.com/acme/repo/pull/1",
      goalFingerprint: goalIdentityFingerprint("Keep the same PR goal"),
      parentRunId: "ck-repair-2",
      budget: newRepairBudget({ sourceFixMax: 3 }, 12),
      nowMs: 12,
    });
    expect(second.inherited).toBe(true);
    expect(second.chain.chainId).toBe(first.chain.chainId);
    expect(second.chain.budget.sourceFixUsed).toBe(1);
    expect(second.chain.parentRunIds).toContain("ck-repair-2");
  });

  it("does not let a lock-outside stale budget overwrite the chain", () => {
    const created = loadOrCreateChain({
      repo: "github.com/acme/repo",
      prUrl: "https://github.com/acme/repo/pull/2",
      goalFingerprint: "a".repeat(64),
      parentRunId: "ck-repair-1",
      budget: consumeSourceFix(newRepairBudget({ sourceFixMax: 3 }, 0)),
      nowMs: 0,
    });
    expect(created.chain.budget.sourceFixUsed).toBe(1);
    const again = consumeLockedSourceFix(created.chain.chainId, 1);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.budget.sourceFixUsed).toBe(2);
  });

  it("peeks verify budget without executing and refuses once exhausted", () => {
    const created = loadOrCreateChain({
      repo: "github.com/acme/repo",
      prUrl: "https://github.com/acme/repo/pull/3",
      goalFingerprint: "b".repeat(64),
      parentRunId: "ck-repair-1",
      budget: newRepairBudget({ verifyRetryMax: 1 }, 0),
      nowMs: 0,
    });
    const peeked = peekLockedRetry(created.chain.chainId, "verify");
    expect(peeked.ok).toBe(true);
    expect(readRepairChain(created.chain.chainId)?.budget.verifyRetryUsed).toBe(0);
    const consumed = consumeLockedRetry(created.chain.chainId, "verify");
    expect(consumed.ok).toBe(true);
    const again = peekLockedRetry(created.chain.chainId, "verify");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/verify retry budget exhausted/);
  });
});

describe("production gate wrapper", () => {
  it("does not fall back to a fixture hash when frozen policy is missing", () => {
    const sha = "a".repeat(40);
    const assembled = assembleProductionGate({
      frozenPolicyHash: null,
      candidateSha: sha,
      publishedSha: sha,
      remote: {
        prUrl: "https://github.com/acme/repo/pull/1",
        host: "github",
        branch: "feat",
        cloneUrl: "https://github.com/acme/repo.git",
        baseBranch: "main",
        headSha: sha,
        baseSha: "b".repeat(40),
        prOpen: true,
      },
      expectedBaseBranch: "main",
      source: {
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        prUrl: "https://github.com/acme/repo/pull/1",
      },
      squad: {
        taskId: "task",
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        sha,
        gatePolicyHash: hashRepairGatePolicy(SQUAD_REQUIRED_GATES_V1),
      },
      review: {
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        incomplete: false,
        seatsAllSuccess: true,
        aggregatorComplete: true,
        artifactsOk: true,
        sha,
        evidenceComplete: true,
        uncoveredIds: [],
        aggregatorVerdict: "approve",
        findings: [],
      },
      checkedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(assembled.policyHash).toBe("unknown");
    expect(evaluateRepairGate(assembled).passed).toBe(false);
    expect(evaluateRepairGate(assembled).reasons.map((row) => row.code)).toContain(
      "policy_unknown",
    );
  });
});
