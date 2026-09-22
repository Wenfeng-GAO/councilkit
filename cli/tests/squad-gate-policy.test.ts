import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQUAD_REQUIRED_GATES_V1, hashRepairGatePolicy } from "@shared/runtime/repair-policy";
import {
  SUPERVISED_REVIEW_VERIFY_FORMAT_POLICY,
  SUPERVISED_REVIEW_VERIFY_POLICY,
  hashOfficialFrozenPolicy,
  hashOfficialGatePolicyFile,
  parseOfficialPolicyFreezeStdout,
  recoverOfficialPolicyFreeze,
} from "@shared/runtime/squad-gate-policy";
import { buildFrozenPrProfile, deliveryAuthorityFromProfile } from "@shared/runtime/squad-pr-profile";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultSupervisedPolicy,
  freezeOfficialGatePolicyWithSquadctl,
  persistFreezeRecord,
  policyWithFrozenDelivery,
  recoverWrittenFreeze,
  writePolicyIntent,
} from "../src/auto/squad-gate-policy";
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
        policy,
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
      policyHash: hashOfficialFrozenPolicy(SUPERVISED_REVIEW_VERIFY_POLICY, "b".repeat(64)),
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
      { policy_hash: recorded.policyHash, brief_hash: "b".repeat(64) },
      {
        policyFileHash: recorded.policyFileHash,
        taskId: recorded.taskId,
        taskDir: recorded.taskDir,
        required_gates: SUPERVISED_REVIEW_VERIFY_POLICY.required_gates,
        independence: SUPERVISED_REVIEW_VERIFY_POLICY.independence,
      },
    );
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.freeze.alreadyFrozen).toBe(true);
    const missing = recoverOfficialPolicyFreeze(null, null, {
      policyFileHash: recorded.policyFileHash,
      taskId: recorded.taskId,
      taskDir: recorded.taskDir,
      required_gates: SUPERVISED_REVIEW_VERIFY_POLICY.required_gates,
      independence: SUPERVISED_REVIEW_VERIFY_POLICY.independence,
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

describe("production freeze recovery IO", () => {
  it("refuses a weak journal when no registered intent exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-recover-io-"));
    homes.push(root);
    writeFileSync(
      join(root, "gate-policy.json"),
      JSON.stringify({
        policy_hash: "a".repeat(64),
        brief_hash: "b".repeat(64),
        required_gates: [],
        independence: {
          distinct_runs: false,
          distinct_sessions: false,
          distinct_worktrees: false,
        },
      }),
    );
    const recovered = recoverWrittenFreeze(root, "task-A", defaultSupervisedPolicy());
    expect(recovered.ok).toBe(false);
  });

  it("recovers a complete freeze after the parent receipt is gone", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-recover-ok-"));
    homes.push(root);
    const policy = defaultSupervisedPolicy();
    const { policyFileHash } = writePolicyIntent(root, policy, { taskId: "task-A" });
    const briefHash = "b".repeat(64);
    persistFreezeRecord(root, {
      policyHash: hashOfficialFrozenPolicy(policy, briefHash),
      briefHash,
      taskId: "task-A",
      taskDir: root,
      requiredGates: policy.required_gates,
      independence: policy.independence,
      source: "squadctl-gate-policy-freeze",
      createdAt: "2026-09-21T00:00:00.000Z",
      alreadyFrozen: false,
      policyFileHash,
    });
    const recovered = recoverWrittenFreeze(root, "task-A", policy);
    expect(recovered.ok).toBe(true);
  });

  it("refuses a rewritten caller policy and a tampered projection", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-recover-tamper-"));
    homes.push(root);
    const policy = defaultSupervisedPolicy();
    const { policyFileHash } = writePolicyIntent(root, policy, { taskId: "task-A" });
    const briefHash = "b".repeat(64);
    persistFreezeRecord(root, {
      policyHash: hashOfficialFrozenPolicy(policy, briefHash),
      briefHash,
      taskId: "task-A",
      taskDir: root,
      requiredGates: policy.required_gates,
      independence: policy.independence,
      source: "squadctl-gate-policy-freeze",
      createdAt: "2026-09-21T00:00:00.000Z",
      alreadyFrozen: false,
      policyFileHash,
    });
    expect(recoverWrittenFreeze(root, "task-A", SUPERVISED_REVIEW_VERIFY_FORMAT_POLICY).ok).toBe(
      false,
    );
    writeFileSync(
      join(root, "gate-policy.json"),
      JSON.stringify({
        policy_hash: "c".repeat(64),
        brief_hash: briefHash,
        required_gates: SUPERVISED_REVIEW_VERIFY_FORMAT_POLICY.required_gates,
        independence: policy.independence,
      }),
    );
    expect(recoverWrittenFreeze(root, "task-A", policy).ok).toBe(false);
  });

  it("recovers a matching delivery grant and refuses a drifted, dropped, or invented one", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-recover-delivery-"));
    homes.push(root);
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha: "b".repeat(40),
      expectedOldSha: "a".repeat(40),
      remote: "origin",
      authorityRef: "d".repeat(64),
    });
    const authority = deliveryAuthorityFromProfile(profile);
    const policy = { ...defaultSupervisedPolicy(), delivery_authority: authority };
    const { policyFileHash } = writePolicyIntent(root, policy, { taskId: "task-A" });
    const briefHash = "b".repeat(64);
    persistFreezeRecord(root, {
      policyHash: hashOfficialFrozenPolicy(policy, briefHash),
      briefHash,
      taskId: "task-A",
      taskDir: root,
      requiredGates: policy.required_gates,
      independence: policy.independence,
      source: "squadctl-gate-policy-freeze",
      createdAt: "2026-09-22T00:00:00.000Z",
      alreadyFrozen: false,
      policyFileHash,
    });
    writeFileSync(
      join(root, "gate-policy.json"),
      JSON.stringify({ policy_hash: hashOfficialFrozenPolicy(policy, briefHash), brief_hash: briefHash }),
    );
    expect(recoverWrittenFreeze(root, "task-A", policy).ok).toBe(true);
    writeFileSync(
      join(root, "gate-policy.json"),
      JSON.stringify({
        policy_hash: hashOfficialFrozenPolicy(policy, briefHash),
        brief_hash: briefHash,
        required_gates: policy.required_gates,
        independence: policy.independence,
        delivery_authority: { ...authority, authority_ref: "e".repeat(64) },
      }),
    );
    expect(recoverWrittenFreeze(root, "task-A", policy).ok).toBe(false);
    writeFileSync(
      join(root, "gate-policy.json"),
      JSON.stringify({
        policy_hash: hashOfficialFrozenPolicy(policy, briefHash),
        brief_hash: briefHash,
        required_gates: policy.required_gates,
        independence: policy.independence,
      }),
    );
    expect(recoverWrittenFreeze(root, "task-A", policy).ok).toBe(false);
    const bare = mkdtempSync(join(tmpdir(), "ck-recover-invent-"));
    homes.push(bare);
    const plain = defaultSupervisedPolicy();
    const plainHash = writePolicyIntent(bare, plain, { taskId: "task-A" }).policyFileHash;
    persistFreezeRecord(bare, {
      policyHash: hashOfficialFrozenPolicy(plain, briefHash),
      briefHash,
      taskId: "task-A",
      taskDir: bare,
      requiredGates: plain.required_gates,
      independence: plain.independence,
      source: "squadctl-gate-policy-freeze",
      createdAt: "2026-09-22T00:00:00.000Z",
      alreadyFrozen: false,
      policyFileHash: plainHash,
    });
    writeFileSync(
      join(bare, "gate-policy.json"),
      JSON.stringify({
        policy_hash: hashOfficialFrozenPolicy(plain, briefHash),
        brief_hash: briefHash,
        required_gates: plain.required_gates,
        independence: plain.independence,
        delivery_authority: authority,
      }),
    );
    expect(recoverWrittenFreeze(bare, "task-A", plain).ok).toBe(false);
  });
});

