import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionIntent, markExecutionStarted } from "@shared/runtime/repair-execution";
import { probeIsolationCapability } from "@shared/runtime/repair-isolation";
import { describe, expect, it } from "vitest";
import {
  superviseDeadlineOnce,
  writeExecutionRecord,
} from "../src/auto/repair-deadline-supervisor";
import {
  detectIsolationCapability,
  disableCandidateGitHooksEnv,
  publishGitArgv,
  runIsolatedCommand,
  stripCredentialEnv,
} from "../src/auto/repair-isolated-run";

const SHA = "a".repeat(40);

describe("deadline supervisor", () => {
  it("kills recorded pids when the deadline is due", () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const running = markExecutionStarted(
      createExecutionIntent({
        executionId: "exec-dead",
        kind: "source_fix",
        chainId: "ck-chain-1",
        parentRunId: "ck-repair-1",
        inputSha: SHA,
        contractVersion: 1,
        deadlineAtMs: 10,
      }),
      [4242],
      1,
    );
    const next = superviseDeadlineOnce({
      execution: running,
      nowMs: 10,
      kill: (pid, signal) => {
        killed.push({ pid, signal });
      },
      isPidAlive: () => true,
    });
    expect(next.state).toBe("unknown_writer");
    expect(killed).toEqual([
      { pid: 4242, signal: "SIGTERM" },
      { pid: 4242, signal: "SIGKILL" },
    ]);
  });

  it("does not certify deadline enforced when stop throws and the pid stays alive", () => {
    const running = markExecutionStarted(
      createExecutionIntent({
        executionId: "exec-stop-fail",
        kind: "source_fix",
        chainId: "ck-chain-1",
        parentRunId: "ck-repair-1",
        inputSha: SHA,
        contractVersion: 1,
        deadlineAtMs: 10,
      }),
      [999999],
      1,
    );
    let signalAttempts = 0;
    const next = superviseDeadlineOnce({
      execution: running,
      nowMs: 11,
      isPidAlive: () => true,
      kill: () => {
        signalAttempts += 1;
        throw new Error("simulated stop failed");
      },
    });
    expect(next.state).toBe("unknown_writer");
    expect(signalAttempts).toBeGreaterThan(0);
  });

  it("certifies deadline enforced only after recorded pids are confirmed dead", () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const running = markExecutionStarted(
      createExecutionIntent({
        executionId: "exec-dead-ok",
        kind: "source_fix",
        chainId: "ck-chain-1",
        parentRunId: "ck-repair-1",
        inputSha: SHA,
        contractVersion: 1,
        deadlineAtMs: 10,
      }),
      [4242],
      1,
    );
    const next = superviseDeadlineOnce({
      execution: running,
      nowMs: 10,
      kill: (pid, signal) => {
        killed.push({ pid, signal });
      },
      isPidAlive: () => false,
    });
    expect(next.state).toBe("deadline_enforced");
    expect(killed).toEqual([]);
  });

  it("persists an execution record for later takeover", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-exec-"));
    const path = join(dir, "exec.json");
    const intent = createExecutionIntent({
      executionId: "exec-persist",
      kind: "source_fix",
      chainId: "ck-chain-1",
      parentRunId: "ck-repair-1",
      inputSha: SHA,
      contractVersion: 1,
      deadlineAtMs: 99,
    });
    writeExecutionRecord(path, intent);
    expect(JSON.parse(readFileSync(path, "utf8")).executionId).toBe("exec-persist");
  });

  it("enforces the deadline from a detached supervisor after the parent exits", async () => {
    const sleeper = spawn("sleep", ["20"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    const pid = sleeper.pid;
    expect(typeof pid).toBe("number");
    const dir = mkdtempSync(join(tmpdir(), "ck-dead-parent-"));
    const executionPath = join(dir, "exec.json");
    const fakeCli = join(dir, "fake-cli.mjs");
    const parentJs = join(dir, "parent.mjs");
    writeFileSync(
      fakeCli,
      `import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[process.argv.indexOf("--execution") + 1];
function tick() {
  const rec = JSON.parse(readFileSync(path, "utf8"));
  if (Date.now() >= rec.deadlineAtMs && rec.state !== "deadline_enforced") {
    for (const child of rec.pids) {
      try { process.kill(child, "SIGTERM"); } catch {}
    }
    rec.state = "deadline_enforced";
    rec.result = "cancelled";
    rec.endedAtMs = Date.now();
    writeFileSync(path, JSON.stringify(rec));
    process.exit(0);
  }
  setTimeout(tick, 40);
}
tick();
`,
    );
    writeFileSync(
      parentJs,
      `import { spawn } from "node:child_process";
const child = spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: "ignore" });
child.unref();
process.exit(0);
`,
    );
    writeExecutionRecord(
      executionPath,
      markExecutionStarted(
        createExecutionIntent({
          executionId: "exec-orphan",
          kind: "source_fix",
          chainId: "ck-chain-1",
          parentRunId: "ck-repair-1",
          inputSha: SHA,
          contractVersion: 1,
          deadlineAtMs: Date.now() + 300,
        }),
        [pid as number],
        Date.now(),
      ),
    );
    const parent = spawn(
      process.execPath,
      [parentJs, fakeCli, "repair", "supervise-deadline", "--execution", executionPath],
      { stdio: "ignore" },
    );
    await new Promise((resolve, reject) => {
      parent.on("exit", (code) =>
        code === 0 ? resolve(undefined) : reject(new Error(`parent ${code}`)),
      );
    });
    const started = Date.now();
    while (Date.now() - started < 4000) {
      try {
        process.kill(pid as number, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        expect(JSON.parse(readFileSync(executionPath, "utf8")).state).toBe("deadline_enforced");
        return;
      }
    }
    try {
      process.kill(pid as number, "SIGKILL");
    } catch {
      // already gone
    }
    throw new Error("deadline supervisor did not stop the sleeper after parent exit");
  }, 10_000);
});

describe("isolated runner env", () => {
  it("strips credential sockets and tokens from verifier env", () => {
    const stripped = stripCredentialEnv({
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh",
      GH_TOKEN: "secret",
      HOME: "/tmp/home",
    });
    expect(stripped.SSH_AUTH_SOCK).toBeUndefined();
    expect(stripped.GH_TOKEN).toBeUndefined();
    expect(stripped.HOME).toBe("/tmp/home");
  });

  it("disables git hooks for publish argv", () => {
    expect(publishGitArgv(["push", "origin", "HEAD"])).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "origin",
      "HEAD",
    ]);
  });

  it("injects hooksPath via env instead of editing the global git config", () => {
    const env = disableCandidateGitHooksEnv({ PATH: "/usr/bin" });
    expect(env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/dev/null");
  });
});

