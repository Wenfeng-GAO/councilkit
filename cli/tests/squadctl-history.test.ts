import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import {
  SQUAD_HISTORY_BRIDGE_CONTRACT,
  parseHistoryCapabilities,
  parseHistoryEnvelope,
} from "@shared/runtime/squad-history-bridge";
import { afterEach, describe, expect, it } from "vitest";
import { SquadctlBridge } from "../src/auto/squadctl-bridge";
import { probeAndVerifySquadBridge } from "../src/auto/squadctl-verify";
import { HAS_LIVE_SQUADCTL, LIVE_SKILL_DIR, LIVE_SQUADCTL } from "./helpers/live-squadctl";

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const FAKE_GROKB = join(FIXTURES, "fixtures", "fake-grokb.mjs");
const AUTH = "a".repeat(64);
const PARENT = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REPO = "github.com/acme/repo";

const historyEnv: NodeJS.ProcessEnv = {
  ...process.env,
  COUNCILKIT_SQUADCTL: LIVE_SQUADCTL,
  COUNCILKIT_SQUAD_SKILL: LIVE_SKILL_DIR,
};

const historyProbe = HAS_LIVE_SQUADCTL ? probeAndVerifySquadBridge(historyEnv) : null;
const HAS_HISTORY_BRIDGE = historyProbe?.historyContract === SQUAD_HISTORY_BRIDGE_CONTRACT;

let homes: string[] = [];
afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ck-squad-history-"));
  homes.push(home);
  chmodSync(FAKE_GROKB, 0o755);
  return home;
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

function makeBridge(home: string, workspace: string) {
  return new SquadctlBridge({
    home,
    workspaceCwd: workspace,
    executable: LIVE_SQUADCTL,
    orchestratorExecutable: FAKE_GROKB,
    env: { ...historyEnv, HOME: home, COUNCILKIT_HOME: home },
  });
}

function delivery(sha: string, extra: Record<string, unknown> = {}) {
  return {
    grantHash: AUTH,
    repo: REPO,
    sourceBranch: "feat-x",
    sourceSha: sha,
    expectedOldSha: sha,
    remote: "origin",
    parentRunId: PARENT,
    ...extra,
  };
}

function identityOf(home: string, taskId: string) {
  return JSON.parse(
    readFileSync(join(home, "squad-tasks", taskId, "councilkit-bridge.json"), "utf8"),
  ) as {
    squadTaskId: string;
    taskDir: string;
  };
}

