import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RepairExecution,
  certifyDeadlineEnforced,
  createExecutionIntent,
  finishExecution,
  markExecutionStarted,
} from "@shared/runtime/repair-execution";
import { recoveryActionFor } from "@shared/runtime/repair-progress";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executionRecordPath,
  readExecutionRecord,
  writeExecutionRecord,
} from "../src/auto/repair-deadline-supervisor";
import { readRepairState, writeRepairState } from "../src/auto/repair-persist";
import {
  createRepairGrant,
  loadRepairProfile,
  saveRepairProfile,
} from "../src/auto/repair-profile";
import { FakeSquadBridge } from "../src/auto/squad-bridge";
import { RepairExit, runRepair } from "../src/commands/repair";
import type { RepairCommandDeps } from "../src/commands/repair";
import type { OutputSink } from "../src/output";

const SOURCE_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const REPAIR_ID = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
const PR_URL = "https://github.com/acme/repo/pull/9";
const SHA = "a".repeat(40);
const TASK_ID = "squad-task-terminal";

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

function baseExecution(): RepairExecution {
  return createExecutionIntent({
    executionId: `exec-${REPAIR_ID}-1`,
    kind: "source_fix",
    chainId: "ck-chain-terminal",
    parentRunId: REPAIR_ID,
    inputSha: SHA,
    contractVersion: 1,
    deadlineAtMs: Date.now() + 60_000,
  });
}