describe("strong isolation of candidate code", () => {
  it("refuses strong mode when the OS sandbox is unavailable", () => {
    const capability = probeIsolationCapability("linux", false);
    expect(capability.sandboxExec).toBe(false);
    expect(capability.canDenyControlPlaneWrite).toBe(false);
  });

  it("prevents candidate tests from writing the control plane or reading credentials", async () => {
    const capability = detectIsolationCapability();
    if (!capability.sandboxExec) {
      expect(capability.canDenyControlPlaneWrite).toBe(false);
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "ck-iso-"));
    const worktree = join(root, "candidate");
    const control = join(root, "control-plane");
    const secrets = join(root, "secrets");
    const outputDir = join(root, "out");
    const tmpDir = join(root, "tmp");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(control, { recursive: true });
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(secrets, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(join(secrets, ".ssh", "id_rsa"), "secret-key\n", { mode: 0o600 });
    writeFileSync(join(control, "ledger.json"), `${JSON.stringify({ ok: true })}\n`);
    const probe = join(worktree, "probe.sh");
    writeFileSync(
      probe,
      `#!/bin/sh
set -eu
export HOME="${secrets}"
if echo hijack > "${control}/ledger.json"; then echo WROTE_CONTROL; fi
if cat "$HOME/.ssh/id_rsa" >/dev/null 2>&1; then echo READ_SECRET; fi
if git push origin HEAD >/tmp/ck-iso-push 2>/dev/null; then echo PUSHED; fi
echo DONE
`,
      { mode: 0o700 },
    );
    const result = await runIsolatedCommand({
      mode: "strong",
      capability,
      executable: "/bin/sh",
      argv: [probe],
      cwd: worktree,
      outputDir,
      tmpDir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: secrets,
        SSH_AUTH_SOCK: join(secrets, "agent.sock"),
        GH_TOKEN: "should-be-stripped",
      },
    });
    const ledger = readFileSync(join(control, "ledger.json"), "utf8");
    expect(ledger).toBe(`${JSON.stringify({ ok: true })}\n`);
    expect(result.stdout).not.toMatch(/WROTE_CONTROL/);
    expect(result.stdout).not.toMatch(/READ_SECRET/);
    expect(result.stdout).not.toMatch(/PUSHED/);
    expect(existsSync("/tmp/ck-iso-push")).toBe(false);
  });

  it("denies dummy gh publish credentials outside the candidate worktree", async () => {
    const capability = detectIsolationCapability();
    if (!capability.sandboxExec) return;
    const root = mkdtempSync(join(tmpdir(), "ck-iso-gh-"));
    const worktree = join(root, "worktree");
    const fakeHome = join(root, "private-home");
    mkdirSync(worktree);
    mkdirSync(join(fakeHome, ".config", "gh"), { recursive: true });
    const credential = join(fakeHome, ".config", "gh", "hosts.yml");
    writeFileSync(credential, "DUMMY_ACCEPTANCE_SENTINEL\n");
    const result = await runIsolatedCommand({
      mode: "strong",
      capability,
      executable: "/bin/cat",
      argv: [credential],
      cwd: worktree,
      outputDir: join(root, "out"),
      tmpDir: join(root, "tmp"),
      allowNetwork: true,
      env: { ...process.env, HOME: fakeHome, PATH: "/usr/bin:/bin" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("DUMMY_ACCEPTANCE_SENTINEL");
  });
});
