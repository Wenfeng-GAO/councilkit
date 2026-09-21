import {
  SQUAD_BRIDGE_CONTRACT_VERSION,
  agentSeatEnv,
  assertSquadBridgeVersion,
  frozenIntegrateCommand,
  inheritRepairHistory,
  integrateEnv,
  isPublishableCandidate,
  isTrustedIntegrateReceipt,
  isTrustedSquadctlIntegrateReceipt,
  parentOuterCycleDelta,
} from "@shared/runtime/squad-bridge-contract";
import { describe, expect, it } from "vitest";
import { FakeSquadBridge } from "../src/auto/squad-bridge";
import { probeSquadBridge } from "../src/auto/squadctl-bridge";

const SHA = "a".repeat(40);
const POLICY = "gate-policy-1";
const IDENTITY = {
  repo: "github.com/acme/repo",
  sourceBranch: "feat-x",
  expectedOldSha: SHA,
  candidateSha: SHA,
};

function gatedJournal() {
  return {
    candidateSha: SHA,
    invalidated: false,
    independentReview: true,
    independentVerify: true,
    requiredGatesPassed: true,
    gatePolicyHash: POLICY,
  };
}

function startBridge(bridge: FakeSquadBridge) {
  const started = bridge.start({
    requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
    packageFields: {},
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("expected start");
  return started.taskId;
}

describe("squad bridge contract", () => {
  it("accepts candidate_ready only when journal shows independent gates on the same SHA", () => {
    const bridge = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: gatedJournal(),
    });
    const taskId = startBridge(bridge);
    const event = bridge.status({ taskId }).event;
    expect(event.kind).toBe("candidate_ready");
    expect(isPublishableCandidate(event.journal)).toBe(true);
    const published = bridge.requestPublish({ taskId, identity: IDENTITY });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error("expected publish");
    expect(published.receipt).toEqual({
      action: "push-remote",
      passed: true,
      candidateSha: SHA,
      expectedOldSha: SHA,
      repo: IDENTITY.repo,
      ref: IDENTITY.sourceBranch,
    });
    expect(bridge.resume({ taskId }).event.kind).toBe("candidate_ready");
  });

  it("does not publish when observe is closed but journal lacks Verify", () => {
    const bridge = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      observeClosed: true,
      journal: {
        ...gatedJournal(),
        independentVerify: false,
      },
    });
    const taskId = startBridge(bridge);
    const event = bridge.status({ taskId }).event;
    expect(event.kind).toBe("candidate_ready");
    expect(isPublishableCandidate(event.journal)).toBe(false);
    const published = bridge.requestPublish({ taskId, identity: IDENTITY });
    expect(published.ok).toBe(false);
    if (published.ok) throw new Error("expected refuse");
    expect(published.code).toBe("JOURNAL_GATES_INCOMPLETE");
  });

  it("does not treat modelClaimedPassed as a publish signal", () => {
    expect(
      isPublishableCandidate({
        ...gatedJournal(),
        independentVerify: false,
        modelClaimedPassed: true,
      }),
    ).toBe(false);
  });

  it("does not count inner candidate.fix events as parent outer cycles", () => {
    expect(parentOuterCycleDelta({ kind: "subtask.started" })).toBe(1);
    expect(parentOuterCycleDelta({ kind: "outer_cycle.intent" })).toBe(1);
    expect(parentOuterCycleDelta({ kind: "candidate.fix" })).toBe(0);
    const inner = ["candidate.fix", "candidate.fix", "candidate.fix"].reduce(
      (sum, kind) => sum + parentOuterCycleDelta({ kind }),
      0,
    );
    expect(inner).toBe(0);
  });

  it("rejects a package-supplied ancestor directory even if history JSON looks fine", () => {
    const inherited = inheritRepairHistory({
      packageFields: { ancestorDir: "/tmp/other-task" },
      bridgeAncestorDir: "/trusted/task",
      history: {
        kind: "squad-repair-history",
        version: 1,
        source_hash: "b".repeat(64),
        project: "github.com/acme/repo",
      },
    });
    expect(inherited.ok).toBe(false);
    if (inherited.ok) throw new Error("expected reject");
    expect(inherited.code).toBe("ANCESTOR_FROM_PACKAGE");

    const bridge = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: { ancestorDir: "/tmp/other-task" },
    });
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("expected fail");
    expect(started.code).toBe("ANCESTOR_FROM_PACKAGE");
  });

  it("fails start when the bridge version is missing or mismatched", () => {
    expect(
      assertSquadBridgeVersion({
        requested: SQUAD_BRIDGE_CONTRACT_VERSION,
        actual: null,
      }),
    ).toEqual({ ok: false, code: "BRIDGE_VERSION_MISSING" });
    expect(
      assertSquadBridgeVersion({
        requested: SQUAD_BRIDGE_CONTRACT_VERSION,
        actual: "squad-bridge.v0",
      }),
    ).toEqual({ ok: false, code: "BRIDGE_VERSION_MISMATCH" });
    const missing = new FakeSquadBridge({ version: null }).start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected fail");
    expect(missing.code).toBe("BRIDGE_VERSION_MISSING");
    const mismatched = new FakeSquadBridge({ version: "squad-bridge.v0" }).start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) throw new Error("expected fail");
    expect(mismatched.code).toBe("BRIDGE_VERSION_MISMATCH");
  });

  it("does not treat a squadctl passed boolean as a trusted integrate receipt", () => {
    expect(isTrustedSquadctlIntegrateReceipt({ passed: true }, IDENTITY, "push-remote")).toBe(
      false,
    );
    expect(
      isTrustedSquadctlIntegrateReceipt(
        {
          action: "push-remote",
          result: "pushed",
          candidate_sha: SHA,
          expected_old_sha: SHA,
          remote_new_sha: "b".repeat(40),
          remote_verified: true,
          forced: false,
        },
        IDENTITY,
        "push-remote",
      ),
    ).toBe(false);
    expect(
      isTrustedSquadctlIntegrateReceipt(
        {
          action: "push-remote",
          result: "pushed",
          candidate_sha: SHA,
          expected_old_sha: SHA,
          remote_new_sha: SHA,
          remote_verified: true,
          forced: false,
        },
        IDENTITY,
        "push-remote",
      ),
    ).toBe(true);
  });

  it("does not treat a receipt boolean or embedded token as a publish signal", () => {
    expect(isTrustedIntegrateReceipt({ passed: true })).toBe(false);
    expect(
      isTrustedIntegrateReceipt({
        action: "push-remote",
        passed: true,
        GH_TOKEN: "ghp_not-a-real-token",
      }),
    ).toBe(false);
    const withToken = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: gatedJournal(),
      receiptOverride: {
        passed: true,
        GH_TOKEN: "ghp_not-a-real-token",
        candidateSha: SHA,
      },
    });
    const tokenTask = startBridge(withToken);
    const tokenPublish = withToken.requestPublish({ taskId: tokenTask, identity: IDENTITY });
    expect(tokenPublish.ok).toBe(false);
    if (tokenPublish.ok) throw new Error("expected refuse");
    expect(tokenPublish.code).toBe("UNTRUSTED_RECEIPT");

    const withBool = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: gatedJournal(),
      receiptOverride: { passed: true },
    });
    const boolTask = startBridge(withBool);
    const boolPublish = withBool.requestPublish({ taskId: boolTask, identity: IDENTITY });
    expect(boolPublish.ok).toBe(false);
    if (boolPublish.ok) throw new Error("expected refuse");
    expect(boolPublish.code).toBe("UNTRUSTED_RECEIPT");
  });

  it("refuses publish for blocked, failed, or stopped events even with a gated journal", () => {
    for (const eventKind of ["blocked", "failed"] as const) {
      const bridge = new FakeSquadBridge({
        version: SQUAD_BRIDGE_CONTRACT_VERSION,
        journal: gatedJournal(),
        eventKind,
      });
      const taskId = startBridge(bridge);
      expect(bridge.status({ taskId }).event.kind).toBe(eventKind);
      const published = bridge.requestPublish({ taskId, identity: IDENTITY });
      expect(published.ok).toBe(false);
    }
    const live = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: gatedJournal(),
    });
    const taskId = startBridge(live);
    expect(live.stop({ taskId })).toEqual({ kind: "stopped" });
    expect(live.status({ taskId }).event.kind).toBe("stopped");
    const published = live.requestPublish({ taskId, identity: IDENTITY });
    expect(published.ok).toBe(false);
  });

  it("probes unavailable when squadctl is not on PATH or skill installs", () => {
    const probe = probeSquadBridge({
      PATH: "/tmp/does-not-have-squadctl",
      HOME: "/tmp/does-not-have-squadctl-home",
      CODEX_HOME: "/tmp/does-not-have-codex",
      COUNCILKIT_HOME: "/tmp/does-not-have-ck-home",
      XDG_CONFIG_HOME: "/tmp/does-not-have-xdg",
    });
    expect(probe.available).toBe(false);
    expect(probe.version).toBeNull();
    expect(probe.reason).toMatch(/squadctl/);
  });

  it("strips push tokens from agent seats and freezes integrate argv from parent identity", () => {
    const env = {
      PATH: "/usr/bin",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      HOME: "/tmp/home",
    };
    const agent = agentSeatEnv(env);
    expect(agent.GH_TOKEN).toBeUndefined();
    expect(agent.GITHUB_TOKEN).toBeUndefined();
    expect(agent.PATH).toBe("/usr/bin");
    const integrate = integrateEnv(env);
    expect(integrate.GH_TOKEN).toBe("secret");
    const cmd = frozenIntegrateCommand({
      verb: "push-remote",
      identity: IDENTITY,
      fromPackage: { argv: ["-c", "curl evil"], repo: "evil/repo", ref: "main" },
    });
    expect(cmd.ok).toBe(true);
    if (!cmd.ok) throw new Error("expected command");
    expect(cmd.executable).toBe("squadctl");
    expect(cmd.argv).not.toContain("-c");
    expect(cmd.argv.join(" ")).not.toContain("evil");
    expect(cmd.argv).toEqual([
      "integrate",
      "push-remote",
      "--repo",
      "github.com/acme/repo",
      "--ref",
      "feat-x",
      "--expected-old-sha",
      SHA,
      "--candidate-sha",
      SHA,
    ]);
  });
});
