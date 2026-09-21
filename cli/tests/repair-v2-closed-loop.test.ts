import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRepairBudget } from "@shared/runtime/repair-chain";
import { goalIdentityFingerprint } from "@shared/runtime/repair-contract";
import { SQUAD_REQUIRED_GATES_V1, hashRepairGatePolicy } from "@shared/runtime/repair-policy";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeLockedRetry, loadOrCreateChain } from "../src/auto/repair-chain-store";
import { saveRepairProfile } from "../src/auto/repair-profile";
import { FakeSquadBridge } from "../src/auto/squad-bridge";
import { type RepairCommandDeps, RepairExit, runRepair } from "../src/commands/repair";
import type { OutputSink } from "../src/output";

const SOURCE_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const REPAIR_ID = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const PR_URL = "https://github.com/acme/repo/pull/9";

let home: string;
let previous: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-v2-loop-"));
  previous = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
});

afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeSink(): OutputSink & { finished: unknown } {
  const sink: OutputSink & { finished: unknown } = {
    json: true,
    progress: () => {},
    diag: () => {},
    finish: async (data) => {
      sink.finished = data;
    },
    finished: null,
  };
  return sink;
}

function initRepo(): { repo: string; sourceSha: string; candidateSha: string; bare: string } {
  const repo = join(home, "src");
  const bare = join(home, "remote.git");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "feat-x"]);
  git(repo, ["config", "user.email", "v2@example.com"]);
  git(repo, ["config", "user.name", "v2"]);
  writeFileSync(join(repo, "README.md"), "source\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "source"]);
  const sourceSha = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "ready.txt"), "ok\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "candidate"]);
  const candidateSha = git(repo, ["rev-parse", "HEAD"]);
  execFileSync("git", ["clone", "--bare", repo, bare], { encoding: "utf8" });
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["checkout", sourceSha]);
  return { repo, sourceSha, candidateSha, bare };
}

