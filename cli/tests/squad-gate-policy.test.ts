import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQUAD_REQUIRED_GATES_V1, hashRepairGatePolicy } from "@shared/runtime/repair-policy";
import {
  SUPERVISED_REVIEW_VERIFY_FORMAT_POLICY,
  SUPERVISED_REVIEW_VERIFY_POLICY,
  hashOfficialGatePolicyFile,
  parseOfficialPolicyFreezeStdout,
  recoverOfficialPolicyFreeze,
} from "@shared/runtime/squad-gate-policy";
import { afterEach, describe, expect, it } from "vitest";
import { HAS_LIVE_SQUADCTL, LIVE_SQUADCTL } from "./helpers/live-squadctl";

let homes: string[] = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function squadctl(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { stdout: string; stderr: string } {
  return {
    stdout: execFileSync(LIVE_SQUADCTL, [...args, "--json"], {
      cwd,
      encoding: "utf8",
      env,
    }),
    stderr: "",
  };
}

describe.skipIf(!HAS_LIVE_SQUADCTL)("official squadctl gate policy-freeze", () => {
  it("freezes two legal policies with distinct official hashes and refuses a second freeze", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-policy-freeze-"));
    homes.push(root);
    const repo = join(root, "src");
    mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "freeze@example.com"]);
    git(repo, ["config", "user.name", "freeze"]);
    writeFileSync(join(repo, "README.md"), "ok\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    const env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const hashes: string[] = [];
    for (const [label, policy] of [
      ["A", SUPERVISED_REVIEW_VERIFY_POLICY],
      ["B", SUPERVISED_REVIEW_VERIFY_FORMAT_POLICY],
    ] as const) {
      const taskDir = join(root, `task-${label}`);
      mkdirSync(taskDir);
      const taskId = `20260921-freeze-${label.toLowerCase()}a01`;
      squadctl(
        [
          "init",
          "--task-dir",
          taskDir,
          "--task-id",
          taskId,
          "--base-sha",
          sha,
          "--planning",
          "simple",
          "--owner",
          "councilkit",
          "--repo",
          repo,
          "--no-observe",
          "--allow-behind-origin",
        ],
        repo,
        env,
      );
      writeFileSync(join(taskDir, "brief.md"), `# ${label} brief\nKeep the original goal.\n`);
      writeFileSync(join(taskDir, "plan.md"), `# ${label} plan\nDo not rewrite the brief.\n`);
      const status = JSON.parse(
        execFileSync(LIVE_SQUADCTL, ["status", "--task-dir", taskDir, "--json"], {
          cwd: repo,
          encoding: "utf8",
          env,
        }),
      ) as { epoch?: number };
      execFileSync(
        LIVE_SQUADCTL,
        [
          "planning",
          "freeze",
          "--task-dir",
          taskDir,
          "--brief-file",
          join(taskDir, "brief.md"),
          "--plan-file",
          join(taskDir, "plan.md"),
          "--expected-epoch",
          String(status.epoch ?? 0),
          "--json",
        ],
        { cwd: repo, encoding: "utf8", env },
      );
      const policyFile = join(taskDir, "policy.json");
      writeFileSync(policyFile, `${JSON.stringify(policy)}\n`);
      const freezeOut = execFileSync(
        LIVE_SQUADCTL,
        ["gate", "policy-freeze", "--task-dir", taskDir, "--policy-file", policyFile, "--json"],
        { cwd: repo, encoding: "utf8", env },
      );
      const parsed = parseOfficialPolicyFreezeStdout(freezeOut, {
        taskId,
        taskDir,
        policyFileHash: hashOfficialGatePolicyFile(policy),
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.freeze.policyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.freeze.briefHash).toMatch(/^[a-f0-9]{64}$/);
      hashes.push(parsed.freeze.policyHash);
      expect(parsed.freeze.policyHash).not.toBe(hashRepairGatePolicy(SQUAD_REQUIRED_GATES_V1));
      const second = spawnSync(
        LIVE_SQUADCTL,
        ["gate", "policy-freeze", "--task-dir", taskDir, "--policy-file", policyFile, "--json"],
        { cwd: repo, encoding: "utf8", env, timeout: 15_000 },
      );
      expect(second.status).not.toBe(0);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});

describe("official freeze recovery", () => {
  it("recovers a persisted freeze and refuses a missing record", () => {
    const recorded = {
      policyHash: "a".repeat(64),
      briefHash: "b".repeat(64),
      taskId: "20260921-freeze-aa01",
      taskDir: "/tmp/task",
      requiredGates: SUPERVISED_REVIEW_VERIFY_POLICY.required_gates,
      independence: SUPERVISED_REVIEW_VERIFY_POLICY.independence,
      source: "squadctl-gate-policy-freeze" as const,
      createdAt: "2026-09-21T00:00:00.000Z",
      alreadyFrozen: false,
      policyFileHash: hashOfficialGatePolicyFile(SUPERVISED_REVIEW_VERIFY_POLICY),
    };
    const recovered = recoverOfficialPolicyFreeze(
      recorded,
      { policy_hash: "a".repeat(64), brief_hash: "b".repeat(64) },
      {
        policyFileHash: recorded.policyFileHash,
        taskId: recorded.taskId,
        taskDir: recorded.taskDir,
      },
    );
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.freeze.alreadyFrozen).toBe(true);
    const missing = recoverOfficialPolicyFreeze(null, null, {
      policyFileHash: recorded.policyFileHash,
      taskId: recorded.taskId,
      taskDir: recorded.taskDir,
    });
    expect(missing.ok).toBe(false);
  });
});

describe("catalog hashes are not official freeze hashes", () => {
  it("keeps the controller catalog hash in a different namespace from official policy files", () => {
    const catalog = hashRepairGatePolicy(SQUAD_REQUIRED_GATES_V1);
    const officialFile = hashOfficialGatePolicyFile(SUPERVISED_REVIEW_VERIFY_POLICY);
    expect(catalog).toHaveLength(64);
    expect(officialFile).toHaveLength(64);
    expect(catalog).not.toBe(officialFile);
    expect(
      createHash("sha256")
        .update(JSON.stringify({ schema_version: 1, brief_hash: "a".repeat(64) }))
        .digest("hex"),
    ).not.toBe(catalog);
  });
});
