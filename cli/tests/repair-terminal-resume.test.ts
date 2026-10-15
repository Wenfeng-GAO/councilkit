import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certifyDeadlineEnforced } from "@shared/runtime/repair-execution";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executionRecordPath,
  readExecutionRecord,
  writeExecutionRecord,
} from "../src/auto/repair-deadline-supervisor";
import { saveRepairProfile } from "../src/auto/repair-profile";
import { FakeSquadBridge } from "../src/auto/squad-bridge";
import { RepairExit, runRepair } from "../src/commands/repair";
import type { RepairCommandDeps } from "../src/commands/repair";
import type { OutputSink } from "../src/output";

const SOURCE_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const REPAIR_ID = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
const PR_URL = "https://github.com/acme/repo/pull/9";
const SHA = "a".repeat(40);

let home: string;
let previousHome: string | undefined;

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

function seedCompleteReview(runId: string): void {
  const dir = join(home, "runs", runId);
  mkdirSync(dir, { recursive: true });
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
      againstRunId: null,
      againstRange: null,
      findings: [
        {
          id: "F-1",
          title: "bug",
          severity: "major",
          status: "open",
          text: "bug",
          source: "consensus",
          reviewer: "R",
          files: ["src/file.ts"],
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
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-terminal-resume-"));
  previousHome = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("terminal repair resume", () => {
  it("does not resume a writer after the execution is deadline_enforced", async () => {
    seedCompleteReview(SOURCE_ID);
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
    const fake = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    let resumes = 0;
    let starts = 0;
    const bridge = {
      start: (request: Parameters<FakeSquadBridge["start"]>[0]) => {
        starts += 1;
        const started = fake.start(request);
        if (!started.ok) return started;
        return { ...started, taskDir: join(home, "squad-tasks", started.taskId) };
      },
      prepare: async () => {
        throw new Error("stop after the writer identity is stored");
      },
      resume: (request: { taskId: string }) => {
        resumes += 1;
        return fake.resume(request);
      },
      stop: (request: { taskId: string }) => fake.stop(request),
      status: (request: { taskId: string }) => fake.status(request),
      requestPublish: (request: Parameters<FakeSquadBridge["requestPublish"]>[0]) =>
        fake.requestPublish(request),
      freezeOfficialGatePolicy: (request: { taskId: string }) =>
        fake.freezeOfficialGatePolicy(request),
      readOfficialGatePolicy: (request: { taskId: string }) => fake.readOfficialGatePolicy(request),
      writerPids: () => [] as number[],
    };
    const deps: RepairCommandDeps = {
      workspaceCwd: home,
      inspectPr: async () => ({
        prUrl: PR_URL,
        host: "github",
        branch: "feat-x",
        cloneUrl: "github.com/acme/repo",
        baseBranch: "main",
        headSha: SHA,
        prOpen: true,
      }),
      bridge,
      sleep: async () => undefined,
      pollIntervalMs: 0,
    };
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
        makeSink(),
        deps,
      ),
    ).rejects.toBeInstanceOf(RepairExit);
    expect(starts).toBe(1);
    const recordPath = executionRecordPath(join(home, "runs", REPAIR_ID), `exec-${REPAIR_ID}-1`);
    const existing = readExecutionRecord(recordPath);
    expect(existing).not.toBeNull();
    if (existing === null) return;
    writeExecutionRecord(recordPath, certifyDeadlineEnforced(existing, existing.deadlineAtMs));
    const out = makeSink();
    await expect(runRepair(["resume", "--run", REPAIR_ID], out, deps)).rejects.toBeInstanceOf(
      RepairExit,
    );
    expect(resumes).toBe(0);
    expect(starts).toBe(1);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "deadline",
      lastError: "refusing to resume a deadline_enforced execution",
    });
  });
});
