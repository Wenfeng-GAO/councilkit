import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import {
  CURSOR_REPAIR_MODEL,
  buildCursorRepairContract,
  cursorOrchestratorArgv,
  cursorRepairModelReceiptMatches,
} from "@shared/runtime/squad-repair-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { SquadctlBridge, parseOrchestratorReceipt } from "../src/auto/squadctl-bridge";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_CURSOR = join(FIXTURES, "fake-cursor-agent.mjs");
const FAKE_SQUADCTL = join(FIXTURES, "fake-squadctl.mjs");
const INSTALLED_SKILL =
  "/Users/hengzhuo/code/ant/hengzhuo-personal-skills/hengzhuo-engineering-squad";
const INSTALLED_SQUADCTL = join(INSTALLED_SKILL, "scripts", "squadctl");
const LOG_DIR = "/tmp/councilkit-cursor-runtime-20260922";

let roots: string[] = [];
const pids = new Set<number>();

afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  pids.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(root: string): { repo: string; sha: string } {
  const repo = join(root, "src");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "feat-x"]);
  git(repo, ["config", "user.email", "squad@example.com"]);
  git(repo, ["config", "user.name", "squad"]);
  writeFileSync(join(repo, "README.md"), "ok\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return { repo, sha: git(repo, ["rev-parse", "HEAD"]) };
}

function packageBody(sha: string) {
  return {
    schemaVersion: 1,
    kind: "councilkit-repair",
    source: {
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      sha,
      prUrl: "https://github.com/acme/repo/pull/1",
    },
    findings: [
      {
        id: "F-1",
        title: "example",
        severity: "major",
        rootCause: "F-1",
        invariant: "must hold",
        evidence: "src",
        files: ["README.md"],
      },
    ],
    constraints: { invariants: [], forbidden: [], acceptance: ["ok"], deferred: [] },
    convergence: { maxFixRounds: 3, repeatedRootCauseLimit: 2 },
  };
}

function delivery(sha: string) {
  return {
    grantHash: "a".repeat(64),
    repo: "github.com/acme/repo",
    sourceBranch: "feat-x",
    sourceSha: sha,
    expectedOldSha: sha,
    remote: "origin",
    parentRunId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    newRepairChain: true,
  };
}