describe("frozen delivery authority", () => {
  it("includes only an authority file that matches the frozen profile", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-delivery-match-"));
    homes.push(root);
    expect(policyWithFrozenDelivery(root).delivery_authority).toBeUndefined();
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha: "b".repeat(40),
      expectedOldSha: "a".repeat(40),
      remote: "origin",
      authorityRef: "c".repeat(64),
    });
    const authority = deliveryAuthorityFromProfile(profile);
    writeFileSync(join(root, "councilkit-pr-profile.json"), JSON.stringify(profile));
    writeFileSync(join(root, "delivery-authority.json"), JSON.stringify(authority));
    expect(policyWithFrozenDelivery(root).delivery_authority).toEqual(authority);
    writeFileSync(
      join(root, "delivery-authority.json"),
      JSON.stringify({ ...authority, remote: "elsewhere" }),
    );
    expect(policyWithFrozenDelivery(root).delivery_authority).toBeUndefined();
  });
});

describe.skipIf(!HAS_LIVE_SQUADCTL)("official squadctl publish gate", () => {
  it("pushes only the frozen grant and refuses a missing or drifted authority", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-push-gate-"));
    homes.push(root);
    const repo = join(root, "repo");
    const bare = join(root, "remote.git");
    mkdirSync(repo);
    git(repo, ["init", "-b", "feat-x"]);
    git(repo, ["config", "user.email", "push@example.com"]);
    git(repo, ["config", "user.name", "push"]);
    writeFileSync(join(repo, "README"), "base\n");
    git(repo, ["add", "README"]);
    git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]);
    execFileSync("git", ["init", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "origin", "HEAD:refs/heads/feat-x"]);
    writeFileSync(join(repo, "README"), "candidate\n");
    git(repo, ["commit", "-am", "candidate"]);
    const candidate = git(repo, ["rev-parse", "HEAD"]);
    const env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha: candidate,
      expectedOldSha: base,
      remote: "origin",
      authorityRef: "d".repeat(64),
    });
    const authority = deliveryAuthorityFromProfile(profile);
    const deniedDir = join(root, "task-denied");
    mkdirSync(deniedDir);
    const deniedId = "20260922-push-deny-aa01";
    prepareLegacyTask(repo, deniedDir, deniedId, base, env);
    writeFileSync(join(deniedDir, "brief.md"), "# deny\nKeep the original goal.\n");
    writeFileSync(join(deniedDir, "plan.md"), "# deny\nDo not rewrite the brief.\n");
    const deniedPolicy = join(deniedDir, "policy.json");
    writeFileSync(deniedPolicy, `${JSON.stringify(defaultSupervisedPolicy())}\n`);
    freezePlanning(repo, deniedDir, env);
    mustSquad(
      ["gate", "policy-freeze", "--task-dir", deniedDir, "--policy-file", deniedPolicy],
      repo,
      env,
    );
    const deniedPush = pushRemote(repo, deniedDir, base, candidate, profile, env);
    expect(deniedPush.status).not.toBe(0);
    expect(`${deniedPush.stderr}\n${deniedPush.stdout}`).toMatch(/lacks journal-frozen delivery authority/i);
    expect(git(bare, ["rev-parse", "refs/heads/feat-x"])).toBe(base);

    const taskDir = join(root, "task-granted");
    mkdirSync(taskDir);
    const taskId = "20260922-push-ok-aa01";
    prepareLegacyTask(repo, taskDir, taskId, base, env);
    writeFileSync(join(taskDir, "brief.md"), "# grant\nKeep the original goal.\n");
    writeFileSync(join(taskDir, "plan.md"), "# grant\nDo not rewrite the brief.\n");
    const profilePath = join(taskDir, "councilkit-pr-profile.json");
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    writeFileSync(join(taskDir, "delivery-authority.json"), `${JSON.stringify(authority)}\n`);
    const policy = policyWithFrozenDelivery(taskDir);
    expect(policy.delivery_authority).toEqual(authority);
    const frozen = freezeOfficialGatePolicyWithSquadctl({
      exec: { executable: LIVE_SQUADCTL, env, cwd: repo },
      taskDir,
      taskId,
      policy,
    });
    if (!frozen.ok) throw new Error(frozen.reason);
    const official = JSON.parse(readFileSync(join(taskDir, "gate-policy.json"), "utf8")) as {
      delivery_authority?: typeof authority;
    };
    expect(official.delivery_authority).toEqual(authority);
    approveCandidate({ repo, taskDir, base, candidate, env });
    const driftedPath = join(taskDir, "drifted-profile.json");
    writeFileSync(
      driftedPath,
      JSON.stringify({
        ...profile,
        authorization: { ...profile.authorization, authority_ref: "e".repeat(64) },
      }),
    );
    const drifted = pushRemote(repo, taskDir, base, candidate, driftedPath, env);
    expect(drifted.status).not.toBe(0);
    expect(`${drifted.stderr}\n${drifted.stdout}`).toMatch(/differs from frozen delivery authority/i);
    expect(git(bare, ["rev-parse", "refs/heads/feat-x"])).toBe(base);
    const allowed = pushRemote(repo, taskDir, base, candidate, profilePath, env);
    expect(allowed.status, `${allowed.stderr}\n${allowed.stdout}`).toBe(0);
    expect(git(bare, ["rev-parse", "refs/heads/feat-x"])).toBe(candidate);
  }, 90_000);
});