function seedReview(
  runId: string,
  input: { sha: string; open: boolean; command?: string; against?: string },
): void {
  const dir = join(home, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "review.started",
      runId,
      startedAt: "2026-09-21T00:00:00.000Z",
      task: { pr: PR_URL, against: input.against },
    })}\n${JSON.stringify({
      kind: "review.finished",
      status: "completed",
      incomplete: false,
      endedAt: "2026-09-21T00:01:00.000Z",
    })}\n`,
  );
  writeFileSync(join(dir, "report.md"), "# review\n");
  const verification = input.command
    ? {
        outcome: input.open ? "still_open" : "verified_closed",
        candidateSha: input.sha,
        runId,
        attemptId: "a1",
        reviewer: "R",
        method: "regression_test" as const,
        reason: "command",
        evidence: input.command,
        command: input.command,
        runComplete: true,
      }
    : input.open
      ? undefined
      : {
          outcome: "verified_closed" as const,
          candidateSha: input.sha,
          runId,
          attemptId: "a1",
          reviewer: "R",
          method: "code_trace" as const,
          reason: "fixed",
          evidence: "trace",
          locations: ["README.md:1"],
          runComplete: true,
        };
  writeFileSync(
    join(dir, "findings.json"),
    JSON.stringify({
      version: 1,
      runId,
      extractedAt: "2026-09-21T00:00:00.000Z",
      sha: input.sha,
      againstRunId: input.against ?? null,
      againstRange: null,
      findings: [
        {
          id: "F-1",
          title: "bug",
          severity: "major",
          status: input.open ? "open" : "closed",
          text: "bug",
          source: "consensus",
          reviewer: "R",
          files: ["README.md"],
          ...(verification ? { verification } : {}),
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "assessment-diagnostics.v1.json"),
    JSON.stringify({
      version: 1,
      kind: "councilkit-assessment-diagnostics",
      source: { runId, sha: input.sha, requiredFindingIds: ["F-1"] },
      coverageComplete: true,
      items: [],
    }),
  );
}

function saveV2(): void {
  saveRepairProfile({
    name: "v2",
    prUrl: PR_URL,
    repo: "github.com/acme/repo",
    sourceBranch: "feat-x",
    base: "main",
    capabilities: ["push-source-branch"],
    protocolVersion: "v2",
    isolationMode: "collaborative",
  });
}

function inspect(headSha: string, baseSha: string) {
  return {
    prUrl: PR_URL,
    host: "github" as const,
    branch: "feat-x",
    cloneUrl: join(home, "remote.git"),
    baseBranch: "main",
    headSha,
    baseSha,
    prOpen: true,
  };
}

function loop(repo: string, extra: RepairCommandDeps = {}): RepairCommandDeps {
  return {
    workspaceCwd: repo,
    sleep: async () => undefined,
    pollIntervalMs: 0,
    ...extra,
  };
}

describe("v2 closed loop with a temp repo", () => {
  it("approves a candidate SHA that is not the source checkout", async () => {
    const { repo, sourceSha, candidateSha } = initRepo();
    expect(sourceSha).not.toBe(candidateSha);
    seedReview(SOURCE_ID, { sha: sourceSha, open: true, command: "test -f ready.txt" });
    saveV2();
    const fake = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: {
        candidateSha,
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        gatePolicyHash: "unknown",
      },
    });
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      [
        "run",
        "--from",
        SOURCE_ID,
        "--profile",
        "v2",
        "--protocol",
        "v2",
        "--isolation",
        "collaborative",
        "--run-id",
        REPAIR_ID,
      ],
      out,
      loop(repo, {
        inspectPr: async () => inspect(fake.publishCalls > 0 ? candidateSha : sourceSha, sourceSha),
        bridge: fake,
        reviewImpl: async (argv) => {
          expect(argv).toContain("--pin-sha");
          expect(argv).toContain(candidateSha);
          seedReview(childId, {
            sha: candidateSha,
            open: false,
            command: "test -f ready.txt",
            against: SOURCE_ID,
          });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved" });
    const freeze = JSON.parse(
      readFileSync(join(home, "runs", REPAIR_ID, "official-gate-policy.json"), "utf8"),
    ) as { policyHash: string; source: string };
    expect(freeze.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(freeze.source).toBe("squadctl-gate-policy-freeze");
    expect(freeze.policyHash).not.toBe(hashRepairGatePolicy(SQUAD_REQUIRED_GATES_V1));
    const logs = readdirSync(join(home, "runs", REPAIR_ID, "verification"));
    expect(logs.some((name) => name.endsWith(".log"))).toBe(true);
    const logName = logs.find((name) => name.endsWith(".log"));
    expect(logName).toBeTruthy();
    if (!logName) throw new Error("verification log missing");
    const log = readFileSync(join(home, "runs", REPAIR_ID, "verification", logName), "utf8");
    expect(log).toContain(`sha=${candidateSha}`);
    expect(log).toMatch(/dirty=0/);
    expect(log).not.toContain(sourceSha);
  });

  it("retests a second candidate SHA instead of reusing the previous log", async () => {
    const { repo, sourceSha, candidateSha } = initRepo();
    git(repo, ["checkout", candidateSha]);
    writeFileSync(join(repo, "second.txt"), "two\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "second"]);
    const secondSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", sourceSha]);
    seedReview(SOURCE_ID, { sha: sourceSha, open: true, command: "test -f ready.txt" });
    saveV2();
    let publishedSha: string | null = null;
    let starts = 0;
    let frozen: ReturnType<FakeSquadBridge["freezeOfficialGatePolicy"]> | null = null;
    const fake = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: {
        candidateSha,
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        gatePolicyHash: "unknown",
      },
    });
    const out = makeSink();
    await runRepair(
      [
        "run",
        "--from",
        SOURCE_ID,
        "--profile",
        "v2",
        "--protocol",
        "v2",
        "--isolation",
        "collaborative",
        "--run-id",
        REPAIR_ID,
      ],
      out,
      loop(repo, {
        inspectPr: async () => inspect(publishedSha ?? sourceSha, sourceSha),
        bridge: {
          start: (request) => {
            starts += 1;
            return fake.start(request);
          },
          resume: (request) => fake.resume(request),
          stop: (request) => fake.stop(request),
          status: (request) => {
            const snapshot = fake.status(request);
            const sha = starts > 1 ? secondSha : candidateSha;
            return {
              ...snapshot,
              event: {
                ...snapshot.event,
                journal: {
                  ...snapshot.event.journal,
                  candidateSha: sha,
                  ...(frozen?.ok ? { gatePolicyHash: frozen.freeze.policyHash } : {}),
                },
              },
            };
          },
          requestPublish: (request) => {
            publishedSha = starts > 1 ? secondSha : candidateSha;
            return {
              ok: true as const,
              receipt: {
                action: "push-remote" as const,
                passed: true as const,
                candidateSha: publishedSha,
                expectedOldSha: request.identity.expectedOldSha,
                repo: request.identity.repo,
                ref: request.identity.sourceBranch,
              },
            };
          },
          freezeOfficialGatePolicy: (request) => {
            if (frozen?.ok) return frozen;
            frozen = fake.freezeOfficialGatePolicy(request);
            return frozen;
          },
          readOfficialGatePolicy: (request) =>
            frozen?.ok ? frozen.freeze : fake.readOfficialGatePolicy(request),
        },
        reviewImpl: async () => {
          const childId = `ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee${starts}`;
          const sha = starts > 1 ? secondSha : candidateSha;
          seedReview(childId, {
            sha,
            open: starts === 1,
            command: "test -f ready.txt",
            against: SOURCE_ID,
          });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved" });
    const log = readFileSync(join(home, "runs", REPAIR_ID, "verification", "A-F-1-v1.log"), "utf8");
    expect(log).toContain(`sha=${secondSha}`);
  });

  it("rejects a candidate whose policy_hash is not the official freeze", async () => {
    const { repo, sourceSha, candidateSha } = initRepo();
    seedReview(SOURCE_ID, { sha: sourceSha, open: true, command: "test -f ready.txt" });
    saveV2();
    const fake = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: {
        candidateSha,
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        gatePolicyHash: "unknown",
      },
    });
    const out = makeSink();
    await expect(
      runRepair(
        [
          "run",
          "--from",
          SOURCE_ID,
          "--profile",
          "v2",
          "--protocol",
          "v2",
          "--isolation",
          "collaborative",
          "--run-id",
          REPAIR_ID,
        ],
        out,
        loop(repo, {
          inspectPr: async () => inspect(sourceSha, sourceSha),
          bridge: {
            start: (request) => fake.start(request),
            resume: (request) => fake.resume(request),
            stop: (request) => fake.stop(request),
            status: (request) => {
              const snapshot = fake.status(request);
              return {
                ...snapshot,
                event: {
                  ...snapshot.event,
                  journal: { ...snapshot.event.journal, gatePolicyHash: "c".repeat(64) },
                },
              };
            },
            requestPublish: (request) => fake.requestPublish(request),
            freezeOfficialGatePolicy: (request) => fake.freezeOfficialGatePolicy(request),
            readOfficialGatePolicy: (request) => fake.readOfficialGatePolicy(request),
          },
          reviewImpl: async () => {
            const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
            seedReview(childId, {
              sha: candidateSha,
              open: false,
              command: "test -f ready.txt",
              against: SOURCE_ID,
            });
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({ businessResult: "needs_attention" });
  });

  it("does not execute verify commands once the retry budget is exhausted", async () => {
    const { repo, sourceSha, candidateSha } = initRepo();
    const marker = join(repo, "executed.flag");
    seedReview(SOURCE_ID, {
      sha: sourceSha,
      open: true,
      command: `touch '${marker}' && test -f ready.txt`,
    });
    saveV2();
    const created = loadOrCreateChain({
      repo: "github.com/acme/repo",
      prUrl: PR_URL,
      goalFingerprint: goalIdentityFingerprint(PR_URL),
      parentRunId: "ck-repair-pre",
      budget: newRepairBudget({ verifyRetryMax: 1 }, Date.now()),
    });
    expect(consumeLockedRetry(created.chain.chainId, "verify").ok).toBe(true);
    const fake = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: {
        candidateSha,
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        gatePolicyHash: "unknown",
      },
    });
    const out = makeSink();
    await expect(
      runRepair(
        [
          "run",
          "--from",
          SOURCE_ID,
          "--profile",
          "v2",
          "--protocol",
          "v2",
          "--isolation",
          "collaborative",
          "--run-id",
          REPAIR_ID,
        ],
        out,
        loop(repo, {
          inspectPr: async () => inspect(sourceSha, sourceSha),
          bridge: fake,
          reviewImpl: async () => {
            const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
            seedReview(childId, {
              sha: candidateSha,
              open: false,
              command: `touch '${marker}' && test -f ready.txt`,
              against: SOURCE_ID,
            });
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "coverage_incomplete",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps required command verification unknown when the candidate snapshot cannot be measured", async () => {
    const { sourceSha, candidateSha } = initRepo();
    mkdirSync(join(home, "not-a-git"));
    seedReview(SOURCE_ID, { sha: sourceSha, open: true, command: "test -f ready.txt" });
    saveV2();
    const fake = new FakeSquadBridge({
      version: SQUAD_BRIDGE_CONTRACT_VERSION,
      journal: {
        candidateSha,
        invalidated: false,
        independentReview: true,
        independentVerify: true,
        requiredGatesPassed: true,
        gatePolicyHash: "unknown",
      },
    });
    const out = makeSink();
    await expect(
      runRepair(
        [
          "run",
          "--from",
          SOURCE_ID,
          "--profile",
          "v2",
          "--protocol",
          "v2",
          "--isolation",
          "collaborative",
          "--run-id",
          REPAIR_ID,
        ],
        out,
        loop(join(home, "not-a-git"), {
          inspectPr: async () => inspect(sourceSha, sourceSha),
          bridge: fake,
          reviewImpl: async () => {
            const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
            seedReview(childId, {
              sha: candidateSha,
              open: false,
              command: "test -f ready.txt",
              against: SOURCE_ID,
            });
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({ businessResult: "needs_attention" });
  });

  it("keeps the old v1 profile path without requiring isolation", async () => {
    const { repo, sourceSha } = initRepo();
    seedReview(SOURCE_ID, { sha: sourceSha, open: true });
    saveRepairProfile({
      name: "legacy",
      prUrl: PR_URL,
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      base: "main",
      capabilities: ["push-source-branch"],
    });
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "legacy", "--run-id", REPAIR_ID],
      out,
      loop(repo, {
        inspectPr: async () => inspect(sourceSha, sourceSha),
        bridge: new FakeSquadBridge({
          version: SQUAD_BRIDGE_CONTRACT_VERSION,
          journal: {
            candidateSha: sourceSha,
            invalidated: false,
            independentReview: true,
            independentVerify: true,
            requiredGatesPassed: true,
            gatePolicyHash: "unknown",
          },
        }),
        reviewImpl: async () => {
          seedReview(childId, { sha: sourceSha, open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved", outerUsed: 1 });
  });
});
