import { createHash } from "node:crypto";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRepairProfile } from "../src/auto/repair-profile";
import { runRepair } from "../src/commands/repair";
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
  const noWait = { wait: async () => {} };

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
    await runRepair(["stop", "--run", REPAIR_ID], stopOut, {
      kill: (pid, signal) => {
        killed.push({ pid, signal });
      },
    });
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