function prepareLegacyTask(
  repo: string,
  taskDir: string,
  taskId: string,
  base: string,
  env: NodeJS.ProcessEnv,
): void {
  mustSquad(
    [
      "init",
      "--task-dir",
      taskDir,
      "--task-id",
      taskId,
      "--base-sha",
      base,
      "--planning",
      "simple",
      "--owner",
      "councilkit",
      "--repo",
      repo,
      "--legacy",
      "--no-observe",
      "--allow-behind-origin",
    ],
    repo,
    env,
  );
}

function freezePlanning(repo: string, taskDir: string, env: NodeJS.ProcessEnv): void {
  const status = JSON.parse(mustSquad(["status", "--task-dir", taskDir], repo, env).stdout) as {
    epoch?: number;
  };
  mustSquad(
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
    ],
    repo,
    env,
  );
}

function approveCandidate(input: {
  repo: string;
  taskDir: string;
  base: string;
  candidate: string;
  env: NodeJS.ProcessEnv;
}): void {
  const reviewWt = join(input.taskDir, "..", "review-wt");
  const verifyWt = join(input.taskDir, "..", "verify-wt");
  git(input.repo, ["worktree", "add", "--detach", reviewWt, input.candidate]);
  git(input.repo, ["worktree", "add", "--detach", verifyWt, input.candidate]);
  const coderToken = sessionToken(input.taskDir, "coder-token");
  const coder = JSON.parse(
    mustSquad(
      [
        "run",
        "start",
        "--task-dir",
        input.taskDir,
        "--run-id",
        "coder-push-aa01",
        "--role",
        "coder",
        "--purpose",
        "coder",
        "--worktree",
        input.repo,
        "--pid",
        String(process.pid),
        "--session-token-file",
        coderToken,
      ],
      input.repo,
      input.env,
    ).stdout,
  ) as { attempt: number };
  mustSquad(
    [
      "run",
      "finish",
      "--task-dir",
      input.taskDir,
      "--run-id",
      "coder-push-aa01",
      "--attempt",
      String(coder.attempt),
      "--session-token-file",
      coderToken,
    ],
    input.repo,
    input.env,
  );
  mustSquad(
    [
      "candidate",
      "intent",
      "--task-dir",
      input.taskDir,
      "--task-base-sha",
      input.base,
      "--approved-path",
      "README",
      "--worktree",
      input.repo,
    ],
    input.repo,
    input.env,
  );
  mustSquad(
    [
      "candidate",
      "complete",
      "--task-dir",
      input.taskDir,
      "--candidate-sha",
      input.candidate,
      "--worktree",
      input.repo,
    ],
    input.repo,
    input.env,
  );
  recordPassingGate({
    taskDir: input.taskDir,
    repo: input.repo,
    env: input.env,
    gateId: "review",
    role: "reviewer",
    worktree: reviewWt,
    candidate: input.candidate,
    realism: "framework_contract",
    runId: "review-push-aa01",
  });
  recordPassingGate({
    taskDir: input.taskDir,
    repo: input.repo,
    env: input.env,
    gateId: "verify",
    role: "verifier",
    worktree: verifyWt,
    candidate: input.candidate,
    realism: "runtime_executable",
    runId: "verify-push-aa01",
  });
  const aggregate = JSON.parse(
    mustSquad(
      ["gate", "aggregate", "--task-dir", input.taskDir, "--candidate-sha", input.candidate],
      input.repo,
      input.env,
    ).stdout,
  ) as { approved?: boolean };
  expect(aggregate.approved).toBe(true);
}