function convergence(taskDir: string) {
  const result = spawnSync(LIVE_SQUADCTL, ["convergence", "--task-dir", taskDir, "--json"], {
    encoding: "utf8",
    env: historyEnv,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    historyCompleteness?: string;
    inheritedFixRounds?: number | null;
    fixRounds?: number;
  };
}

describe("squad history capabilities", () => {
  it("parses the official capabilities JSON and rejects incomplete objects", () => {
    expect(
      parseHistoryCapabilities({
        schema_version: 1,
        contract: SQUAD_HISTORY_BRIDGE_CONTRACT,
        export: true,
        verified_origin_mapping: true,
        persisted_origins: true,
      }),
    ).not.toBeNull();
    expect(
      parseHistoryCapabilities({ contract: SQUAD_HISTORY_BRIDGE_CONTRACT, export: true }),
    ).toBeNull();
    expect(
      parseHistoryCapabilities({ schema_version: 1, contract: "other", export: true }),
    ).toBeNull();
  });
});

describe.skipIf(!HAS_LIVE_SQUADCTL)("live squadctl history contract", () => {
  it("reads history capabilities from the env-selected squadctl", () => {
    const probe = probeAndVerifySquadBridge(historyEnv);
    expect(probe.available).toBe(true);
    if (HAS_HISTORY_BRIDGE) {
      expect(probe.historyContract).toBe(SQUAD_HISTORY_BRIDGE_CONTRACT);
    } else {
      expect(probe.historyContract).toBeNull();
      expect(probe.reason).toMatch(/squad-history-bridge\.v1|升级/);
    }
  });
});

describe.skipIf(!HAS_HISTORY_BRIDGE)("real A→B→C history transfer", () => {
  it("exports verified history and intakes the next task with frozen origins", async () => {
    const home = tempHome();
    const { repo, sha } = initRepo(home);
    const pkg = join(home, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const bridge = makeBridge(home, repo);
    const first = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery: delivery(sha, { newRepairChain: true }),
      baseSha: sha,
    });
    if (!first.ok) throw new Error("start A failed");
    await bridge.prepare({
      taskId: first.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery: delivery(sha, { newRepairChain: true }),
    });
    bridge.stop({ taskId: first.taskId });
    const idA = identityOf(home, first.taskId);
    expect(convergence(idA.taskDir).historyCompleteness).toBe("verified");
    expect(convergence(idA.taskDir).inheritedFixRounds).toBe(0);
    const exportedA = bridge.exportHistory({
      taskId: first.taskId,
      allowedOrigins: [{ journalTaskId: idA.squadTaskId, taskDir: idA.taskDir }],
      projectId: REPO,
      repairChainId: PARENT,
    });
    const envelopeA = parseHistoryEnvelope(exportedA.envelope);
    expect(envelopeA?.complete).toBe(true);
    expect(envelopeA?.history.entries[0]?.logical_rounds).toEqual([]);
    expect(exportedA.hash).toMatch(/^[a-f0-9]{64}$/);

    const second = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery: delivery(sha, {
        newRepairChain: false,
        previousTaskId: first.taskId,
        previousTaskDir: idA.taskDir,
        historyExportPath: exportedA.historyPath,
      }),
      baseSha: sha,
    });
    if (!second.ok) throw new Error("start B failed");
    await bridge.prepare({
      taskId: second.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery: delivery(sha, {
        newRepairChain: false,
        previousTaskId: first.taskId,
        previousTaskDir: idA.taskDir,
        historyExportPath: exportedA.historyPath,
      }),
    });
    bridge.stop({ taskId: second.taskId });
    const idB = identityOf(home, second.taskId);
    expect(convergence(idB.taskDir).historyCompleteness).toBe("verified");

    const exportedB = bridge.exportHistory({
      taskId: second.taskId,
      allowedOrigins: [
        { journalTaskId: idA.squadTaskId, taskDir: idA.taskDir },
        { journalTaskId: idB.squadTaskId, taskDir: idB.taskDir },
      ],
      projectId: REPO,
      repairChainId: PARENT,
    });
    const envelopeB = parseHistoryEnvelope(exportedB.envelope);
    expect(envelopeB?.origins.length).toBeGreaterThanOrEqual(2);

    const third = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery: delivery(sha, {
        newRepairChain: false,
        previousTaskId: second.taskId,
        previousTaskDir: idB.taskDir,
        historyExportPath: exportedB.historyPath,
      }),
      baseSha: sha,
    });
    if (!third.ok) throw new Error("start C failed");
    await bridge.prepare({
      taskId: third.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery: delivery(sha, {
        newRepairChain: false,
        previousTaskId: second.taskId,
        previousTaskDir: idB.taskDir,
        historyExportPath: exportedB.historyPath,
      }),
    });
    bridge.stop({ taskId: third.taskId });
    expect(convergence(identityOf(home, third.taskId).taskDir).historyCompleteness).toBe(
      "verified",
    );
  }, 60_000);

  it("rejects wrong project, missing origin, swapped directory, and mutated journal", async () => {
    const home = tempHome();
    const { repo, sha } = initRepo(home);
    const pkg = join(home, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const bridge = makeBridge(home, repo);
    const first = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery: delivery(sha, { newRepairChain: true }),
      baseSha: sha,
    });
    if (!first.ok) throw new Error("start failed");
    await bridge.prepare({
      taskId: first.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery: delivery(sha, { newRepairChain: true }),
    });
    bridge.stop({ taskId: first.taskId });
    const idA = identityOf(home, first.taskId);
    const exported = bridge.exportHistory({
      taskId: first.taskId,
      allowedOrigins: [{ journalTaskId: idA.squadTaskId, taskDir: idA.taskDir }],
      projectId: REPO,
      repairChainId: PARENT,
    });

    expect(() =>
      bridge.exportHistory({
        taskId: first.taskId,
        allowedOrigins: [{ journalTaskId: idA.squadTaskId, taskDir: idA.taskDir }],
        projectId: "github.com/other/repo",
        repairChainId: PARENT,
      }),
    ).toThrow(/project_id/);

    const missing = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery: delivery(sha, { newRepairChain: false, previousTaskId: first.taskId }),
      baseSha: sha,
    });
    if (!missing.ok) throw new Error("start failed");
    await expect(
      bridge.prepare({
        taskId: missing.taskId,
        baseSha: sha,
        packagePath: pkg,
        delivery: delivery(sha, { newRepairChain: false, previousTaskId: first.taskId }),
      }),
    ).rejects.toThrow(/history export|origin/);

    const swappedDir = join(home, "not-owned");
    mkdirSync(swappedDir);
    expect(() =>
      bridge.exportHistory({
        taskId: first.taskId,
        allowedOrigins: [{ journalTaskId: idA.squadTaskId, taskDir: swappedDir }],
        projectId: REPO,
        repairChainId: PARENT,
      }),
    ).toThrow(/origin|outside|match/);

    writeFileSync(join(idA.taskDir, "source-package.json"), "{}\n");
    const mutated = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery: delivery(sha, {
        newRepairChain: false,
        previousTaskId: first.taskId,
        historyExportPath: exported.historyPath,
      }),
      baseSha: sha,
    });
    if (!mutated.ok) throw new Error("start failed");
    await expect(
      bridge.prepare({
        taskId: mutated.taskId,
        baseSha: sha,
        packagePath: pkg,
        delivery: delivery(sha, {
          newRepairChain: false,
          previousTaskId: first.taskId,
          historyExportPath: exported.historyPath,
        }),
      }),
    ).rejects.toThrow();
  }, 60_000);
});
