/**
 * A present file that is not valid durable JSON must not be treated as missing.
 * Create-if-absent writers used to replace those bytes with a fresh default.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapChain } from "@shared/runtime/repair-chain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAssessmentCorrections } from "../src/auto/assessment-correction";
import { defaultRunCommand } from "../src/auto/checkout-pr";
import { resolveLocalRepo } from "../src/auto/local-repo";
import { chainPath, loadOrCreateChain } from "../src/auto/repair-chain-store";
import { bootstrapRepairRun } from "../src/auto/repair-persist";
import { loadReusableRepairGrant, saveRepairProfile } from "../src/auto/repair-profile";
import { SquadctlBridge } from "../src/auto/squadctl-bridge";

const TORN = "{";
const REVIEW_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const REPAIR_ID = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";

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

  it("leaves a torn assessment-corrections file in place instead of loading it as empty", () => {
    const runDir = join(home, "runs", REVIEW_ID);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "assessment-corrections.v1.json");
    writeFileSync(path, TORN);
    expect(() => loadAssessmentCorrections(runDir)).toThrow(
      /assessment-corrections\.v1\.json is present but invalid/,
    );
    expect(readFileSync(path, "utf8")).toBe(TORN);
    expect(loadAssessmentCorrections(join(home, "runs", "missing"))).toBeNull();
  });
});