function terminalRecord(
  state: "deadline_enforced" | "failed" | "cancelled" | "completed",
): RepairExecution {
  const started = markExecutionStarted(baseExecution(), [7], 1);
  if (state === "deadline_enforced") return certifyDeadlineEnforced(started, started.deadlineAtMs);
  if (state === "completed") return finishExecution(started, "ok", started.deadlineAtMs);
  if (state === "cancelled") return finishExecution(started, "cancelled", started.deadlineAtMs);
  return finishExecution(started, "failed", started.deadlineAtMs);
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
  async function bootstrap(deps: RepairCommandDeps): Promise<string> {
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
      makeSink(),
      { ...deps, loop: false, wait: async () => {} },
    );
    return join(home, "runs", REPAIR_ID);
  }

  function arm(dir: string, squadTaskId: string | null): string {
    const state = readRepairState(dir);
    if (!state) throw new Error("missing repair state");
    const grant = createRepairGrant(loadRepairProfile("v2"));
    writeFileSync(join(dir, "repair-grant.json"), `${JSON.stringify(grant)}\n`);
    writeRepairState(dir, {
      ...state,
      outerUsed: 1,
      businessResult: null,
      reasonCode: null,
      lastError: null,
      grantId: grant.grantId,
      grantHash: grant.grantHash,
      cycles: [
        {
          n: 1,
          phase: "active",
          ...(squadTaskId
            ? { squadTaskId, squadTaskDir: join(home, "squad-tasks", squadTaskId) }
            : {}),
        },
      ],
    });
    return executionRecordPath(dir, `exec-${REPAIR_ID}-1`);
  }

  function depsFor(bridge: RepairCommandDeps["bridge"]): RepairCommandDeps {
    return {
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
  }

  it("does not resume a writer after the execution is deadline_enforced", async () => {
    const fake = new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
    let resumes = 0;
    const bridge = {
      start: () => {
        throw new Error("must not start");
      },
      prepare: async () => {
        throw new Error("must not prepare");
      },
      resume: (request: { taskId: string }) => {
        resumes += 1;
        return fake.resume(request);
      },
      stop: (request: { taskId: string }) => fake.stop(request),
      status: (request: { taskId: string }) => fake.status(request),
      requestPublish: (request: Parameters<FakeSquadBridge["requestPublish"]>[0]) =>
        fake.requestPublish(request),
      writerPids: () => [4242],
    };
    const deps = depsFor(bridge);
    const dir = await bootstrap(deps);
    const recordPath = arm(dir, TASK_ID);
    writeExecutionRecord(recordPath, terminalRecord("deadline_enforced"));
    const out = makeSink();
    await expect(runRepair(["resume", "--run", REPAIR_ID], out, deps)).rejects.toBeInstanceOf(
      RepairExit,
    );
    expect(resumes).toBe(0);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "deadline",
      lastError: "refusing to resume a deadline_enforced execution",
    });
    expect(readRepairState(dir)?.recoveryAction).toBe(recoveryActionFor("deadline"));
    expect(readExecutionRecord(recordPath)?.pids).toEqual([7]);
  });

  it.each(["failed", "cancelled", "completed"] as const)(
    "stores %s instead of the deadline recovery action",
    async (state) => {
      let resumes = 0;
      const bridge = {
        start: () => {
          throw new Error("must not start");
        },
        resume: () => {
          resumes += 1;
          throw new Error("must not resume");
        },
        stop: () => ({ kind: "stopped" as const }),
        status: () => {
          throw new Error("must not poll");
        },
        requestPublish: () => {
          throw new Error("must not publish");
        },
        writerPids: () => [4242],
      };
      const deps = depsFor(bridge);
      const dir = await bootstrap(deps);
      const recordPath = arm(dir, TASK_ID);
      writeExecutionRecord(recordPath, terminalRecord(state));
      const out = makeSink();
      await expect(runRepair(["resume", "--run", REPAIR_ID], out, deps)).rejects.toBeInstanceOf(
        RepairExit,
      );
      expect(resumes).toBe(0);
      expect(out.finished).toMatchObject({
        businessResult: "needs_attention",
        reasonCode: state,
        lastError: `refusing to resume a ${state} execution`,
      });
      expect(readRepairState(dir)?.recoveryAction).toBe(recoveryActionFor(state));
    },
  );

  it("stops a writer when the execution becomes terminal during resume", async () => {
    let resumes = 0;
    let stops = 0;
    const bridge = {
      start: () => {
        throw new Error("must not start");
      },
      resume: () => {
        resumes += 1;
        const current = readExecutionRecord(
          executionRecordPath(join(home, "runs", REPAIR_ID), `exec-${REPAIR_ID}-1`),
        );
        if (current === null) throw new Error("missing execution");
        writeExecutionRecord(
          executionRecordPath(join(home, "runs", REPAIR_ID), `exec-${REPAIR_ID}-1`),
          certifyDeadlineEnforced(current, current.deadlineAtMs),
        );
        return {
          taskId: TASK_ID,
          event: {
            kind: "running" as const,
            journal: {
              candidateSha: SHA,
              invalidated: false,
              independentReview: false,
              independentVerify: false,
              requiredGatesPassed: false,
              gatePolicyHash: "unknown",
            },
          },
        };
      },
      stop: () => {
        stops += 1;
        return { kind: "stopped" as const };
      },
      status: () => {
        throw new Error("must not poll a terminal execution");
      },
      requestPublish: () => {
        throw new Error("must not publish");
      },
      writerPids: () => [4242],
    };
    const deps = depsFor(bridge);
    const dir = await bootstrap(deps);
    const recordPath = arm(dir, TASK_ID);
    writeExecutionRecord(recordPath, markExecutionStarted(baseExecution(), [7], 1));
    const out = makeSink();
    await expect(runRepair(["resume", "--run", REPAIR_ID], out, deps)).rejects.toBeInstanceOf(
      RepairExit,
    );
    expect(resumes).toBe(1);
    expect(stops).toBe(1);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "deadline",
      lastError: "refusing to resume a deadline_enforced execution",
    });
    expect(readExecutionRecord(recordPath)?.state).toBe("deadline_enforced");
    expect(readExecutionRecord(recordPath)?.pids).toEqual([7]);
  });

  it("does not start a writer when the execution is already failed", async () => {
    let starts = 0;
    const bridge = {
      start: () => {
        starts += 1;
        return { ok: true as const, taskId: "squad-task-new" };
      },
      prepare: async () => {
        throw new Error("must not prepare");
      },
      resume: () => {
        throw new Error("must not resume");
      },
      stop: () => ({ kind: "stopped" as const }),
      status: () => {
        throw new Error("must not poll");
      },
      requestPublish: () => {
        throw new Error("must not publish");
      },
      writerPids: () => [4242],
    };
    const deps = depsFor(bridge);
    const dir = await bootstrap(deps);
    const recordPath = arm(dir, null);
    writeExecutionRecord(recordPath, terminalRecord("failed"));
    const out = makeSink();
    await expect(runRepair(["resume", "--run", REPAIR_ID], out, deps)).rejects.toBeInstanceOf(
      RepairExit,
    );
    expect(starts).toBe(0);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "failed",
      lastError: "refusing to start a failed execution",
    });
  });

  it("stops a writer when the execution becomes terminal during prepare", async () => {
    let starts = 0;
    let prepares = 0;
    let stops = 0;
    const bridge = {
      start: () => {
        starts += 1;
        return { ok: true as const, taskId: "squad-task-new", taskDir: join(home, "task") };
      },
      prepare: async () => {
        prepares += 1;
        const current = readExecutionRecord(
          executionRecordPath(join(home, "runs", REPAIR_ID), `exec-${REPAIR_ID}-1`),
        );
        if (current === null) throw new Error("missing execution");
        writeExecutionRecord(
          executionRecordPath(join(home, "runs", REPAIR_ID), `exec-${REPAIR_ID}-1`),
          certifyDeadlineEnforced(current, current.deadlineAtMs),
        );
      },
      resume: () => {
        throw new Error("must not resume");
      },
      stop: () => {
        stops += 1;
        return { kind: "stopped" as const };
      },
      status: () => {
        throw new Error("must not poll a terminal execution");
      },
      requestPublish: () => {
        throw new Error("must not publish");
      },
      writerPids: () => [4242],
    };
    const deps = depsFor(bridge);
    const dir = await bootstrap(deps);
    const recordPath = arm(dir, null);
    writeExecutionRecord(recordPath, markExecutionStarted(baseExecution(), [7], 1));
    const out = makeSink();
    await expect(runRepair(["resume", "--run", REPAIR_ID], out, deps)).rejects.toBeInstanceOf(
      RepairExit,
    );
    expect(starts).toBe(1);
    expect(prepares).toBe(1);
    expect(stops).toBe(1);
    expect(out.finished).toMatchObject({
      businessResult: "needs_attention",
      reasonCode: "deadline",
      lastError: "refusing to start a deadline_enforced execution",
    });
    expect(readExecutionRecord(recordPath)?.pids).toEqual([7]);
  });
});
