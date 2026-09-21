import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_RUN_PIPELINE_PID_FILE, CLI_RUN_STATUS_FILE } from "@shared/runtime/cli-run-progress";
import { readCliRun } from "@shared/runtime/cli-runs-index";
import { repairPackageSchema } from "@shared/runtime/repair-package";
import {
  DEFAULT_GATE_POLICY_ID,
  REPAIR_GATE_POLICY_CATALOG,
  hashRepairGatePolicy,
} from "@shared/runtime/repair-policy";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import { historyEnvelopeHash, parseHistoryEnvelope } from "@shared/runtime/squad-history-bridge";
import { mapSquadStatus } from "@shared/runtime/squad-journal-map";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRepairGrant,
  loadRepairProfile,
  saveRepairProfile,
} from "../src/auto/repair-profile";
import { FakeSquadBridge, type SquadBridgeDelivery } from "../src/auto/squad-bridge";
import { type RepairCommandDeps, RepairExit, runRepair } from "../src/commands/repair";
import { CliError } from "../src/errors";
import type { OutputSink } from "../src/output";

const id = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
let home: string;
let previous: string | undefined;
const sink: OutputSink = { json: true, progress: () => {}, diag: () => {}, finish: async () => {} };
function seed(options: { incomplete?: boolean; longTranscript?: boolean } = {}) {
  const dir = join(home, "runs", id);
  mkdirSync(dir, { recursive: true });
  const transcript = [
    {
      kind: "review.started",
      runId: id,
      startedAt: "2026-09-07",
      task: { pr: "https://github.com/acme/repo/pull/1" },
    },
    ...(options.longTranscript
      ? [{ kind: "attempt.finished", output: "x".repeat(512 * 1024) }]
      : []),
    {
      kind: "review.finished",
      status: "completed",
      incomplete: options.incomplete ?? false,
      endedAt: "2026-09-07",
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
  writeFileSync(join(dir, "transcript.jsonl"), `${transcript}\n`);
  writeFileSync(join(dir, "report.md"), "# review\n");
  writeFileSync(
    join(dir, "findings.json"),
    JSON.stringify({
      version: 1,
      runId: id,
      extractedAt: "2026-09-07",
      sha: "a".repeat(40),
      againstRunId: null,
      againstRange: null,
      findings: [
        {
          id: "F-1",
          title: "close claim",
          severity: "major",
          status: "closed",
          text: "unverified",
          source: "consensus",
          reviewer: "R",
          files: ["src/file.ts"],
        },
      ],
    }),
  );
  return dir;
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-repair-"));
  previous = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
});
afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});
describe("repair export CLI", () => {
  it("exports a complete run with a long transcript, without mutating its ledger", async () => {
    const dir = seed({ longTranscript: true });
    const before = readFileSync(join(dir, "findings.json"), "utf8");
    const out = join(home, "repair.json");
    await runRepair(["export", "--run", id, "--out", out], sink);
    const task = repairPackageSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(task.findings[0]?.id).toBe("F-1");
    expect(task.source.sha).toBe("a".repeat(40));
    expect(readFileSync(join(dir, "findings.json"), "utf8")).toBe(before);
    expect(readCliRun(id)?.reviewEvidence?.complete).toBe(true);
  });
  it("rejects partial runs, corrupt locks, and unknown clusters", async () => {
    const dir = seed({ incomplete: true });
    await expect(
      runRepair(["export", "--run", id, "--out", join(home, "repair.json")], sink),
    ).rejects.toThrow("完整");
    seed();
    await expect(
      runRepair(
        ["export", "--run", id, "--out", join(home, "repair.json"), "--cluster", "missing"],
        sink,
      ),
    ).rejects.toThrow("cluster");
    writeFileSync(join(dir, "plan.lock.json"), "broken");
    await expect(
      runRepair(["export", "--run", id, "--out", join(home, "repair.json")], sink),
    ).rejects.toThrow("plan.lock");
  });
  it("rejects contradictory failed live state even with a completed transcript", async () => {
    const dir = seed();
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        version: 1,
        status: "failed",
        progress: { phase: "done", attempts: [], updatedAt: "2026-09-07" },
        pipeline: null,
      }),
    );
    expect(readCliRun(id)?.status).toBe("failed");
    await expect(
      runRepair(["export", "--run", id, "--out", join(home, "repair.json")], sink),
    ).rejects.toThrow("完整");
  });
  it("refuses history output and refuses overwriting an existing file", async () => {
    const dir = seed();
    await expect(
      runRepair(["export", "--run", id, "--out", join(dir, "export.json")], sink),
    ).rejects.toThrow("history");
    const out = join(home, "repair.json");
    writeFileSync(out, "precious");
    await expect(runRepair(["export", "--run", id, "--out", out], sink)).rejects.toThrow(
      "new file",
    );
    expect(readFileSync(out, "utf8")).toBe("precious");
  });
  it("does not accept symlinked ledger evidence or corrupt trailing completion", async () => {
    const dir = seed();
    const ledger = join(dir, "findings.json");
    const original = readFileSync(ledger);
    writeFileSync(join(home, "other.json"), original);
    rmSync(ledger);
    symlinkSync(join(home, "other.json"), ledger);
    expect(readCliRun(id)?.reviewEvidence?.complete).toBe(false);
    rmSync(ledger);
    writeFileSync(ledger, original);
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${readFileSync(join(dir, "transcript.jsonl"), "utf8")}broken`,
    );
    expect(readCliRun(id)?.reviewEvidence?.complete).toBe(false);
  });
  it("exports two IDs with a shared rootCause from a valid sidecar and refuses a corrupt sidecar", async () => {
    const dir = seed();
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    findings.findings.push({
      id: "F-2",
      title: "alias",
      severity: "major",
      status: "open",
      text: "same hole",
      source: "unique",
      reviewer: "R",
      files: ["src/file.ts"],
    });
    writeFileSync(join(dir, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
    const bytes = readFileSync(join(dir, "findings.json"), "utf8");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes, "utf8").digest("hex");
    writeFileSync(
      join(dir, "finding-groups.v1.json"),
      `${JSON.stringify({
        version: 1,
        kind: "councilkit-finding-groups",
        source: {
          runId: id,
          sha: "a".repeat(40),
          findingsSha256: hash,
          againstRunId: null,
        },
        groups: [
          {
            rootCauseId: "RC-STABLE-CANCEL",
            findingIds: ["F-1", "F-2"],
            aliases: ["F-2"],
            basis: "shared fixture root",
          },
        ],
      })}\n`,
    );
    const out = join(home, "repair-shared.json");
    await runRepair(["export", "--run", id, "--out", out], sink);
    const task = repairPackageSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(task.findings.map((row) => row.id).sort()).toEqual(["F-1", "F-2"]);
    expect(task.findings.every((row) => row.rootCause === "RC-STABLE-CANCEL")).toBe(true);
    writeFileSync(join(dir, "finding-groups.v1.json"), `${JSON.stringify({ version: 99 })}\n`);
    await expect(
      runRepair(["export", "--run", id, "--out", join(home, "repair-bad.json")], sink),
    ).rejects.toThrow(/finding-groups/);
  });
});

const SOURCE_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const REPAIR_ID = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
const PR = "https://github.com/acme/repo/pull/9";

function makeSink(): OutputSink & { finished: unknown } {
  const sink: OutputSink & { finished: unknown } = {
    json: true,
    finished: undefined,
    progress: () => {},
    diag: () => {},
    finish: async (data) => {
      sink.finished = data;
    },
  };
  return sink;
}

function snapshotDir(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const bytes = readFileSync(path);
      return `${name}:${createHash("sha256").update(bytes).digest("hex")}`;
    })
    .join("|");
}

function seedSource(root: string): string {
  const dir = join(root, "runs", SOURCE_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, CLI_RUN_STATUS_FILE),
    `${JSON.stringify({
      version: 1,
      status: "completed",
      progress: { phase: "done", attempts: [], updatedAt: "2026-09-20T00:00:00.000Z" },
      pipeline: null,
    })}\n`,
  );
  writeFileSync(join(dir, "report.md"), "# source\n");
  return dir;
}

function saveDefaultProfile(): void {
  saveRepairProfile({
    name: "default",
    prUrl: PR,
    repo: "github.com/acme/repo",
    sourceBranch: "feat-x",
    base: "main",
    capabilities: ["push-source-branch"],
  });
}

describe("repair run CLI bootstrap", () => {
  const noWait = { wait: async () => {}, loop: false as const };

  it("creates a parent run dir with a null pipeline and a live pid, without touching the source review", async () => {
    const sourceDir = seedSource(home);
    saveDefaultProfile();
    const before = snapshotDir(sourceDir);
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      out,
      noWait,
    );
    const repairDir = join(home, "runs", REPAIR_ID);
    const live = JSON.parse(readFileSync(join(repairDir, CLI_RUN_STATUS_FILE), "utf8")) as {
      status: string;
      pipeline: unknown;
      progress: { phase: string };
    };
    expect(live.status).toBe("running");
    expect(live.pipeline).toBeNull();
    expect(live.progress.phase).toBe("repair-preparing");
    expect(readFileSync(join(repairDir, CLI_RUN_PIPELINE_PID_FILE), "utf8").trim()).toBe(
      String(process.pid),
    );
    expect(existsSync(join(repairDir, "journal.jsonl"))).toBe(true);
    expect(readFileSync(join(repairDir, "journal.jsonl"), "utf8")).toBe("");
    expect(existsSync(join(sourceDir, CLI_RUN_PIPELINE_PID_FILE))).toBe(false);
    expect(snapshotDir(sourceDir)).toBe(before);
    expect(out.finished).toMatchObject({
      runId: REPAIR_ID,
      sourceRunId: SOURCE_ID,
      status: "running",
    });
    const listed = readCliRun(REPAIR_ID);
    expect(listed?.kind).toBe("repair");
    expect(listed?.pipeline).toBeNull();
    expect(listed?.progress?.phase).toBe("repair-preparing");
  });

  it("reuses an existing --run-id instead of minting a second parent directory", async () => {
    seedSource(home);
    saveDefaultProfile();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      noWait,
    );
    writeFileSync(join(home, "runs", REPAIR_ID, "journal.jsonl"), "{}\n");
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      out,
      noWait,
    );
    expect(out.finished).toMatchObject({ runId: REPAIR_ID, reused: true });
    expect(readFileSync(join(home, "runs", REPAIR_ID, "journal.jsonl"), "utf8")).toBe("{}\n");
    expect(readdirSync(join(home, "runs")).filter((name) => name.startsWith("ck-repair-"))).toEqual(
      [REPAIR_ID],
    );
  });

  it("rejects a path-shaped --profile and missing required flags", async () => {
    seedSource(home);
    saveDefaultProfile();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "../x", "--run-id", REPAIR_ID],
        makeSink(),
        noWait,
      ),
    ).rejects.toBeInstanceOf(CliError);
    await expect(runRepair(["run", "--from", SOURCE_ID], makeSink(), noWait)).rejects.toThrow(
      /profile/,
    );
    await expect(runRepair(["run", "--profile", "default"], makeSink(), noWait)).rejects.toThrow(
      /from/,
    );
  });

  it("leaves the source review pid and status unchanged even when the source already had a sidecar", async () => {
    const sourceDir = seedSource(home);
    saveDefaultProfile();
    const statusBefore = readFileSync(join(sourceDir, CLI_RUN_STATUS_FILE), "utf8");
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      noWait,
    );
    expect(readFileSync(join(sourceDir, CLI_RUN_STATUS_FILE), "utf8")).toBe(statusBefore);
    expect(existsSync(join(sourceDir, CLI_RUN_PIPELINE_PID_FILE))).toBe(false);
  });

  it("parses status, stop, and resume against the parent run", async () => {
    seedSource(home);
    saveDefaultProfile();
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      noWait,
    );
    const statusOut = makeSink();
    await runRepair(["status", "--run", REPAIR_ID], statusOut);
    expect(statusOut.finished).toMatchObject({
      runId: REPAIR_ID,
      status: "running",
      pipeline: null,
    });
    const stopOut = makeSink();
    await expect(
      runRepair(["stop", "--run", REPAIR_ID], stopOut, {
        kill: (pid, signal) => {
          killed.push({ pid, signal });
        },
      }),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(killed).toEqual([{ pid: process.pid, signal: "SIGTERM" }]);
    expect(stopOut.finished).toMatchObject({
      runId: REPAIR_ID,
      status: "interrupted",
      businessResult: "stopped",
    });
    const live = JSON.parse(
      readFileSync(join(home, "runs", REPAIR_ID, CLI_RUN_STATUS_FILE), "utf8"),
    );
    expect(live.status).toBe("interrupted");
    expect(live.pipeline).toBeNull();
    const resumeOut = makeSink();
    await runRepair(["resume", "--run", REPAIR_ID], resumeOut, { ...noWait, pid: 4243 });
    expect(resumeOut.finished).toMatchObject({ runId: REPAIR_ID, status: "running" });
    expect(
      readFileSync(join(home, "runs", REPAIR_ID, CLI_RUN_PIPELINE_PID_FILE), "utf8").trim(),
    ).toBe("4243");
  });
});

const SHA = "a".repeat(40);
const PR_URL = "https://github.com/acme/repo/pull/9";

function verification(runId: string) {
  return {
    outcome: "verified_closed" as const,
    candidateSha: SHA,
    runId,
    attemptId: "a1",
    reviewer: "R",
    method: "code_trace" as const,
    reason: "fixed",
    evidence: "trace",
    locations: ["src/file.ts:1"],
    runComplete: true,
  };
}

function seedCompleteReview(
  runId: string,
  options: { open?: boolean; against?: string | null } = {},
) {
  const dir = join(home, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "review.started",
      runId,
      startedAt: "2026-09-20T00:00:00.000Z",
      task: { pr: PR_URL, against: options.against ?? undefined },
    })}\n${JSON.stringify({
      kind: "review.finished",
      status: "completed",
      incomplete: false,
      endedAt: "2026-09-20T00:01:00.000Z",
    })}\n`,
  );
  writeFileSync(join(dir, "report.md"), "# review\n");
  writeFileSync(
    join(dir, "findings.json"),
    JSON.stringify({
      version: 1,
      runId,
      extractedAt: "2026-09-20T00:00:00.000Z",
      sha: SHA,
      againstRunId: options.against ?? null,
      againstRange: null,
      findings: [
        {
          id: "F-1",
          title: "bug",
          severity: "major",
          status: options.open === false ? "closed" : "open",
          text: "bug",
          source: "consensus",
          reviewer: "R",
          files: ["src/file.ts"],
          ...(options.open === false ? { verification: verification(runId) } : {}),
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "assessment-diagnostics.v1.json"),
    JSON.stringify({
      version: 1,
      kind: "councilkit-assessment-diagnostics",
      source: { runId, sha: SHA, requiredFindingIds: ["F-1"] },
      coverageComplete: true,
      items: [],
    }),
  );
  return dir;
}

function inspectPr(headSha = SHA, extra: { prOpen?: boolean; baseSha?: string } = {}) {
  return {
    prUrl: PR_URL,
    host: "github" as const,
    branch: "feat-x",
    cloneUrl: "github.com/acme/repo",
    baseBranch: "main",
    headSha,
    prOpen: extra.prOpen ?? true,
    ...(extra.baseSha ? { baseSha: extra.baseSha } : {}),
  };
}

function loopOpts(extra: RepairCommandDeps = {}): RepairCommandDeps {
  return {
    workspaceCwd: home,
    inspectPr: async () => inspectPr(),
    bridge: new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION }),
    sleep: async () => undefined,
    pollIntervalMs: 0,
    ...extra,
  };
}

describe("repair outer loop", () => {
  it("approves after one outer cycle without writing the source review pid", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const sourceDir = join(home, "runs", SOURCE_ID);
    const before = snapshotDir(sourceDir);
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const argvLog: string[][] = [];
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      out,
      loopOpts({
        reviewImpl: async (argv) => {
          argvLog.push(argv);
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({
      runId: REPAIR_ID,
      businessResult: "approved",
      outerUsed: 1,
    });
    expect(argvLog[0]?.includes("--focus")).toBe(false);
    expect(argvLog[0]?.includes("--against")).toBe(true);
    expect(existsSync(join(sourceDir, CLI_RUN_PIPELINE_PID_FILE))).toBe(false);
    expect(snapshotDir(sourceDir)).toBe(before);
  });

  it("opens a second outer cycle when in-scope findings remain", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    let round = 0;
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      out,
      loopOpts({
        reviewImpl: async () => {
          round += 1;
          const childId = `ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee${round}`;
          seedCompleteReview(childId, {
            open: round === 1,
            against: round === 1 ? SOURCE_ID : childId,
          });
          if (round === 1) seedCompleteReview(childId, { open: true, against: SOURCE_ID });
          else seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved", outerUsed: 2 });
  });

  it("waits more than three status polls without writing candidate.fix", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      out,
      loopOpts({
        bridge: new FakeSquadBridge({
          version: SQUAD_BRIDGE_CONTRACT_VERSION,
          runningPolls: 4,
        }),
        reviewImpl: async () => {
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved", outerUsed: 1 });
    const journal = readFileSync(join(home, "runs", REPAIR_ID, "journal.jsonl"), "utf8");
    expect(journal).not.toMatch(/candidate\.fix/);
  });

  it("does not consume parent budget for inner candidate.fix retries", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      out,
      loopOpts({
        bridge: new FakeSquadBridge({
          version: SQUAD_BRIDGE_CONTRACT_VERSION,
          innerFails: 2,
          journal: {
            candidateSha: SHA,
            invalidated: false,
            independentReview: true,
            independentVerify: true,
            requiredGatesPassed: true,
            gatePolicyHash: hashRepairGatePolicy(
              REPAIR_GATE_POLICY_CATALOG[DEFAULT_GATE_POLICY_ID],
            ),
          },
        }),
        reviewImpl: async () => {
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved", outerUsed: 1 });
  });

  it("runs the 10th cycle and refuses an 11th writable subtask", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const out = makeSink();
    await expect(
      runRepair(
        [
          "run",
          "--from",
          SOURCE_ID,
          "--profile",
          "default",
          "--run-id",
          REPAIR_ID,
          "--max-outer-cycles",
          "10",
        ],
        out,
        loopOpts({
          reviewImpl: async () => {
            const childId = `ck-review-${randomUUID()}`;
            seedCompleteReview(childId, { open: true, against: SOURCE_ID });
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({ businessResult: "needs_attention", outerUsed: 10 });
  });

  it("does not approve when the follow-up review is incomplete", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({
          reviewImpl: async () => ({
            runId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
            incomplete: true,
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "councilkit_incomplete",
    });
  });

  it("resumes a CAS+1 reserved slot without minting a new outer cycle", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      { wait: async () => {}, loop: false },
    );
    const { readRepairState, writeRepairState } = await import("../src/auto/repair-persist");
    const dir = join(home, "runs", REPAIR_ID);
    const state = readRepairState(dir);
    if (!state) throw new Error("missing state");
    writeRepairState(dir, {
      ...state,
      outerUsed: 1,
      cycles: [{ n: 1, phase: "reserved" }],
      businessResult: null,
      reasonCode: null,
    });
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      ["resume", "--run", REPAIR_ID],
      out,
      loopOpts({
        reviewImpl: async () => {
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved", outerUsed: 1 });
  });

  it("records published without a second push after a crash mid-ladder", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const bridge = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      { wait: async () => {}, loop: false },
    );
    const { readRepairState, writeRepairState } = await import("../src/auto/repair-persist");
    const dir = join(home, "runs", REPAIR_ID);
    const state = readRepairState(dir);
    if (!state) throw new Error("missing state");
    writeRepairState(dir, {
      ...state,
      outerUsed: 1,
      publishLadder: "receipt",
      candidateSha: SHA,
      publishedSha: SHA,
      cycles: [{ n: 1, phase: "active" }],
      businessResult: null,
    });
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      ["resume", "--run", REPAIR_ID],
      out,
      loopOpts({
        bridge,
        reviewImpl: async () => {
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(bridge.publishCalls).toBe(0);
    expect(out.finished).toMatchObject({ businessResult: "approved" });
  });

  it("associates an already complete child review instead of reviewing again", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    seedCompleteReview(childId, { open: false, against: SOURCE_ID });
    saveDefaultProfile();
    let reviews = 0;
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      out,
      loopOpts({
        reviewImpl: async () => {
          reviews += 1;
          throw new Error("should not review");
        },
      }),
    );
    expect(reviews).toBe(0);
    expect(out.finished).toMatchObject({
      businessResult: "approved",
      latestReviewId: childId,
    });
  });

  it("needs attention when repair history disagrees with parent outerUsed", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      { wait: async () => {}, loop: false },
    );
    const { readRepairState, writeRepairState } = await import("../src/auto/repair-persist");
    const dir = join(home, "runs", REPAIR_ID);
    const state = readRepairState(dir);
    if (!state) throw new Error("missing state");
    writeRepairState(dir, { ...state, outerUsed: 2, historyCount: 3 });
    const out = makeSink();
    await expect(runRepair(["resume", "--run", REPAIR_ID], out, loopOpts())).rejects.toBeInstanceOf(
      RepairExit,
    );
    expect(out.finished).toMatchObject({ businessResult: "needs_attention" });
  });

  it("does not release the writer lease when stop still sees a live extra pid", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      { wait: async () => {}, loop: false },
    );
    const out = makeSink();
    await expect(
      runRepair(["stop", "--run", REPAIR_ID], out, {
        kill: () => {},
        writerPids: [4242],
        isPidAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({ leaseReleased: false, businessResult: "stopped" });
  });

  it("does not promote an incomplete follow-up to priorComplete", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({
          reviewImpl: async () => {
            seedCompleteReview(childId, { open: true, against: SOURCE_ID });
            writeFileSync(
              join(home, "runs", childId, "transcript.jsonl"),
              `${JSON.stringify({
                kind: "review.started",
                runId: childId,
                startedAt: "2026-09-20T00:00:00.000Z",
                task: { pr: PR_URL, against: SOURCE_ID },
              })}\n${JSON.stringify({
                kind: "review.finished",
                status: "failed",
                incomplete: true,
                endedAt: "2026-09-20T00:01:00.000Z",
              })}\n`,
            );
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    const { readRepairState } = await import("../src/auto/repair-persist");
    expect(readRepairState(join(home, "runs", REPAIR_ID))?.priorCompleteReviewId).not.toBe(childId);
  });

  it("fails closed when production has no squad bridge", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const out = makeSink();
    await expect(
      runRepair(["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID], out, {
        workspaceCwd: home,
        inspectPr: async () => inspectPr(),
        bridgeProbe: () => ({
          available: false,
          version: null,
          toolVersion: null,
          reason: "squadctl not on PATH; Squad 桥不可用",
          executable: null,
          skillDir: null,
          capabilities: [],
          historyContract: null,
          orchestrator: null,
        }),
        reviewImpl: async () => {
          throw new Error("should not review");
        },
      }),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "BRIDGE_VERSION_MISSING",
    });
    const { readRepairState } = await import("../src/auto/repair-persist");
    expect(readRepairState(join(home, "runs", REPAIR_ID))?.lastError).toContain("squadctl");
  });

  it("does not start squad until an incomplete source is supplemented", async () => {
    seedIncompleteReview(SOURCE_ID);
    saveDefaultProfile();
    const starts: string[] = [];
    const bridge = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    const orig = bridge.start.bind(bridge);
    bridge.start = (request) => {
      starts.push("start");
      return orig(request);
    };
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({
          bridge,
          reviewImpl: async () => ({
            runId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
            incomplete: true,
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(starts).toEqual([]);
    expect(out.finished).toMatchObject({ reasonCode: "coverage_incomplete" });
  });

  it("resumes an active cycle without creating a second handoff file", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const { createRepairHandoff } = await import("../src/auto/repair-handoff");
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      { wait: async () => {}, loop: false },
    );
    const { readRepairState, writeRepairState } = await import("../src/auto/repair-persist");
    const dir = join(home, "runs", REPAIR_ID);
    const state = readRepairState(dir);
    if (!state) throw new Error("missing state");
    createRepairHandoff({
      runId: REPAIR_ID,
      cycle: 1,
      body: { from: SOURCE_ID, cycle: 1 },
    });
    writeRepairState(dir, {
      ...state,
      outerUsed: 1,
      cycles: [{ n: 1, phase: "reserved" }],
      businessResult: null,
      reasonCode: null,
    });
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      ["resume", "--run", REPAIR_ID],
      out,
      loopOpts({
        reviewImpl: async () => {
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved", outerUsed: 1 });
  });

  it("does not approve when aggregator verdict contradicts a closed ledger", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({
          reviewImpl: async () => {
            seedCompleteReview(childId, { open: false, against: SOURCE_ID });
            writeFileSync(
              join(home, "runs", childId, "report.md"),
              "# review\n\nJury verdict: changes-requested\n",
            );
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({ reasonCode: "verdict_contradiction" });
  });

  it("re-inspects remote HEAD after review and fails on drift", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    let inspects = 0;
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({
          inspectPr: async () => {
            inspects += 1;
            if (inspects >= 3) return inspectPr("b".repeat(40));
            return inspectPr();
          },
          reviewImpl: async () => {
            seedCompleteReview(childId, { open: false, against: SOURCE_ID });
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(inspects).toBeGreaterThanOrEqual(3);
    expect(out.finished).toMatchObject({ reasonCode: "pr_drift" });
  });

  it("does not send a squadctl software version through production preflight", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({
          bridgeProbe: () => ({
            available: true,
            version: "squadctl 2.1.0",
            toolVersion: "squadctl 2.1.0",
            reason: null,
            executable: "/tmp/squadctl",
            skillDir: "/tmp/skill",
            capabilities: [],
            historyContract: null,
            orchestrator: null,
          }),
          reviewImpl: async () => {
            throw new Error("should not review");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "BRIDGE_VERSION_MISMATCH",
    });
  });

  it("accepts protocol squad-bridge.v1 while recording toolVersion squadctl 2.1.0", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      out,
      loopOpts({
        bridgeProbe: () => ({
          available: true,
          version: SQUAD_BRIDGE_CONTRACT_VERSION,
          toolVersion: "squadctl 2.1.0",
          reason: null,
          executable: "/tmp/squadctl",
          skillDir: "/tmp/skill",
          capabilities: [],
          historyContract: null,
          orchestrator: null,
        }),
        reviewImpl: async () => {
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved" });
  });

  it("persists cycle task identity before prepare so public stop can find the writer", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const fake = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    const stopped: string[] = [];
    const { readRepairState } = await import("../src/auto/repair-persist");
    const bridge = {
      start: (request: Parameters<FakeSquadBridge["start"]>[0]) => {
        const started = fake.start(request);
        if (!started.ok) return started;
        return { ...started, taskDir: join(home, "squad-tasks", started.taskId) };
      },
      prepare: async () => {
        const state = readRepairState(join(home, "runs", REPAIR_ID));
        expect(state?.currentSquadTaskId).toBeTruthy();
        expect(state?.cycles?.[0]?.squadTaskId).toBe(state?.currentSquadTaskId);
        expect(state?.cycles?.[0]?.squadTaskDir).toContain("squad-tasks");
        throw new Error(
          "injected crash boundary after real writer spawn before parent task persistence",
        );
      },
      resume: (request: { taskId: string }) => fake.resume(request),
      stop: (request: { taskId: string }) => {
        stopped.push(request.taskId);
        return fake.stop(request);
      },
      status: (request: { taskId: string }) => fake.status(request),
      requestPublish: (request: Parameters<FakeSquadBridge["requestPublish"]>[0]) =>
        fake.requestPublish(request),
      freezeOfficialGatePolicy: (request: { taskId: string }) =>
        fake.freezeOfficialGatePolicy(request),
      readOfficialGatePolicy: (request: { taskId: string }) => fake.readOfficialGatePolicy(request),
      writerPids: () => [],
    };
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({ bridge }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    const state = readRepairState(join(home, "runs", REPAIR_ID));
    expect(state?.currentSquadTaskId).toBeTruthy();
    expect(state?.cycles?.[0]?.squadTaskId).toBe(state?.currentSquadTaskId);
    const stopOut = makeSink();
    await expect(
      runRepair(["stop", "--run", REPAIR_ID], stopOut, loopOpts({ bridge, kill: () => {} })),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(stopped).toEqual([state?.currentSquadTaskId]);
    expect(stopOut.finished).toMatchObject({ leaseReleased: true });
  });

  it("reuses the original grant on resume and refuses a second start", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const fake = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    let starts = 0;
    const bridge = {
      start: (request: Parameters<FakeSquadBridge["start"]>[0]) => {
        starts += 1;
        if (starts > 1) throw new Error("probe stops before duplicate spawn");
        const started = fake.start(request);
        if (!started.ok) return started;
        return { ...started, taskDir: join(home, "squad-tasks", started.taskId) };
      },
      prepare: async () => {
        throw new Error(
          "injected crash boundary after real writer spawn before parent task persistence",
        );
      },
      resume: (request: { taskId: string }) => fake.resume(request),
      stop: (request: { taskId: string }) => fake.stop(request),
      status: (request: { taskId: string }) => fake.status(request),
      requestPublish: (request: Parameters<FakeSquadBridge["requestPublish"]>[0]) =>
        fake.requestPublish(request),
      freezeOfficialGatePolicy: (request: { taskId: string }) =>
        fake.freezeOfficialGatePolicy(request),
      readOfficialGatePolicy: (request: { taskId: string }) => fake.readOfficialGatePolicy(request),
      writerPids: () => [],
    };
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        makeSink(),
        loopOpts({ bridge }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    const grantPath = join(home, "runs", REPAIR_ID, "repair-grant.json");
    const grantBefore = JSON.parse(readFileSync(grantPath, "utf8")) as {
      grantHash: string;
      grantId: string;
    };
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const out = makeSink();
    await runRepair(
      ["resume", "--run", REPAIR_ID],
      out,
      loopOpts({
        bridge,
        reviewImpl: async () => {
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    const grantAfter = JSON.parse(readFileSync(grantPath, "utf8")) as {
      grantHash: string;
      grantId: string;
    };
    expect(grantAfter.grantHash).toBe(grantBefore.grantHash);
    expect(grantAfter.grantId).toBe(grantBefore.grantId);
    expect(starts).toBe(1);
    expect(out.finished).toMatchObject({ businessResult: "approved" });
  });

  it("fails at the production entry when squadctl lacks squad-history-bridge.v1", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const out = makeSink();
    await expect(
      runRepair(["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID], out, {
        workspaceCwd: home,
        inspectPr: async () => inspectPr(),
        bridgeProbe: () => ({
          available: true,
          version: SQUAD_BRIDGE_CONTRACT_VERSION,
          toolVersion: "squadctl 2.1.0",
          reason:
            "squadctl 可用，但未提供 squad-history-bridge.v1；跨 outer-cycle 修复需要升级 hengzhuo-engineering-squad。",
          executable: "/tmp/squadctl",
          skillDir: "/tmp/skill",
          capabilities: [],
          historyContract: null,
          orchestrator: null,
        }),
        reviewImpl: async () => {
          throw new Error("should not review");
        },
      }),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "HISTORY_INVALID",
    });
    const { readRepairState } = await import("../src/auto/repair-persist");
    expect(readRepairState(join(home, "runs", REPAIR_ID))?.outerUsed ?? 0).toBe(0);
  });

  it("fails closed on a second production subtask when the bridge cannot export history", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const fake = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    const bridge = Object.assign(fake, {
      prepare: async () => undefined,
    });
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({
          bridge,
          reviewImpl: async () => {
            const childId = `ck-review-${randomUUID()}`;
            seedCompleteReview(childId, { open: true, against: SOURCE_ID });
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "HISTORY_INVALID",
      outerUsed: 1,
    });
  });

  it("recovers a second cycle with the frozen history export instead of re-exporting", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    const fake = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    const deliveries: SquadBridgeDelivery[] = [];
    const prepared = new Set<string>();
    let exportCalls = 0;
    let journalSeq = 0;
    const envelopeFor = (taskDir: string, journalTaskId: string) => {
      const envelope = {
        schema_version: 1 as const,
        contract: "squad-history-bridge.v1" as const,
        complete: true as const,
        history: {
          schema_version: 1 as const,
          kind: "squad-repair-history" as const,
          project_id: "github.com/acme/repo",
          repair_chain_id: REPAIR_ID,
          source_hash: "b".repeat(64),
          entries: [
            {
              task_id: journalTaskId,
              ancestor_task_ids: [],
              journal_hash: "c".repeat(64),
              package_hash: "d".repeat(64),
              logical_rounds: [],
            },
          ],
        },
        origins: [
          {
            task_id: journalTaskId,
            task_dir: taskDir,
            journal_hash: "c".repeat(64),
            package_hash: "d".repeat(64),
          },
        ],
      };
      expect(parseHistoryEnvelope(envelope)).not.toBeNull();
      return envelope;
    };
    const bridge = {
      start: (request: Parameters<FakeSquadBridge["start"]>[0]) => {
        const started = fake.start(request);
        if (!started.ok) return started;
        const taskDir = join(home, "squad-tasks", started.taskId);
        mkdirSync(taskDir, { recursive: true });
        journalSeq += 1;
        const squadTaskId = `20260921-repair-aa${String(journalSeq).padStart(2, "0")}`;
        writeFileSync(
          join(taskDir, "councilkit-bridge.json"),
          `${JSON.stringify({
            taskId: started.taskId,
            squadTaskId,
            taskDir,
            nativeSession: null,
          })}\n`,
        );
        return { ...started, taskDir };
      },
      prepare: async (input: {
        taskId: string;
        delivery?: SquadBridgeDelivery;
      }) => {
        deliveries.push(input.delivery ?? ({} as SquadBridgeDelivery));
        if (deliveries.length === 2) {
          throw new Error("crash after parent persisted cycle-2 taskId");
        }
        prepared.add(input.taskId);
      },
      resume: (request: { taskId: string }) => {
        if (!prepared.has(request.taskId)) {
          return { taskId: request.taskId, event: mapSquadStatus(null, { stopped: true }) };
        }
        return fake.resume(request);
      },
      stop: (request: { taskId: string }) => fake.stop(request),
      status: (request: { taskId: string }) => fake.status(request),
      requestPublish: (request: Parameters<FakeSquadBridge["requestPublish"]>[0]) =>
        fake.requestPublish(request),
      exportHistory: (request: { taskId: string }) => {
        exportCalls += 1;
        const taskDir = join(home, "squad-tasks", request.taskId);
        const identity = JSON.parse(
          readFileSync(join(taskDir, "councilkit-bridge.json"), "utf8"),
        ) as { squadTaskId: string; taskDir: string };
        const envelope = envelopeFor(identity.taskDir, identity.squadTaskId);
        return {
          envelope,
          hash: historyEnvelopeHash(envelope),
          historyPath: join(taskDir, "councilkit-history-envelope.json"),
        };
      },
      freezeOfficialGatePolicy: (request: { taskId: string }) =>
        fake.freezeOfficialGatePolicy(request),
      readOfficialGatePolicy: (request: { taskId: string }) => fake.readOfficialGatePolicy(request),
      writerPids: () => [],
    };
    const out = makeSink();
    await expect(
      runRepair(
        ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
        out,
        loopOpts({
          bridge,
          reviewImpl: async () => {
            const childId = `ck-review-${randomUUID()}`;
            seedCompleteReview(childId, { open: true, against: SOURCE_ID });
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    const { readRepairState } = await import("../src/auto/repair-persist");
    const crashed = readRepairState(join(home, "runs", REPAIR_ID));
    const cycle2 = crashed?.cycles?.find((cycle) => cycle.n === 2);
    expect(cycle2?.squadTaskId).toBeTruthy();
    expect(cycle2?.historyExportPath).toMatch(/history\/.*\.json$/);
    expect(cycle2?.historyExportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(exportCalls).toBe(1);
    expect(deliveries[1]?.historyExportPath).toBeTruthy();
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const resumed = makeSink();
    await runRepair(
      ["resume", "--run", REPAIR_ID],
      resumed,
      loopOpts({
        bridge,
        reviewImpl: async () => {
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(exportCalls).toBe(1);
    const recovery = deliveries.at(-1);
    expect(recovery?.historyExportPath).toBe(cycle2?.historyExportPath);
    expect(recovery?.historyExportHash).toBe(cycle2?.historyExportHash);
    expect(recovery?.previousTaskId).toBe(crashed?.cycles?.[0]?.squadTaskId);
    expect(resumed.finished).toMatchObject({ businessResult: "approved", outerUsed: 2 });
  });

  it("lands official resume refusal as needs_attention without re-preparing", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      { wait: async () => {}, loop: false },
    );
    const { readRepairState, writeRepairState } = await import("../src/auto/repair-persist");
    const dir = join(home, "runs", REPAIR_ID);
    const state = readRepairState(dir);
    if (!state) throw new Error("missing state");
    const grant = createRepairGrant(loadRepairProfile("default"));
    writeFileSync(join(dir, "repair-grant.json"), `${JSON.stringify(grant)}\n`);
    const taskId = "squad-task-resume-refuse";
    const taskDir = join(home, "squad-tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "councilkit-bridge.json"),
      `${JSON.stringify({
        taskId,
        squadTaskId: "20260921-repair-dead",
        taskDir,
        nativeSession: "frozen-native-session",
        executionStatus: "stopped",
        stopped: true,
        executionId: "exec-frozen",
        orchestratorPid: null,
      })}\n`,
    );
    writeRepairState(dir, {
      ...state,
      outerUsed: 1,
      currentSquadTaskId: taskId,
      grantId: grant.grantId,
      grantHash: grant.grantHash,
      cycles: [{ n: 1, phase: "active", squadTaskId: taskId, squadTaskDir: taskDir }],
      businessResult: null,
      reasonCode: null,
      lastError: null,
    });
    let prepares = 0;
    let resumes = 0;
    const fake = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    const bridge = {
      start: () => {
        throw new Error("must not start a new squad task after resume refusal");
      },
      prepare: async () => {
        prepares += 1;
      },
      resume: async () => {
        resumes += 1;
        throw new Error(
          "squadctl resume failed: StateDriftError: bound repair history origins drifted",
        );
      },
      stop: (request: { taskId: string }) => fake.stop(request),
      status: (request: { taskId: string }) => fake.status(request),
      requestPublish: (request: Parameters<FakeSquadBridge["requestPublish"]>[0]) =>
        fake.requestPublish(request),
      freezeOfficialGatePolicy: (request: { taskId: string }) =>
        fake.freezeOfficialGatePolicy(request),
      readOfficialGatePolicy: (request: { taskId: string }) => fake.readOfficialGatePolicy(request),
      writerPids: () => [],
    };
    const out = makeSink();
    await expect(
      runRepair(["resume", "--run", REPAIR_ID], out, loopOpts({ bridge })),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(resumes).toBe(1);
    expect(prepares).toBe(0);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "squad_failed",
    });
    const finished = readRepairState(dir);
    expect(finished?.lastError).toMatch(/origins drifted/i);
    expect(finished?.businessResult).toBe("needs_attention");
    expect(finished?.currentSquadTaskId).toBe(taskId);
    const live = JSON.parse(readFileSync(join(dir, CLI_RUN_STATUS_FILE), "utf8")) as {
      status: string;
    };
    expect(live.status).not.toBe("running");
  });

  it("does not treat a launched stopped cycle as a prepare bypass", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    await runRepair(
      ["run", "--from", SOURCE_ID, "--profile", "default", "--run-id", REPAIR_ID],
      makeSink(),
      { wait: async () => {}, loop: false },
    );
    const { readRepairState, writeRepairState } = await import("../src/auto/repair-persist");
    const dir = join(home, "runs", REPAIR_ID);
    const state = readRepairState(dir);
    if (!state) throw new Error("missing state");
    const grant = createRepairGrant(loadRepairProfile("default"));
    writeFileSync(join(dir, "repair-grant.json"), `${JSON.stringify(grant)}\n`);
    const taskId = "squad-task-stopped-bypass";
    const taskDir = join(home, "squad-tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "councilkit-bridge.json"),
      `${JSON.stringify({
        taskId,
        squadTaskId: "20260921-repair-stop",
        taskDir,
        nativeSession: "already-launched",
        executionStatus: "stopped",
        stopped: true,
      })}\n`,
    );
    writeRepairState(dir, {
      ...state,
      outerUsed: 1,
      currentSquadTaskId: taskId,
      grantId: grant.grantId,
      grantHash: grant.grantHash,
      cycles: [{ n: 1, phase: "active", squadTaskId: taskId, squadTaskDir: taskDir }],
      businessResult: null,
      reasonCode: null,
    });
    let prepares = 0;
    const fake = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    const bridge = {
      start: () => {
        throw new Error("must not start after launched stop");
      },
      prepare: async () => {
        prepares += 1;
      },
      resume: () => ({
        taskId,
        event: mapSquadStatus(null, { stopped: true }),
      }),
      stop: (request: { taskId: string }) => fake.stop(request),
      status: (request: { taskId: string }) => fake.status(request),
      requestPublish: (request: Parameters<FakeSquadBridge["requestPublish"]>[0]) =>
        fake.requestPublish(request),
      freezeOfficialGatePolicy: (request: { taskId: string }) =>
        fake.freezeOfficialGatePolicy(request),
      readOfficialGatePolicy: (request: { taskId: string }) => fake.readOfficialGatePolicy(request),
      writerPids: () => [],
    };
    const out = makeSink();
    await expect(
      runRepair(["resume", "--run", REPAIR_ID], out, loopOpts({ bridge })),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(prepares).toBe(0);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "squad_failed",
    });
  });
});

function seedIncompleteReview(runId: string) {
  const dir = seedCompleteReview(runId, { open: true });
  writeFileSync(
    join(dir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "review.started",
      runId,
      startedAt: "2026-09-20T00:00:00.000Z",
      task: { pr: PR_URL },
    })}\n${JSON.stringify({
      kind: "review.finished",
      status: "completed",
      incomplete: true,
      endedAt: "2026-09-20T00:01:00.000Z",
    })}\n`,
  );
  writeFileSync(
    join(dir, "assessment-diagnostics.v1.json"),
    JSON.stringify({
      version: 1,
      kind: "councilkit-assessment-diagnostics",
      source: { runId, sha: SHA, requiredFindingIds: ["F-1"] },
      coverageComplete: false,
      items: [
        {
          findingId: "F-1",
          status: "missing",
          attemptId: "a1",
          errorClass: "missing",
          errorPath: "/F-1",
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({
      version: 1,
      status: "completed",
      progress: {
        phase: "done",
        attempts: [
          {
            attemptId: "attempt-0",
            agentName: "review-correctness",
            driverId: "grok-stream-json",
            modelId: "grok-4.6",
            role: "attempt",
            status: "failure",
            durationMs: 1,
            lastActivity: null,
          },
        ],
        updatedAt: "2026-09-20T00:01:00.000Z",
      },
      pipeline: null,
    }),
  );
  return dir;
}

function saveV2Profile(): void {
  saveRepairProfile({
    name: "v2",
    prUrl: PR,
    repo: "github.com/acme/repo",
    sourceBranch: "feat-x",
    base: "main",
    capabilities: ["push-source-branch"],
    protocolVersion: "v2",
    isolationMode: "collaborative",
  });
}

describe("repair v2 protocol", () => {
  it("refuses v2 without an explicit isolation mode", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    await expect(
      runRepair(
        [
          "run",
          "--from",
          SOURCE_ID,
          "--profile",
          "default",
          "--protocol",
          "v2",
          "--run-id",
          REPAIR_ID,
        ],
        makeSink(),
        { wait: async () => {}, loop: false },
      ),
    ).rejects.toThrow(/isolation/);
  });

  it("refuses full Squad pipeline strong isolation before writing source", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveDefaultProfile();
    await expect(
      runRepair(
        [
          "run",
          "--from",
          SOURCE_ID,
          "--profile",
          "default",
          "--protocol",
          "v2",
          "--isolation",
          "strong",
          "--run-id",
          REPAIR_ID,
        ],
        makeSink(),
        { wait: async () => {}, loop: false },
      ),
    ).rejects.toThrow(/full Squad pipeline strong isolation is unsupported/i);
  });

  it("reviews a local pinned SHA before publishing", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveV2Profile();
    const childId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const argvLog: string[][] = [];
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
      loopOpts({
        reviewImpl: async (argv) => {
          argvLog.push(argv);
          seedCompleteReview(childId, { open: false, against: SOURCE_ID });
          return { runId: childId };
        },
      }),
    );
    expect(out.finished).toMatchObject({ businessResult: "approved" });
    expect(argvLog[0]).toContain("--pin-sha");
    expect(argvLog[0]).toContain("--repo");
  });

  it("enters diagnosis after two valid failures of the same root cause", async () => {
    seedCompleteReview(SOURCE_ID, { open: true });
    saveV2Profile();
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
        loopOpts({
          reviewImpl: async () => {
            const childId = `ck-review-${randomUUID()}`;
            seedCompleteReview(childId, { open: true, against: SOURCE_ID });
            return { runId: childId };
          },
        }),
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "same_root_cause",
    });
    expect((out.finished as { outerUsed: number }).outerUsed).toBe(2);
  });
});