describe("cursor repair runtime", () => {
  it("spawns cursor argv, imports the role contract, and resumes the same session", async () => {
    chmodSync(FAKE_CURSOR, 0o755);
    chmodSync(FAKE_SQUADCTL, 0o755);
    const root = tempRoot("ck-cursor-runtime-");
    const { repo, sha } = initRepo(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const pkg = join(root, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const argvLog = join(root, "squadctl-argv.log");
    const cursorArgv = join(root, "cursor-argv.log");
    const cursorStdin = join(root, "cursor-stdin.txt");
    const bridge = new SquadctlBridge({
      home,
      workspaceCwd: repo,
      executable: FAKE_SQUADCTL,
      orchestratorExecutable: FAKE_CURSOR,
      sessionWaitMs: 3_000,
      env: {
        ...process.env,
        HOME: home,
        COUNCILKIT_HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_SQUADCTL_ARGV: argvLog,
        FAKE_CURSOR_ARGV: cursorArgv,
        FAKE_CURSOR_STDIN: cursorStdin,
      },
    });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery: delivery(sha),
      baseSha: sha,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    await bridge.prepare({
      taskId: started.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery: delivery(sha),
    });
    const identity = JSON.parse(
      readFileSync(join(home, "squad-tasks", started.taskId, "councilkit-bridge.json"), "utf8"),
    ) as {
      requestedRuntime: string;
      model: string;
      observedModel: string | null;
      nativeSession: string | null;
      requestedSession: string | null;
      actualRuntime: string | null;
      orchestratorPid: number | null;
    };
    if (identity.orchestratorPid) pids.add(identity.orchestratorPid);
    expect(identity.requestedRuntime).toBe("cursor");
    expect(identity.model).toBe(CURSOR_REPAIR_MODEL);
    expect(identity.observedModel).toBe("Grok 4.7 500K Extra High");
    expect(identity.observedModel).not.toBe(identity.model);
    expect(identity.nativeSession).toBe("cursor-native-1");
    expect(identity.nativeSession).not.toBe(identity.requestedSession);
    expect(identity.actualRuntime).toBe("fake-cursor-agent.mjs");
    const initLine = readFileSync(argvLog, "utf8")
      .split("\n")
      .find((line) => line.startsWith("init "));
    expect(initLine).toContain("--contract");
    const initParts = initLine?.split(" ") ?? [];
    const contractPath = initParts[initParts.indexOf("--contract") + 1] ?? "";
    expect(contractPath.endsWith(".runtime-contract.json")).toBe(true);
    expect(contractPath.includes(`${started.taskId}/`)).toBe(false);
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
      roles: Record<string, { runtime?: string; model?: string; mode?: string; sandbox?: string; permission_mode?: string }>;
    };
    for (const role of ["orchestrator", "planner_a", "planner_b", "coder", "reviewer", "verifier"]) {
      expect(contract.roles[role]?.runtime).toBe("cursor");
      expect(contract.roles[role]?.model).toBe(CURSOR_REPAIR_MODEL);
    }
    expect(contract.roles.reviewer?.mode).toBeUndefined();
    expect(contract.roles.reviewer?.sandbox).toBe("read-only");
    expect(contract.roles.verifier?.mode).toBeUndefined();
    expect(contract.roles.verifier?.sandbox).toBe("workspace-write");
    expect(contract.roles.planner_b?.mode).toBeUndefined();
    expect(contract.roles.coder?.permission_mode).toBe("unrestricted-local");
    const launched = readFileSync(cursorArgv, "utf8").trim().split("\n")[0] ?? "";
    expect(launched).toContain("--print");
    expect(launched).toContain("--output-format stream-json");
    expect(launched).toContain(`--model ${CURSOR_REPAIR_MODEL}`);
    expect(launched).not.toContain("--always-approve");
    expect(launched).not.toContain("--leader-socket");
    expect(launched).not.toContain("--session-id");
    expect(launched).not.toContain("--prompt-file");
    expect(launched).not.toContain("streaming-messages-json");
    expect(launched).not.toContain("grok-4.7-xhigh");
    expect(readFileSync(cursorStdin, "utf8")).toContain("independent adapter run");
    bridge.stop({ taskId: started.taskId });
    await bridge.resume({ taskId: started.taskId });
    const resumed = JSON.parse(
      readFileSync(join(home, "squad-tasks", started.taskId, "councilkit-bridge.json"), "utf8"),
    ) as { nativeSession: string | null; orchestratorPid: number | null; model: string };
    if (resumed.orchestratorPid) pids.add(resumed.orchestratorPid);
    expect(resumed.nativeSession).toBe("cursor-native-1");
    expect(resumed.model).toBe(CURSOR_REPAIR_MODEL);
    const second = readFileSync(cursorArgv, "utf8").trim().split("\n")[1] ?? "";
    expect(second).toContain("--resume cursor-native-1");
    expect(second).toContain(`--model ${CURSOR_REPAIR_MODEL}`);
    expect(second).not.toContain("--session-id");
    bridge.stop({ taskId: started.taskId });
  }, 20_000);

  it("rejects a 256k receipt and does not store it as the requested model", async () => {
    chmodSync(FAKE_CURSOR, 0o755);
    chmodSync(FAKE_SQUADCTL, 0o755);
    const root = tempRoot("ck-cursor-mismatch-");
    const { repo, sha } = initRepo(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const pkg = join(root, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const bridge = new SquadctlBridge({
      home,
      workspaceCwd: repo,
      executable: FAKE_SQUADCTL,
      orchestratorExecutable: FAKE_CURSOR,
      sessionWaitMs: 3_000,
      env: {
        ...process.env,
        HOME: home,
        COUNCILKIT_HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_CURSOR_MODEL: "grok-4.7-xhigh",
      },
    });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      baseSha: sha,
      delivery: delivery(sha),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    await expect(
      bridge.prepare({
        taskId: started.taskId,
        baseSha: sha,
        packagePath: pkg,
        delivery: delivery(sha),
      }),
    ).rejects.toThrow(/grok-4\.7-xhigh/);
    const identity = JSON.parse(
      readFileSync(join(home, "squad-tasks", started.taskId, "councilkit-bridge.json"), "utf8"),
    ) as { model: string; observedModel: string | null; executionStatus: string; orchestratorPid: number | null };
    if (identity.orchestratorPid) pids.add(identity.orchestratorPid);
    expect(identity.executionStatus).toBe("failed");
    expect(identity.model).toBe(CURSOR_REPAIR_MODEL);
    expect(identity.observedModel).toBe("grok-4.7-xhigh");
  }, 20_000);

  it("does not resume a frozen grok session with cursor", async () => {
    chmodSync(FAKE_CURSOR, 0o755);
    chmodSync(FAKE_SQUADCTL, 0o755);
    const root = tempRoot("ck-cursor-nocrash-");
    const { repo, sha } = initRepo(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const pkg = join(root, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const cursorArgv = join(root, "cursor-argv.log");
    const bridge = new SquadctlBridge({
      home,
      workspaceCwd: repo,
      executable: FAKE_SQUADCTL,
      orchestratorExecutable: FAKE_CURSOR,
      sessionWaitMs: 2_000,
      env: {
        ...process.env,
        HOME: home,
        COUNCILKIT_HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_CURSOR_ARGV: cursorArgv,
      },
    });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      baseSha: sha,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    const taskDir = join(home, "squad-tasks", started.taskId);
    const squadTaskId = "20260922-repair-ab12";
    writeFileSync(join(taskDir, "events.jsonl"), `${JSON.stringify({ type: "init", epoch: 1 })}\n`);
    writeFileSync(
      join(taskDir, "state.json"),
      `${JSON.stringify({ epoch: 1, task_id: squadTaskId, phase: "briefing" })}\n`,
    );
    writeFileSync(
      join(taskDir, "councilkit-bridge.json"),
      `${JSON.stringify({
        taskId: started.taskId,
        squadTaskId,
        taskDir,
        workspaceCwd: repo,
        requestedRuntime: "grokb",
        actualRuntime: "grokb",
        model: "grok-4.6",
        observedModel: null,
        requestedSession: "grok-session-1",
        nativeSession: "grok-session-1",
        orchestratorPid: null,
        writerPids: [],
        skillVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
        toolVersion: null,
        skillDir: null,
        squadctlPath: FAKE_SQUADCTL,
        packagePath: pkg,
        delivery: null,
        stopped: true,
        executionStatus: "stopped",
        failReason: null,
        process: null,
        processGroup: [],
        observedExitCode: null,
        observedSignal: null,
        executionId: null,
      })}\n`,
    );
    await expect(
      bridge.prepare({ taskId: started.taskId, baseSha: sha, packagePath: pkg }),
    ).rejects.toThrow(/refusing to resume grokb/);
    expect(existsSync(cursorArgv)).toBe(false);
  }, 20_000);

  it("puts an explicit reviewer override into the official contract and keeps the builder on 500k", async () => {
    chmodSync(FAKE_CURSOR, 0o755);
    chmodSync(FAKE_SQUADCTL, 0o755);
    const root = tempRoot("ck-cursor-reviewer-");
    const { repo, sha } = initRepo(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    writeFileSync(
      join(home, "squad-bridge.json"),
      `${JSON.stringify({
        roles: {
          reviewer: { runtime: "codex", model: "gpt-5.6-sol" },
          verifier: { runtime: "cursor", model: "composer-2.5" },
        },
      })}\n`,
    );
    const pkg = join(root, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const argvLog = join(root, "squadctl-argv.log");
    const cursorArgv = join(root, "cursor-argv.log");
    const bridge = new SquadctlBridge({
      home,
      workspaceCwd: repo,
      executable: FAKE_SQUADCTL,
      orchestratorExecutable: FAKE_CURSOR,
      sessionWaitMs: 3_000,
      env: {
        ...process.env,
        HOME: home,
        COUNCILKIT_HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_SQUADCTL_ARGV: argvLog,
        FAKE_CURSOR_ARGV: cursorArgv,
      },
    });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery: delivery(sha),
      baseSha: sha,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    await bridge.prepare({
      taskId: started.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery: delivery(sha),
    });
    const identity = JSON.parse(
      readFileSync(join(home, "squad-tasks", started.taskId, "councilkit-bridge.json"), "utf8"),
    ) as { model: string; orchestratorPid: number | null };
    if (identity.orchestratorPid) pids.add(identity.orchestratorPid);
    expect(identity.model).toBe(CURSOR_REPAIR_MODEL);
    const initLine = readFileSync(argvLog, "utf8")
      .split("\n")
      .find((line) => line.startsWith("init "));
    const parts = initLine?.split(" ") ?? [];
    const contract = JSON.parse(readFileSync(parts[parts.indexOf("--contract") + 1] ?? "", "utf8")) as {
      roles: Record<string, { runtime?: string; model?: string; mode?: string }>;
    };
    expect(contract.roles.orchestrator?.model).toBe(CURSOR_REPAIR_MODEL);
    expect(contract.roles.coder?.model).toBe(CURSOR_REPAIR_MODEL);
    expect(contract.roles.coder?.mode).toBe("main-session");
    expect(contract.roles.reviewer).toEqual({ runtime: "codex", model: "gpt-5.6-sol", sandbox: "read-only" });
    expect(contract.roles.verifier?.model).toBe("composer-2.5");
    expect(contract.roles.verifier?.mode).toBeUndefined();
    expect(readFileSync(cursorArgv, "utf8")).toContain(`--model ${CURSOR_REPAIR_MODEL}`);
    bridge.stop({ taskId: started.taskId });
  }, 20_000);
});

describe.skipIf(!existsSync(INSTALLED_SQUADCTL))("installed squadctl cursor contract", () => {
  it("imports cursor role bindings through squadctl init --contract", () => {
    const root = tempRoot("ck-cursor-contract-");
    const { repo, sha } = initRepo(root);
    const taskDir = join(root, "task");
    mkdirSync(taskDir, { mode: 0o700 });
    const contractPath = join(root, "contract.json");
    const contract = buildCursorRepairContract({
      contractId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-09-22T00:00:00.000Z",
    });
    writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    const env = { ...process.env, COUNCILKIT_HOME: join(root, "ckhome") };
    mkdirSync(env.COUNCILKIT_HOME, { recursive: true });
    execFileSync(
      INSTALLED_SQUADCTL,
      [
        "init",
        "--task-dir",
        taskDir,
        "--task-id",
        "20260922-repair-c500",
        "--base-sha",
        sha,
        "--owner",
        "councilkit",
        "--repo",
        repo,
        "--allow-behind-origin",
        "--no-observe",
        "--contract",
        contractPath,
        "--json",
      ],
      { cwd: repo, env, encoding: "utf8" },
    );
    const shown = execFileSync(
      INSTALLED_SQUADCTL,
      ["runtime", "show", "--task-dir", taskDir, "--json"],
      { cwd: repo, env, encoding: "utf8" },
    );
    const payload = JSON.parse(shown) as {
      contract: { roles: Record<string, { runtime?: string; model?: string; mode?: string; sandbox?: string }> };
    };
    expect(payload.contract.roles.orchestrator).toMatchObject({
      runtime: "cursor",
      model: CURSOR_REPAIR_MODEL,
      mode: "main-session",
    });
    expect(payload.contract.roles.planner_a?.model).toBe(CURSOR_REPAIR_MODEL);
    expect(payload.contract.roles.coder?.model).toBe(CURSOR_REPAIR_MODEL);
    expect(payload.contract.roles.planner_b).toMatchObject({
      runtime: "cursor",
      model: CURSOR_REPAIR_MODEL,
      sandbox: "read-only",
    });
    expect(payload.contract.roles.planner_b?.mode).toBeUndefined();
    expect(payload.contract.roles.reviewer).toMatchObject({
      runtime: "cursor",
      model: CURSOR_REPAIR_MODEL,
      sandbox: "read-only",
    });
    expect(payload.contract.roles.reviewer?.mode).toBeUndefined();
    expect(payload.contract.roles.verifier).toMatchObject({
      runtime: "cursor",
      model: CURSOR_REPAIR_MODEL,
      sandbox: "workspace-write",
    });
    expect(payload.contract.roles.verifier?.mode).toBeUndefined();
  });
});

describe.skipIf(process.env.COUNCILKIT_CURSOR_SMOKE !== "1")("real cursor squad smoke", () => {
  it("captures a Cursor session and the 500k model, then resumes it", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    const root = tempRoot("ck-cursor-smoke-");
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync("/Users/hengzhuo/.local/bin/cursor-agent", join(bin, "cursor-agent"));
    const home = join(root, "home");
    mkdirSync(home);
    const ckHome = join(root, "ckhome");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      COUNCILKIT_HOME: ckHome,
      PATH: `${bin}:/usr/bin:/bin`,
      COUNCILKIT_SQUADCTL: INSTALLED_SQUADCTL,
      COUNCILKIT_SQUAD_SKILL: INSTALLED_SKILL,
    };
    delete env.COUNCILKIT_GROKB;
    delete env.COUNCILKIT_ORCHESTRATOR_RUNTIME;
    delete env.COUNCILKIT_CURSOR_MODEL;
    mkdirSync(ckHome, { recursive: true });
    const { probeSquadBridge } = await import("@shared/runtime/squad-bridge-discovery");
    const probe = probeSquadBridge(env);
    expect(probe.available).toBe(true);
    expect(probe.orchestrator?.requestedRuntime).toBe("cursor");
    expect(probe.orchestrator?.model).toBe(CURSOR_REPAIR_MODEL);
    const { repo, sha } = initRepo(root);
    const taskDir = join(root, "task");
    mkdirSync(taskDir, { mode: 0o700 });
    const contract = buildCursorRepairContract({
      contractId: "22222222-2222-4222-8222-222222222222",
      createdAt: new Date().toISOString(),
    });
    const contractPath = join(root, "contract.json");
    writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    execFileSync(
      INSTALLED_SQUADCTL,
      [
        "init",
        "--task-dir",
        taskDir,
        "--task-id",
        "20260922-repair-s500",
        "--base-sha",
        sha,
        "--owner",
        "councilkit",
        "--repo",
        repo,
        "--allow-behind-origin",
        "--no-observe",
        "--contract",
        contractPath,
        "--json",
      ],
      { cwd: repo, env, encoding: "utf8" },
    );
    const shown = JSON.parse(
      execFileSync(INSTALLED_SQUADCTL, ["runtime", "show", "--task-dir", taskDir, "--json"], {
        cwd: repo,
        env,
        encoding: "utf8",
      }),
    ) as { contract: { roles: Record<string, { runtime?: string; model?: string }> } };
    const cursor = probe.orchestrator?.executable ?? join(bin, "cursor-agent");
    const firstArgv = cursorOrchestratorArgv({
      workspace: repo,
      model: CURSOR_REPAIR_MODEL,
      resumeSession: null,
    });
    const first = await runCursor(cursor, firstArgv, repo, "Reply with exactly OK. Do not use tools or edit files.\n");
    expect(cursorRepairModelReceiptMatches(first.model ?? "")).toBe(true);
    expect(first.sessionId).toBeTruthy();
    const secondArgv = cursorOrchestratorArgv({
      workspace: repo,
      model: CURSOR_REPAIR_MODEL,
      resumeSession: first.sessionId,
    });
    const second = await runCursor(cursor, secondArgv, repo, "Reply with exactly OK. Do not use tools or edit files.\n");
    expect(second.sessionId).toBe(first.sessionId);
    expect(cursorRepairModelReceiptMatches(second.model ?? "")).toBe(true);
    const record = {
      runtime: probe.orchestrator?.requestedRuntime,
      requestedModel: CURSOR_REPAIR_MODEL,
      observedModel: first.model,
      resumedModel: second.model,
      nativeSession: first.sessionId,
      resumedSession: second.sessionId,
      argv: firstArgv,
      resumeArgv: secondArgv,
      officialRoleBindings: shown.contract.roles,
      skill: INSTALLED_SKILL,
    };
    writeFileSync(join(LOG_DIR, "smoke.json"), `${JSON.stringify(record, null, 2)}\n`);
    expect(shown.contract.roles.reviewer?.runtime).toBe("cursor");
    expect(shown.contract.roles.verifier?.model).toBe(CURSOR_REPAIR_MODEL);
  }, 180_000);
});

function runCursor(
  executable: string,
  argv: string[],
  cwd: string,
  prompt: string,
): Promise<{ sessionId: string | null; model: string | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd,
      env: process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) pids.add(child.pid);
    let stdout = "";
    const timer = setTimeout(() => {
      finish(new Error(`cursor smoke timed out: ${stdout.slice(0, 500)}`));
    }, 90_000);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
      }
      if (error) reject(error);
      else resolve({ ...parseOrchestratorReceipt(stdout), stdout });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const receipt = parseOrchestratorReceipt(stdout);
      if (receipt.sessionId && receipt.model) finish();
    });
    child.on("error", (error) => finish(error));
    child.stdin?.end(prompt);
  });
}
