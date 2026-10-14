/**
 * A present file that is not valid durable JSON must not be treated as missing.
 * Create-if-absent writers used to replace those bytes with a fresh default.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapChain } from "@shared/runtime/repair-chain";
import type { OfficialGatePolicyFreeze } from "@shared/runtime/squad-gate-policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadAssessmentCorrections,
  writeAssessmentCorrections,
} from "../src/auto/assessment-correction";
import { defaultRunCommand } from "../src/auto/checkout-pr";
import { readPlanLock, writePlanLock } from "../src/auto/ledger";
import { resolveLocalRepo } from "../src/auto/local-repo";
import { chainPath, loadOrCreateChain } from "../src/auto/repair-chain-store";
import { bootstrapRepairRun } from "../src/auto/repair-persist";
import { loadReusableRepairGrant, saveRepairProfile } from "../src/auto/repair-profile";
import {
  defaultSupervisedPolicy,
  freezeOfficialGatePolicyWithSquadctl,
  persistFreezeRecord,
  readRegisteredIntent,
  writePolicyIntent,
} from "../src/auto/squad-gate-policy";
import { SquadctlBridge } from "../src/auto/squadctl-bridge";

const TORN = "{";
const REVIEW_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const REPAIR_ID = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const EMPTY_CORRECTIONS = {
  version: 1 as const,
  kind: "councilkit-assessment-corrections" as const,
  records: [],
};
const PLAN_LOCK = {
  version: 1 as const,
  sourceRunId: REVIEW_ID,
  approvedAt: "2026-09-21T00:00:00.000Z",
  verdict: "approve" as const,
  clusters: [],
  deferred: [],
};

function sampleFreeze(taskDir: string, policyFileHash: string): OfficialGatePolicyFreeze {
  return {
    policyHash: "a".repeat(64),
    briefHash: "b".repeat(64),
    taskId: "task-A",
    taskDir,
    requiredGates: [],
    independence: {
      distinct_runs: true,
      distinct_sessions: true,
      distinct_worktrees: true,
    },
    source: "squadctl-gate-policy-freeze",
    createdAt: "2026-09-21T00:00:00.000Z",
    alreadyFrozen: false,
    policyFileHash,
  };
}

describe("durable JSON is not reset when the file is present but invalid", () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-durable-json-"));
    previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
    else process.env.COUNCILKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("leaves a torn repair.json in place instead of bootstrapping a fresh run", () => {
    const runDir = join(home, "runs", REPAIR_ID);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "repair.json");
    writeFileSync(path, TORN);
    expect(() =>
      bootstrapRepairRun({
        runId: REPAIR_ID,
        sourceRunId: REVIEW_ID,
        profileName: "default",
        outerMax: 1,
        timeoutMs: null,
        pid: 1,
      }),
    ).toThrow(/repair\.json is present but invalid/);
    expect(readFileSync(path, "utf8")).toBe(TORN);
  });

  it("still creates repair.json when the run directory has none", () => {
    const boot = bootstrapRepairRun({
      runId: REPAIR_ID,
      sourceRunId: REVIEW_ID,
      profileName: "default",
      outerMax: 1,
      timeoutMs: null,
      pid: 1,
    });
    expect(boot.reused).toBe(false);
    const stored = JSON.parse(readFileSync(join(boot.runDir, "repair.json"), "utf8")) as {
      sourceRunId: string;
    };
    expect(stored.sourceRunId).toBe(REVIEW_ID);
  });

  it("leaves a torn repair chain file in place instead of minting a new budget", () => {
    const input = {
      repo: "github.com/acme/repo",
      prUrl: "https://github.com/acme/repo/pull/9",
      goalFingerprint: "a".repeat(64),
      parentRunId: REPAIR_ID,
      nowMs: 10,
    };
    const path = chainPath(bootstrapChain(input).chainId);
    writeFileSync(path, TORN);
    expect(() => loadOrCreateChain(input)).toThrow(/repair chain file is present but invalid/);
    expect(readFileSync(path, "utf8")).toBe(TORN);
  });

  it("leaves a torn repos.json in place instead of remembering one checkout over it", async () => {
    const repo = join(home, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo });
    const path = join(home, "repos.json");
    writeFileSync(path, TORN);
    await expect(
      resolveLocalRepo({
        pr: "https://github.com/acme/repo/pull/9",
        repoFlag: repo,
        runCommand: defaultRunCommand,
      }),
    ).rejects.toThrow(/repos\.json is present but invalid/);
    expect(readFileSync(path, "utf8")).toBe(TORN);
  });

  it("leaves a torn repair-grant.json in place instead of minting a replacement grant", () => {
    const profile = saveRepairProfile({
      name: "default",
      prUrl: "https://github.com/acme/repo/pull/9",
      repo: "github.com/acme/repo",
      sourceBranch: "feat",
      base: "main",
      capabilities: ["push-source-branch"],
    });
    const runDir = join(home, "runs", REPAIR_ID);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "repair-grant.json");
    writeFileSync(path, TORN);
    expect(() =>
      loadReusableRepairGrant({
        runDir,
        profile,
        now: "2026-09-21T00:00:00.000Z",
        hasWritableCycle: false,
      }),
    ).toThrow(/repair-grant\.json is present but invalid/);
    expect(readFileSync(path, "utf8")).toBe(TORN);
  });

  it("leaves a torn squad bridge identity in place instead of preparing a fresh one", async () => {
    const taskId = "squad-task-durable-json";
    const taskDir = join(home, "squad-tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    const path = join(taskDir, "councilkit-bridge.json");
    writeFileSync(path, TORN);
    const bridge = new SquadctlBridge({
      home,
      executable: "/bin/true",
      workspaceCwd: home,
    });
    await expect(
      bridge.prepare({
        taskId,
        baseSha: "a".repeat(40),
        packagePath: join(home, "package.json"),
      }),
    ).rejects.toThrow(/councilkit-bridge\.json is present but invalid/);
    expect(readFileSync(path, "utf8")).toBe(TORN);
  });

  it("leaves a torn assessment-corrections file in place instead of writing a new one", () => {
    const runDir = join(home, "runs", REVIEW_ID);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "assessment-corrections.v1.json");
    writeFileSync(path, TORN);
    expect(() => writeAssessmentCorrections(runDir, EMPTY_CORRECTIONS)).toThrow(
      /assessment-corrections\.v1\.json is present but invalid/,
    );
    expect(readFileSync(path, "utf8")).toBe(TORN);
    expect(loadAssessmentCorrections(join(home, "runs", "missing"))).toBeNull();
  });

  it("leaves a schema-invalid assessment-corrections file in place", () => {
    const runDir = join(home, "runs", REVIEW_ID);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "assessment-corrections.v1.json");
    const bad = '{"version":1}\n';
    writeFileSync(path, bad);
    expect(() => writeAssessmentCorrections(runDir, EMPTY_CORRECTIONS)).toThrow(
      /assessment-corrections\.v1\.json is present but invalid/,
    );
    expect(readFileSync(path, "utf8")).toBe(bad);
  });

  it("still writes assessment corrections when the file is absent", () => {
    const runDir = join(home, "runs", "fresh-assess");
    mkdirSync(runDir, { recursive: true });
    writeAssessmentCorrections(runDir, EMPTY_CORRECTIONS);
    expect(loadAssessmentCorrections(runDir)?.records).toEqual([]);
  });

  it("leaves a torn plan.lock.json in place instead of writing a new lock", () => {
    const runDir = join(home, "runs", REVIEW_ID);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "plan.lock.json");
    writeFileSync(path, TORN);
    expect(() => writePlanLock(runDir, PLAN_LOCK)).toThrow(
      /plan\.lock\.json is present but invalid/,
    );
    expect(readFileSync(path, "utf8")).toBe(TORN);
    expect(() => readPlanLock(runDir)).toThrow(/plan\.lock\.json is present but invalid/);
  });

  it("leaves a schema-invalid plan.lock.json in place", () => {
    const runDir = join(home, "runs", REVIEW_ID);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "plan.lock.json");
    const bad = '{"version":1}\n';
    writeFileSync(path, bad);
    expect(() => writePlanLock(runDir, PLAN_LOCK)).toThrow(
      /plan\.lock\.json is present but invalid/,
    );
    expect(readFileSync(path, "utf8")).toBe(bad);
  });

  it("still writes plan.lock.json when the run has none", () => {
    const runDir = join(home, "runs", REVIEW_ID);
    mkdirSync(runDir, { recursive: true });
    writePlanLock(runDir, PLAN_LOCK);
    expect(readPlanLock(runDir)?.sourceRunId).toBe(REVIEW_ID);
  });

  it("does not replace a torn policy intent or freeze file", () => {
    const intentDir = join(home, "intent");
    const freezeDir = join(home, "freeze");
    mkdirSync(intentDir, { recursive: true });
    mkdirSync(freezeDir, { recursive: true });
    const intentPath = join(intentDir, "councilkit-policy-intent.json");
    const freezePath = join(freezeDir, "councilkit-policy-freeze.json");
    writeFileSync(intentPath, TORN);
    writeFileSync(freezePath, TORN);
    const policy = defaultSupervisedPolicy();
    const call = (taskDir: string) =>
      freezeOfficialGatePolicyWithSquadctl({
        exec: { executable: "/bin/false" },
        taskDir,
        taskId: "task-A",
        policy,
      });
    expect(() => call(intentDir)).toThrow(/councilkit-policy-intent\.json is present but invalid/);
    expect(() => call(freezeDir)).toThrow(/councilkit-policy-freeze\.json is present but invalid/);
    expect(readFileSync(intentPath, "utf8")).toBe(TORN);
    expect(readFileSync(freezePath, "utf8")).toBe(TORN);
    expect(existsSync(join(intentDir, "councilkit-gate-policy.json"))).toBe(false);
    expect(existsSync(join(freezeDir, "councilkit-gate-policy.json"))).toBe(false);
    expect(existsSync(join(freezeDir, "councilkit-policy-intent.json"))).toBe(false);
  });

  it("leaves a schema-invalid policy intent and freeze file in place", () => {
    const taskDir = join(home, "policy-schema");
    mkdirSync(taskDir, { recursive: true });
    const intentPath = join(taskDir, "councilkit-policy-intent.json");
    const freezePath = join(taskDir, "councilkit-policy-freeze.json");
    const badIntent = '{"policyFileHash":"nope"}\n';
    const badFreeze = '{"policyHash":"nope"}\n';
    writeFileSync(intentPath, badIntent);
    writeFileSync(freezePath, badFreeze);
    expect(() =>
      writePolicyIntent(taskDir, defaultSupervisedPolicy(), { taskId: "task-A" }),
    ).toThrow(/councilkit-policy-intent\.json is present but invalid/);
    expect(() => persistFreezeRecord(taskDir, sampleFreeze(taskDir, "c".repeat(64)))).toThrow(
      /councilkit-policy-freeze\.json is present but invalid/,
    );
    expect(readFileSync(intentPath, "utf8")).toBe(badIntent);
    expect(readFileSync(freezePath, "utf8")).toBe(badFreeze);
  });

  it("still registers a policy intent when the file is absent, and updates a valid one", () => {
    const taskDir = join(home, "policy-fresh");
    const policy = defaultSupervisedPolicy();
    const written = writePolicyIntent(taskDir, policy, { taskId: "task-A" });
    expect(written.policyFileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readRegisteredIntent(taskDir, "task-B")).toBeNull();
    const again = writePolicyIntent(taskDir, policy, { taskId: "task-B" });
    expect(again.policyFileHash).toBe(written.policyFileHash);
    expect(readRegisteredIntent(taskDir, "task-B")?.policyFileHash).toBe(written.policyFileHash);
    const freeze = sampleFreeze(taskDir, written.policyFileHash);
    persistFreezeRecord(taskDir, freeze);
    persistFreezeRecord(taskDir, { ...freeze, createdAt: "2026-09-22T00:00:00.000Z" });
    const stored = JSON.parse(
      readFileSync(join(taskDir, "councilkit-policy-freeze.json"), "utf8"),
    ) as { createdAt: string };
    expect(stored.createdAt).toBe("2026-09-22T00:00:00.000Z");
  });
});