function recordPassingGate(input: {
  taskDir: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  gateId: string;
  role: string;
  worktree: string;
  candidate: string;
  realism: string;
  runId: string;
}): void {
  const token = sessionToken(input.taskDir, `${input.gateId}-token`);
  const started = JSON.parse(
    mustSquad(
      [
        "run",
        "start",
        "--task-dir",
        input.taskDir,
        "--run-id",
        input.runId,
        "--role",
        input.role,
        "--purpose",
        "candidate_gate",
        "--gate-id",
        input.gateId,
        "--worktree",
        input.worktree,
        "--pid",
        String(process.pid),
        "--session-token-file",
        token,
      ],
      input.repo,
      input.env,
    ).stdout,
  ) as { attempt: number };
  const evidence = JSON.parse(
    mustSquad(
      [
        "evidence",
        "record",
        "--task-dir",
        input.taskDir,
        "--gate-id",
        input.gateId,
        "--command",
        "true",
        "--exit-code",
        "0",
        "--candidate-sha",
        input.candidate,
        "--realism-tier",
        input.realism,
        "--evidence-kind",
        "supervised",
        "--cwd",
        input.worktree,
        "--session-token-file",
        token,
      ],
      input.repo,
      input.env,
    ).stdout,
  ) as { evidence_id?: string };
  mustSquad(
    [
      "run",
      "finish",
      "--task-dir",
      input.taskDir,
      "--run-id",
      input.runId,
      "--attempt",
      String(started.attempt),
      "--session-token-file",
      token,
    ],
    input.repo,
    input.env,
  );
  mustSquad(
    [
      "gate",
      "record",
      "--task-dir",
      input.taskDir,
      "--gate-id",
      input.gateId,
      "--candidate-sha",
      input.candidate,
      "--verdict",
      "pass",
      "--role",
      input.role,
      "--realism-tier",
      input.realism,
      "--evidence-id",
      evidence.evidence_id ?? "",
    ],
    input.repo,
    input.env,
  );
}

function sessionToken(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function mustSquad(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { stdout: string; stderr: string } {
  const result = spawnSync(LIVE_SQUADCTL, [...args, "--json"], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${args.join(" ")} exited ${result.status}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function pushRemote(
  repo: string,
  taskDir: string,
  base: string,
  candidate: string,
  profile: string | object,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const profilePath =
    typeof profile === "string"
      ? profile
      : join(taskDir, "push-profile.json");
  if (typeof profile !== "string") writeFileSync(profilePath, JSON.stringify(profile));
  const result = spawnSync(
    LIVE_SQUADCTL,
    [
      "integrate",
      "push-remote",
      "--task-dir",
      taskDir,
      "--repo-root",
      repo,
      "--expected-old-sha",
      base,
      "--candidate-sha",
      candidate,
      "--profile",
      profilePath,
      "--json",
    ],
    { cwd: repo, env, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
