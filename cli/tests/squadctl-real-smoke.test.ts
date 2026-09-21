import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQUAD_BRIDGE_CONTRACT_VERSION,
  assertSquadBridgeVersion,
  canonicalSha256,
} from "@shared/runtime/squad-bridge-contract";
import {
  buildFrozenPrProfile,
  deliveryAuthorityFromProfile,
} from "@shared/runtime/squad-pr-profile";
import { afterEach, describe, expect, it } from "vitest";
import { probeAndVerifySquadBridge } from "../src/auto/squadctl-verify";
import { HAS_LIVE_SQUADCTL, LIVE_SKILL_DIR, LIVE_SQUADCTL } from "./helpers/live-squadctl";

const SQUADCTL = LIVE_SQUADCTL;
const SKILL_SCRIPTS = join(LIVE_SKILL_DIR, "scripts");
const AUTH = "d".repeat(64);

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe.skipIf(!HAS_LIVE_SQUADCTL)("real squadctl argv and control-plane smoke", () => {
  it("verifies --help/--version and required integrate/pause flags", () => {
    const probe = probeAndVerifySquadBridge({
      ...process.env,
      COUNCILKIT_SQUADCTL: SQUADCTL,
      COUNCILKIT_SQUAD_SKILL: LIVE_SKILL_DIR,
      COUNCILKIT_GROKB: process.env.COUNCILKIT_GROKB ?? join(homedir(), "bin", "grokb"),
    });
    expect(probe.available).toBe(true);
    expect(probe.version).toBe("squad-bridge.v1");
    expect(probe.toolVersion).toMatch(/squadctl 2\.1/);
    if (probe.historyContract) {
      expect(probe.historyContract).toBe("squad-history-bridge.v1");
    } else {
      expect(probe.reason).toMatch(/squad-history-bridge\.v1|升级/);
    }
    expect(
      assertSquadBridgeVersion({
        requested: SQUAD_BRIDGE_CONTRACT_VERSION,
        actual: probe.version,
      }),
    ).toEqual({ ok: true });
    expect(
      assertSquadBridgeVersion({
        requested: SQUAD_BRIDGE_CONTRACT_VERSION,
        actual: probe.toolVersion,
      }).ok,
    ).toBe(false);
  });

  it("runs init/intake/status and validates a frozen pr-profile with squadlib", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-squad-smoke-"));
    roots.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "feat-x"]);
    git(repo, ["config", "user.email", "squad@example.com"]);
    git(repo, ["config", "user.name", "squad"]);
    writeFileSync(join(repo, "README.md"), "ok\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    const bare = join(root, "remote.git");
    execFileSync("git", ["clone", "--bare", repo, bare]);
    git(repo, ["remote", "add", "origin", bare]);
    const taskDir = join(root, "task");
    const taskId = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-repair-smok`;
    const init = spawnSync(
      SQUADCTL,
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
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(init.status, init.stderr).toBe(0);
    const pkg = join(root, "pkg.json");
    writeFileSync(
      pkg,
      `${JSON.stringify({
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
      })}\n`,
    );
    const intake = spawnSync(
      SQUADCTL,
      [
        "intake",
        "--task-dir",
        taskDir,
        "--package",
        pkg,
        "--json",
        "--new-repair-chain",
        "--project-id",
        "github.com/acme/repo",
        "--repair-chain-id",
        "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ],
      { encoding: "utf8" },
    );
    expect(intake.status, intake.stderr).toBe(0);
    const intakeView = JSON.parse(intake.stdout) as {
      historyCompleteness?: string;
      newChain?: boolean;
    };
    expect(intakeView.historyCompleteness ?? "").toMatch(/verified|complete/);
    const status = spawnSync(SQUADCTL, ["status", "--task-dir", taskDir, "--json"], {
      encoding: "utf8",
    });
    expect(status.status, status.stderr).toBe(0);
    const view = JSON.parse(status.stdout) as {
      epoch?: number;
      phase?: string;
      repair_budget?: { completeness?: string; new_chain?: boolean };
      projection?: { repair_budget?: { completeness?: string; new_chain?: boolean } };
    };
    expect(view.epoch).toBeTypeOf("number");
    const budget = view.repair_budget ?? view.projection?.repair_budget;
    if (budget) {
      expect(budget.new_chain).toBe(true);
      expect(budget.completeness).toMatch(/verified|complete/);
    }
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha: sha,
      expectedOldSha: sha,
      remote: "origin",
      authorityRef: AUTH,
    });
    expect(deliveryAuthorityFromProfile(profile).target_ref).toBe("refs/heads/feat-x");
    const profilePath = join(root, "pr-profile.json");
    writeFileSync(profilePath, `${JSON.stringify(profile)}\n`);
    const validated = spawnSync(
      "python3",
      [
        "-c",
        "from squadlib.integration import load_pr_profile; import sys; load_pr_profile(sys.argv[1]); print('ok')",
        profilePath,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONPATH: SKILL_SCRIPTS } },
    );
    expect(validated.status, validated.stderr).toBe(0);
    expect(validated.stdout).toMatch(/ok/);
    const hashed = spawnSync(
      "python3",
      [
        "-c",
        "from squadlib.model import content_hash; from squadlib.integration import load_pr_profile; import sys; print(content_hash(load_pr_profile(sys.argv[1])))",
        profilePath,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONPATH: SKILL_SCRIPTS } },
    );
    expect(hashed.status, hashed.stderr).toBe(0);
    expect(canonicalSha256(profile)).toBe(hashed.stdout.trim());
  });
});
