/**
 * Disk writers for repair observation fixtures.
 * Emits real repair.json / status.json / bridge / Cursor JSONL / review sidecars.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import {
  BASE_B,
  CANDIDATE_C,
  CHILD_REVIEW_ID,
  CURRENT_ROUND,
  EXEC_BUILDER,
  EXEC_BUILDER_E1,
  EXEC_BUILDER_E2,
  EXEC_REVIEWER,
  EXEC_VERIFIER,
  type FixtureName,
  GOAL,
  OLD_CANDIDATE_A,
  PARENT_RUN_ID,
  PATH_SENTINEL,
  PR_URL,
  REPO,
  REVIEW_RUN_ID,
  SECRET_SENTINEL,
  SESSION_BUILDER,
  SESSION_REVIEWER,
  SESSION_VERIFIER,
  SOURCE_FIX_MAX,
  SOURCE_FIX_USED,
  SOURCE_REVIEW_ID,
  SQUAD_RUN_ID,
  T0_ISO,
  T0_MS,
  TASK_ID_ROUND1,
  TASK_ID_ROUND2,
  XSS_PAYLOAD,
} from "../constants";
import {
  type CursorLine,
  editCompleted,
  editStarted,
  lineJson,
  linesJson,
  readCompleted,
  readStarted,
  shellCompleted,
  shellStarted,
  textProgress,
  thinkingBlock,
  toolCompleted,
  toolStarted,
} from "./cursor-events";

export interface ProcessEvidence {
  pid: number;
  pgid: number;
  startKey: string;
  checkedAt: string;
}

export interface FixtureWriteResult {
  home: string;
  runId: string;
  taskDirRound1: string;
  taskDirRound2: string;
  sourceReviewId: string;
  childReviewId: string;
  logBytes?: number;
  operationCount?: number;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
}

function appendText(path: string, text: string): void {
  ensureDir(dirname(path));
  appendFileSync(path, text, { encoding: "utf8", mode: 0o600 });
}

function goalFingerprint(): string {
  return createHash("sha256").update(GOAL, "utf8").digest("hex");
}

function defaultBudget(overrides: Record<string, unknown> = {}) {
  return {
    sourceFixUsed: SOURCE_FIX_USED,
    sourceFixMax: SOURCE_FIX_MAX,
    planRetryUsed: 0,
    planRetryMax: 3,
    verifyRetryUsed: 0,
    verifyRetryMax: 5,
    formatRetryUsed: 0,
    formatRetryMax: 3,
    diagnoseRetryUsed: 0,
    diagnoseRetryMax: 2,
    diagnoseMs: 15 * 60 * 1000,
    deadlineMs: 2 * 60 * 60 * 1000,
    reservedFinalMs: 40 * 60 * 1000,
    startedAtMs: T0_MS - 30 * 60 * 1000,
    tokenUsed: null,
    ...overrides,
  };
}

function baseRepairState(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    casVersion: 1,
    sourceRunId: SOURCE_REVIEW_ID,
    profileName: "e2e-repair-obs",
    outerUsed: 2,
    outerMax: 10,
    timeoutMs: null,
    businessResult: null,
    reasonCode: null,
    prUrl: PR_URL,
    priorCompleteReviewId: null,
    latestReviewId: SOURCE_REVIEW_ID,
    currentSquadTaskId: TASK_ID_ROUND2,
    candidateSha: CANDIDATE_C,
    publishedSha: null,
    lastRemoteHead: BASE_B,
    frozenBaseSha: BASE_B,
    goalSummary: GOAL,
    goalFingerprint: goalFingerprint(),
    protocolVersion: "v2",
    isolationMode: "collaborative",
    budget: defaultBudget(),
    remainingBudget: `source-fix ${SOURCE_FIX_MAX - SOURCE_FIX_USED}/${SOURCE_FIX_MAX}`,
    acceptanceCoverage: null,
    recoveryAction: null,
    cycles: [
      {
        n: 1,
        phase: "closed",
        childReviewId: null,
        squadTaskId: TASK_ID_ROUND1,
        squadTaskDir: null as string | null,
        previousTaskId: null,
        previousTaskDir: null,
      },
      {
        n: 2,
        phase: "active",
        childReviewId: null,
        squadTaskId: TASK_ID_ROUND2,
        squadTaskDir: null as string | null,
        previousTaskId: TASK_ID_ROUND1,
        previousTaskDir: null,
      },
    ],
    executions: [],
    ...overrides,
  };
}

function writeStatus(
  runDir: string,
  input: { status?: string; phase?: string; updatedAt?: string } = {},
): void {
  writeJson(join(runDir, "status.json"), {
    version: 1,
    status: input.status ?? "running",
    progress: {
      phase: input.phase ?? "repair-building",
      attempts: [],
      updatedAt: input.updatedAt ?? T0_ISO,
    },
    pipeline: null,
  });
}

function writeRepairTranscript(runDir: string, startedAt = T0_ISO): void {
  writeText(
    join(runDir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "repair.started",
      version: 1,
      runId: PARENT_RUN_ID,
      startedAt,
      sourceRunId: SOURCE_REVIEW_ID,
      profileName: "e2e-repair-obs",
    })}\n`,
  );
  writeText(
    join(runDir, "report.md"),
    `# Repair Report\n\n目标：${GOAL}\n\nPR：${PR_URL}\n`,
  );
  writeText(join(runDir, "journal.jsonl"), "");
}

function writeReviewSidecar(
  home: string,
  runId: string,
  opts: {
    title: string;
    status?: string;
    attempts?: Array<Record<string, unknown>>;
    withLive?: boolean;
  },
): void {
  const dir = join(home, "runs", runId);
  ensureDir(dir);
  const attempts =
    opts.attempts ??
    ["security", "correctness", "maintainability", "adversarial", "cursor"].map((seat, index) => ({
      attemptId: `attempt-${seat}`,
      agentId: `agent-${seat}`,
      agentName: `review-${seat}`,
      driverId: index === 4 ? "cursor-stream-json" : "kimi-stream-json",
      modelId: index === 4 ? "auto" : "kimi-code/k3",
      status: "completed",
    }));
  writeText(
    join(dir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "review.started",
      version: 1,
      runId,
      startedAt: T0_ISO,
      task: { task: opts.title, prUrl: PR_URL, repo: REPO },
      attempts,
      aggregator: {
        attemptId: "aggregator",
        agentId: "agent-correctness",
        agentName: "review-correctness",
        driverId: "kimi-stream-json",
        modelId: "kimi-code/k3",
      },
    })}\n${JSON.stringify({
      kind: "review.finished",
      version: 1,
      status: opts.status ?? "completed",
      endedAt: T0_ISO,
      incomplete: false,
    })}\n`,
  );
  writeText(join(dir, "report.md"), `# Review\n\n${opts.title}\n`);
  writeJson(join(dir, "status.json"), {
    version: 1,
    status: opts.status ?? "completed",
    progress: { phase: "done", attempts: [], updatedAt: T0_ISO },
    pipeline: null,
  });
  if (opts.withLive) {
    const liveDir = join(dir, "live");
    ensureDir(liveDir);
    for (const attempt of attempts) {
      const id = String(attempt.attemptId);
      writeText(
        join(liveDir, `${id}.jsonl`),
        `${JSON.stringify({
          seq: 1,
          at: T0_ISO,
          type: "text.delta",
          text: `live for ${id}`,
        })}\n`,
      );
    }
  }
}

function writeSquadSidecar(home: string): void {
  const dir = join(home, "runs", SQUAD_RUN_ID);
  ensureDir(dir);
  writeText(
    join(dir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "squad.started",
      version: 1,
      runId: SQUAD_RUN_ID,
      startedAt: T0_ISO,
      phase: "done",
    })}\n`,
  );
  writeText(join(dir, "report.md"), "# Squad observe\n\nreadonly sidecar\n");
  writeJson(join(dir, "status.json"), {
    version: 1,
    status: "completed",
    progress: { phase: "done", attempts: [], updatedAt: T0_ISO },
    pipeline: null,
  });
  writeText(join(dir, "brief.md"), "# Brief\n");
  writeText(join(dir, "plan.md"), "# Plan\n");
}

function bridgeIdentity(input: {
  taskId: string;
  taskDir: string;
  executionId: string;
  sessionId: string | null;
  model: string;
  observedModel?: string | null;
  process?: ProcessEvidence | null;
  executionStatus?: "running" | "failed" | "stopped";
  stopped?: boolean;
}): Record<string, unknown> {
  const process =
    input.process === undefined
      ? {
          pid: 4242,
          pgid: 4242,
          startKey: "start-key-builder",
        }
      : input.process === null
        ? null
        : {
            pid: input.process.pid,
            pgid: input.process.pgid,
            startKey: input.process.startKey,
          };
  return {
    taskId: input.taskId,
    squadTaskId: input.taskId,
    taskDir: input.taskDir,
    workspaceCwd: join(input.taskDir, "workspace"),
    requestedRuntime: "cursor",
    actualRuntime: "cursor-agent",
    model: input.model,
    observedModel: input.observedModel === undefined ? input.model : input.observedModel,
    requestedSession: input.sessionId,
    nativeSession: input.sessionId,
    orchestratorPid: process?.pid ?? null,
    writerPids: process ? [process.pid] : [],
    skillVersion: "e2e-1",
    skillDir: null,
    squadctlPath: null,
    packagePath: null,
    delivery: {
      repo: REPO,
      prUrl: PR_URL,
      sourceSha: BASE_B,
    },
    stopped: input.stopped ?? false,
    executionStatus: input.executionStatus ?? "running",
    failReason: null,
    process,
    processGroup: process ? [process] : [],
    observedExitCode: null,
    observedSignal: null,
    executionId: input.executionId,
    toolVersion: "e2e",
  };
}

function writeBridgeTask(
  home: string,
  taskId: string,
  opts: {
    executionId: string;
    sessionId: string | null;
    model?: string;
    observedModel?: string | null;
    process?: ProcessEvidence | null;
    log?: string;
    executionStatus?: "running" | "failed" | "stopped";
    stopped?: boolean;
    adapterRuns?: Array<{ role: string; sessionId: string; callIdClash?: string }>;
  },
): string {
  const taskDir = join(home, "squad-tasks", taskId);
  ensureDir(join(taskDir, "workspace"));
  writeJson(
    join(taskDir, "councilkit-bridge.json"),
    bridgeIdentity({
      taskId,
      taskDir,
      executionId: opts.executionId,
      sessionId: opts.sessionId,
      model: opts.model ?? "composer-2.5",
      observedModel: opts.observedModel,
      process: opts.process,
      executionStatus: opts.executionStatus,
      stopped: opts.stopped,
    }),
  );
  if (opts.log !== undefined) {
    writeText(join(taskDir, "orchestrator.log"), opts.log);
  } else if (!existsSync(join(taskDir, "orchestrator.log"))) {
    writeText(join(taskDir, "orchestrator.log"), "");
  }
  // Official adapter run/receipt sidecars (independent reviewer/verifier).
  for (const run of opts.adapterRuns ?? []) {
    const runDir = join(taskDir, "adapter-runs", run.role);
    ensureDir(runDir);
    writeJson(join(runDir, "run.json"), {
      role: run.role,
      sessionId: run.sessionId,
      model: "composer-2.5",
      executionId: `${opts.executionId}-${run.role}`,
      worktree: join(taskDir, "worktrees", run.role),
    });
    writeJson(join(runDir, "receipt.json"), {
      role: run.role,
      passed: run.role === "verifier" ? false : true,
      assertions: [
        { id: "a-pass", status: "passed", source: "independent-reviewer" },
        { id: "a-fail", status: "failed", source: "independent-reviewer" },
        { id: "a-pending", status: "pending", source: "independent-reviewer" },
        { id: "a-insufficient", status: "evidence_insufficient", source: "independent-reviewer" },
      ],
      callIdClash: run.callIdClash ?? null,
    });
    writeText(
      join(runDir, "events.jsonl"),
      linesJson([
        textProgress(`${run.role} started`, { sessionId: run.sessionId, at: T0_ISO }),
        toolStarted(run.callIdClash ?? `call-${run.role}-1`, "shellToolCall", {
          command: `echo ${run.role}`,
        }, { sessionId: run.sessionId, at: T0_ISO }),
      ]),
    );
  }
  return taskDir;
}

function f1BuilderLog(): string {
  const s = SESSION_BUILDER;
  const at = (offsetSec: number) => new Date(T0_MS + offsetSec * 1000).toISOString();
  const lines: CursorLine[] = [
    textProgress("编排：恢复会话并规划修复", {
      sessionId: s,
      at: at(0),
      model: "composer-2.5",
      roleHint: "orchestrator",
    }),
    textProgress("Planner A：拆分停机恢复步骤", {
      sessionId: s,
      at: at(1),
      model: "composer-2.5",
      roleHint: "planner_a",
    }),
    textProgress("Coder：开始修改恢复路径", {
      sessionId: s,
      at: at(2),
      model: "composer-2.5",
      roleHint: "coder",
    }),
    readStarted("call_read_session", "src/session/resume.ts", { sessionId: s, at: at(3) }),
    readCompleted("call_read_session", "src/session/resume.ts", "export function resume() {}", {
      sessionId: s,
      at: at(4),
    }),
    editStarted("call_edit_session", "src/session/resume.ts", { sessionId: s, at: at(5) }),
    editCompleted(
      "call_edit_session",
      "src/session/resume.ts",
      "@@ -1,1 +1,3 @@\n+retry safe\n export function resume() {}",
      { sessionId: s, at: at(6) },
    ),
    shellStarted("call_shell_test", "pnpm test --filter session", { sessionId: s, at: at(7) }),
    shellCompleted("call_shell_test", "pnpm test --filter session", "ok\n", 0, {
      sessionId: s,
      at: at(8),
    }),
    // Same tool name twice with distinct callIds (pairing must use callId).
    shellStarted("call_shell_a", "echo alpha", { sessionId: s, at: at(9) }),
    shellStarted("call_shell_b", "echo beta", { sessionId: s, at: at(10) }),
    shellCompleted("call_shell_a", "echo alpha", "alpha\n", 0, { sessionId: s, at: at(11) }),
    shellCompleted("call_shell_b", "echo beta", "beta\n", 0, { sessionId: s, at: at(12) }),
    textProgress("公开进展：session 恢复路径已接线", { sessionId: s, at: at(13) }),
  ];
  return linesJson(lines);
}

function f2ParallelLog(): { builder: string; reviewer: string; verifier: string } {
  const at = (offsetSec: number) => new Date(T0_MS + offsetSec * 1000).toISOString();
  return {
    builder: linesJson([
      textProgress("Builder 已提交候选", {
        sessionId: SESSION_BUILDER,
        at: at(0),
        roleHint: "coder",
      }),
      shellCompleted("call_builder_done", "git rev-parse HEAD", `${CANDIDATE_C}\n`, 0, {
        sessionId: SESSION_BUILDER,
        at: at(1),
      }),
    ]),
    reviewer: linesJson([
      textProgress("独立 Reviewer 开始审查", {
        sessionId: SESSION_REVIEWER,
        at: at(2),
        model: "composer-2.5",
      }),
      shellStarted("call_rev_cmd", "pnpm test", { sessionId: SESSION_REVIEWER, at: at(3) }),
      shellCompleted(
        "call_rev_cmd",
        "pnpm test",
        "FAIL src/session.test.ts\nExpected retry to be idempotent\n".repeat(40),
        1,
        { sessionId: SESSION_REVIEWER, at: at(4) },
      ),
    ]),
    verifier: linesJson([
      textProgress("独立 Verifier 并行核验", {
        sessionId: SESSION_VERIFIER,
        at: at(2),
        model: "composer-2.5",
      }),
      shellStarted("call_ver_cmd", "pnpm verify", { sessionId: SESSION_VERIFIER, at: at(5) }),
      shellCompleted("call_ver_cmd", "pnpm verify", "VERIFY OK\n", 0, {
        sessionId: SESSION_VERIFIER,
        at: at(6),
      }),
    ]),
  };
}

function writeEvidencePack(
  taskDir: string,
  opts: {
    candidateSha: string;
    baseSha: string;
    approved?: boolean;
    missingSha?: boolean;
    bindOldCandidate?: boolean;
    assertionVersion?: string;
  },
): void {
  const evidenceDir = join(taskDir, "evidence");
  ensureDir(evidenceDir);
  writeJson(join(evidenceDir, "acceptance.json"), {
    round: CURRENT_ROUND,
    candidateSha: opts.bindOldCandidate ? OLD_CANDIDATE_A : opts.candidateSha,
    baseSha: opts.baseSha,
    assertionVersion: opts.assertionVersion ?? "assert-v2",
    verifiedAt: opts.approved ? T0_ISO : null,
    assertions: opts.approved && !opts.bindOldCandidate && !opts.missingSha
      ? [
          { id: "cov-1", title: "恢复后会话可重试", status: "passed", source: "gate" },
          { id: "cov-2", title: "不重复扣预算", status: "passed", source: "gate" },
          { id: "cov-3", title: "远端身份核验", status: "passed", source: "gate" },
          { id: "cov-4", title: "证据完整", status: "passed", source: "gate" },
        ]
      : [
          { id: "cov-1", title: "恢复后会话可重试", status: "passed", source: "gate" },
          { id: "cov-2", title: "不重复扣预算", status: "failed", source: "gate" },
          { id: "cov-3", title: "远端身份核验", status: "pending", source: "gate" },
          { id: "cov-4", title: "证据完整", status: "evidence_insufficient", source: "gate" },
        ],
    frozenDenominator: 4,
  });
  if (opts.approved) {
    writeJson(join(evidenceDir, "gate.json"), {
      businessResult: "approved",
      candidateSha: opts.missingSha ? null : opts.candidateSha,
      baseSha: opts.baseSha,
      verifiedAt: T0_ISO,
      assertionVersion: opts.assertionVersion ?? "assert-v2",
    });
  }
}

export function appendOrchestratorLines(
  home: string,
  taskId: string,
  lines: CursorLine[] | string,
): { bytesWritten: number; path: string } {
  const path = join(home, "squad-tasks", taskId, "orchestrator.log");
  const text = typeof lines === "string" ? lines : linesJson(lines);
  appendText(path, text);
  return { bytesWritten: Buffer.byteLength(text, "utf8"), path };
}

export function rotateOrchestratorLog(
  home: string,
  taskId: string,
  opts: { generation?: string } = {},
): { generation: string; path: string } {
  const taskDir = join(home, "squad-tasks", taskId);
  const path = join(taskDir, "orchestrator.log");
  const generation = opts.generation ?? `gen-${Date.now()}`;
  const archive = join(taskDir, `orchestrator.${generation}.log`);
  if (existsSync(path)) {
    renameSync(path, archive);
  }
  writeText(path, "");
  writeJson(join(taskDir, "source-generation.json"), { generation, rotatedAt: new Date().toISOString() });
  return { generation, path };
}

export async function writeLargeF9Log(path: string): Promise<{ bytes: number; operations: number }> {
  ensureDir(dirname(path));
  const stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 });
  const operations = 100_000;
  let bytes = 0;
  const bigOutput = "X".repeat(70 * 1024);
  for (let i = 0; i < operations; i += 1) {
    const at = new Date(T0_MS + i * 10).toISOString();
    let line: string;
    if (i === 42) {
      // Single oversized record (>1MiB) — product must isolate.
      line = lineJson(
        textProgress(`oversized-${i}:${"Y".repeat(1_100_000)}`, {
          sessionId: SESSION_BUILDER,
          at,
        }),
      );
    } else if (i % 500 === 0) {
      line = lineJson(
        shellCompleted(`call_big_${i}`, `echo big-${i}`, bigOutput, 0, {
          sessionId: SESSION_BUILDER,
          at,
        }),
      );
    } else {
      line = lineJson(
        textProgress(`op-${i} session progress`, {
          sessionId: SESSION_BUILDER,
          at,
          roleHint: "coder",
        }),
      );
    }
    bytes += Buffer.byteLength(line, "utf8");
    if (!stream.write(line)) {
      await new Promise<void>((resolve) => stream.once("drain", resolve));
    }
  }
  stream.end();
  await finished(stream);
  return { bytes, operations };
}

export async function materializeFixture(
  home: string,
  name: FixtureName,
  opts: { process?: ProcessEvidence | null } = {},
): Promise<FixtureWriteResult> {
  ensureDir(home);
  ensureDir(join(home, "runs"));
  ensureDir(join(home, "squad-tasks"));

  // Minimal agents/councils so Host list routes stay healthy.
  writeJson(join(home, "agents.json"), {
    format: "councilkit-agents",
    version: 1,
    agents: [],
  });
  writeJson(join(home, "councils.json"), {
    format: "councilkit-councils",
    version: 1,
    councils: [],
  });

  writeReviewSidecar(home, SOURCE_REVIEW_ID, {
    title: "source baseline review",
    withLive: true,
  });

  const runDir = join(home, "runs", PARENT_RUN_ID);
  ensureDir(runDir);
  writeRepairTranscript(runDir);
  writeStatus(runDir);

  const process =
    opts.process === undefined
      ? {
          pid: 4242,
          pgid: 4242,
          startKey: "start-key-builder",
          checkedAt: T0_ISO,
        }
      : opts.process;

  let taskDirRound1 = join(home, "squad-tasks", TASK_ID_ROUND1);
  let taskDirRound2 = join(home, "squad-tasks", TASK_ID_ROUND2);
  let logBytes: number | undefined;
  let operationCount: number | undefined;

  const bindCycles = (state: Record<string, unknown>, d1: string, d2: string) => {
    const cycles = (state.cycles as Array<Record<string, unknown>>) ?? [];
    if (cycles[0]) {
      cycles[0].squadTaskDir = d1;
      cycles[0].squadTaskId = TASK_ID_ROUND1;
    }
    if (cycles[1]) {
      cycles[1].squadTaskDir = d2;
      cycles[1].squadTaskId = TASK_ID_ROUND2;
    }
    state.cycles = cycles;
    return state;
  };

  switch (name) {
    case "F0": {
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process,
        log: "",
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        executionStatus: "stopped",
        stopped: true,
        log: linesJson([textProgress("round1 archived", { sessionId: "B0", at: T0_ISO })]),
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(baseRepairState(), taskDirRound1, taskDirRound2),
      );
      break;
    }
    case "F1":
    case "F4": {
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process,
        log: f1BuilderLog(),
        observedModel: "composer-2.5",
        model: "auto",
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: linesJson([textProgress("round1 done", { sessionId: "B0", at: T0_ISO })]),
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(baseRepairState(), taskDirRound1, taskDirRound2),
      );
      break;
    }
    case "F2": {
      const logs = f2ParallelLog();
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process,
        log: logs.builder,
        adapterRuns: [
          { role: "reviewer", sessionId: SESSION_REVIEWER, callIdClash: "shared-call-id" },
          { role: "verifier", sessionId: SESSION_VERIFIER, callIdClash: "shared-call-id" },
        ],
      });
      // Independent session logs for reviewer/verifier roles.
      writeText(join(taskDirRound2, "reviewer.session.jsonl"), logs.reviewer);
      writeText(join(taskDirRound2, "verifier.session.jsonl"), logs.verifier);
      appendText(join(taskDirRound2, "orchestrator.log"), logs.reviewer);
      appendText(join(taskDirRound2, "orchestrator.log"), logs.verifier);
      writeEvidencePack(taskDirRound2, { candidateSha: CANDIDATE_C, baseSha: BASE_B });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(baseRepairState(), taskDirRound1, taskDirRound2),
      );
      break;
    }
    case "F3": {
      const silentAt = new Date(T0_MS - 228_000).toISOString();
      const heartbeatAt = new Date(T0_MS - 8_000).toISOString();
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process: process
          ? { ...process, checkedAt: heartbeatAt }
          : { pid: 4242, pgid: 4242, startKey: "start-key-builder", checkedAt: heartbeatAt },
        log: linesJson([
          textProgress("最后有效活动", { sessionId: SESSION_BUILDER, at: silentAt }),
        ]),
      });
      writeJson(join(taskDirRound2, "process-heartbeat.json"), {
        checkedAt: heartbeatAt,
        pid: 4242,
        pgid: 4242,
        startKey: "start-key-builder",
        alive: true,
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(baseRepairState(), taskDirRound1, taskDirRound2),
      );
      break;
    }
    case "F3b": {
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process: { pid: 4242, pgid: 4242, startKey: "old-start-key", checkedAt: T0_ISO },
        log: linesJson([
          textProgress("历史活动保留", { sessionId: SESSION_BUILDER, at: T0_ISO }),
        ]),
      });
      writeJson(join(taskDirRound2, "process-heartbeat.json"), {
        checkedAt: new Date(T0_MS - 60_000).toISOString(),
        pid: 4242,
        pgid: 4242,
        startKey: "different-start-key",
        alive: true,
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(baseRepairState(), taskDirRound1, taskDirRound2),
      );
      break;
    }
    case "F5":
    case "F5b-recoverable":
    case "F5b-budget":
    case "F5b-unknown": {
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_REVIEWER,
        sessionId: SESSION_REVIEWER,
        process,
        log: linesJson([
          textProgress("独立评审额度错误", {
            sessionId: SESSION_REVIEWER,
            at: T0_ISO,
          }),
          shellCompleted(
            "call_quota",
            "cursor-agent",
            `quota exceeded token=${SECRET_SENTINEL}`,
            1,
            { sessionId: SESSION_REVIEWER, at: T0_ISO },
          ),
        ]),
        executionStatus: "failed",
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      const recoverable = name === "F5" || name === "F5b-recoverable";
      const budgetExhausted = name === "F5b-budget";
      const identityUnknown = name === "F5b-unknown";
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(
          baseRepairState({
            businessResult: "needs_attention",
            reasonCode: "independent_review_quota",
            recoveryAction: recoverable
              ? "可恢复：更换独立评审席后继续"
              : budgetExhausted
                ? "预算耗尽，不可再修一次"
                : "执行身份未知，不可恢复",
            resumeEligible: recoverable,
            budget: defaultBudget({
              sourceFixUsed: budgetExhausted ? SOURCE_FIX_MAX : SOURCE_FIX_USED,
            }),
            lastError: identityUnknown ? "execution identity unknown" : "reviewer quota exhausted",
          }),
          taskDirRound1,
          taskDirRound2,
        ),
      );
      writeJson(join(taskDirRound2, "quota-steps.json"), {
        readonly: true,
        steps: [
          "确认账户额度",
          "说明 v2 预算继承限制：旧 session 不能跨模型恢复",
          "同链新 parent 可继承 CouncilKit 预算，但不会复制未提交改动",
        ],
      });
      break;
    }
    case "F6": {
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: linesJson([
          textProgress("本地候选完成", { sessionId: SESSION_BUILDER, at: T0_ISO }),
        ]),
      });
      writeEvidencePack(taskDirRound2, { candidateSha: CANDIDATE_C, baseSha: BASE_B });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(
          baseRepairState({
            businessResult: null,
            reasonCode: "candidate_ready_awaiting_gate",
            candidateSha: CANDIDATE_C,
          }),
          taskDirRound1,
          taskDirRound2,
        ),
      );
      writeStatus(runDir, { status: "running", phase: "repair-finalizing" });
      break;
    }
    case "F6a": {
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: linesJson([textProgress("准出核验完成", { sessionId: SESSION_BUILDER, at: T0_ISO })]),
      });
      writeEvidencePack(taskDirRound2, {
        candidateSha: CANDIDATE_C,
        baseSha: BASE_B,
        approved: true,
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(
          baseRepairState({
            businessResult: "approved",
            reasonCode: "gate_passed",
            candidateSha: CANDIDATE_C,
            publishedSha: CANDIDATE_C,
            acceptanceCoverage: "4/4",
          }),
          taskDirRound1,
          taskDirRound2,
        ),
      );
      writeStatus(runDir, { status: "completed", phase: "done" });
      break;
    }
    case "F6b": {
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: linesJson([textProgress("准出声明但证据冲突", { sessionId: SESSION_BUILDER, at: T0_ISO })]),
      });
      writeEvidencePack(taskDirRound2, {
        candidateSha: CANDIDATE_C,
        baseSha: BASE_B,
        approved: true,
        missingSha: true,
        bindOldCandidate: true,
        assertionVersion: "assert-v1-old",
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(
          baseRepairState({
            businessResult: "approved",
            reasonCode: "gate_passed",
            candidateSha: CANDIDATE_C,
          }),
          taskDirRound1,
          taskDirRound2,
        ),
      );
      writeStatus(runDir, { status: "completed", phase: "done" });
      break;
    }
    case "F7": {
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: linesJson([
          textProgress("第1轮历史活动", { sessionId: "B0", at: T0_ISO }),
          textProgress("第1轮 PASS 声明", { sessionId: "B0", at: T0_ISO }),
        ]),
      });
      writeEvidencePack(taskDirRound1, {
        candidateSha: OLD_CANDIDATE_A,
        baseSha: BASE_B,
        approved: true,
      });
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process,
        log: f1BuilderLog(),
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(baseRepairState(), taskDirRound1, taskDirRound2),
      );
      break;
    }
    case "F8":
    case "F8-secret":
    case "F8-private":
    case "F8-xss":
    case "F8-path": {
      const at = (s: number) => new Date(T0_MS + s * 1000).toISOString();
      const lines: CursorLine[] = [
        // Interleaved same-name tools + replay.
        shellStarted("call_x1", "echo one", { sessionId: SESSION_BUILDER, at: at(0) }),
        shellStarted("call_x2", "echo one", { sessionId: SESSION_BUILDER, at: at(1) }),
        shellCompleted("call_x1", "echo one", "one-a\n", 0, { sessionId: SESSION_BUILDER, at: at(2) }),
        shellCompleted("call_x2", "echo one", "one-b\n", 0, { sessionId: SESSION_BUILDER, at: at(3) }),
        // Replay of call_x1 completed
        shellCompleted("call_x1", "echo one", "one-a\n", 0, { sessionId: SESSION_BUILDER, at: at(4) }),
        // Unfinished tool
        shellStarted("call_hang", "sleep 999", { sessionId: SESSION_BUILDER, at: at(5) }),
        // Missing occurredAt
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "无时间戳事件" }] }, session_id: SESSION_BUILDER },
        // E1 then switch — late E1 completion added by producer in tests
        textProgress("execution E1 work", {
          sessionId: SESSION_BUILDER,
          at: at(6),
          roleHint: "coder",
        }),
      ];
      if (name === "F8-secret") {
        lines.push(
          shellCompleted(
            "call_secret",
            "curl",
            `Authorization: Bearer ${SECRET_SENTINEL}\nCookie: session=${SECRET_SENTINEL}\napi_key=${SECRET_SENTINEL}\nhttps://example.test/hook?token=${SECRET_SENTINEL}`,
            0,
            { sessionId: SESSION_BUILDER, at: at(7) },
          ),
        );
      }
      if (name === "F8-private") {
        lines.push(thinkingBlock(`hidden reasoning ${SECRET_SENTINEL}`, { sessionId: SESSION_BUILDER, at: at(7) }));
        lines.push(textProgress("公开事实：已读取配置", { sessionId: SESSION_BUILDER, at: at(8) }));
        lines.push(
          toolStarted("call_public", "readToolCall", { path: "src/config.ts" }, {
            sessionId: SESSION_BUILDER,
            at: at(9),
          }),
        );
        lines.push(
          toolCompleted("call_public", "readToolCall", { success: { content: "ok" } }, {
            sessionId: SESSION_BUILDER,
            at: at(10),
          }),
        );
      }
      if (name === "F8-xss") {
        lines.push(
          textProgress(XSS_PAYLOAD, { sessionId: SESSION_BUILDER, at: at(7) }),
          editCompleted("call_xss", XSS_PAYLOAD, `diff ${XSS_PAYLOAD}`, {
            sessionId: SESSION_BUILDER,
            at: at(8),
          }),
        );
      }
      if (name === "F8-path") {
        const sentinelFile = join(home, "sentinel-secret.txt");
        writeText(sentinelFile, PATH_SENTINEL);
        lines.push(
          readCompleted("call_path", "../../../sentinel-secret.txt", PATH_SENTINEL, {
            sessionId: SESSION_BUILDER,
            at: at(7),
          }),
        );
      }
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER_E2,
        sessionId: SESSION_BUILDER,
        process,
        log: linesJson(lines),
      });
      // Prior execution E1 sidecar for late arrival tests.
      writeText(
        join(taskDirRound2, "execution-e1.jsonl"),
        linesJson([
          textProgress("E1 started", { sessionId: SESSION_BUILDER, at: at(0) }),
          shellStarted("call_e1", "echo e1", { sessionId: SESSION_BUILDER, at: at(1) }),
        ]),
      );
      writeJson(join(taskDirRound2, "execution-map.json"), {
        current: EXEC_BUILDER_E2,
        previous: [EXEC_BUILDER_E1],
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(
          baseRepairState({
            budget: defaultBudget({ tokenUsed: null }),
          }),
          taskDirRound1,
          taskDirRound2,
        ),
      );
      break;
    }
    case "F9": {
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process,
        log: "",
      });
      const written = await writeLargeF9Log(join(taskDirRound2, "orchestrator.log"));
      logBytes = written.bytes;
      operationCount = written.operations;
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(baseRepairState(), taskDirRound1, taskDirRound2),
      );
      break;
    }
    case "F-legacy": {
      // attempts=[] ; trusted squad association + orchestrator.log only
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process,
        log: linesJson([
          textProgress("升级前公开活动", { sessionId: SESSION_BUILDER, at: T0_ISO }),
          shellCompleted("call_legacy", "echo legacy", "legacy ok\n", 0, {
            sessionId: SESSION_BUILDER,
            at: T0_ISO,
          }),
        ]),
        adapterRuns: [{ role: "reviewer", sessionId: SESSION_REVIEWER }],
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: "",
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(baseRepairState({ executions: [] }), taskDirRound1, taskDirRound2),
      );
      writeStatus(runDir, { status: "running", phase: "repair-building" });
      break;
    }
    case "F-legacy-empty": {
      // Finished old task: final report only, no process files.
      writeText(join(runDir, "report.md"), `# Repair Report\n\n仅有最终报告\n目标：${GOAL}\n`);
      writeJson(
        join(runDir, "repair.json"),
        baseRepairState({
          businessResult: "stopped",
          reasonCode: "legacy_empty",
          currentSquadTaskId: null,
          cycles: [],
          goalSummary: GOAL,
        }),
      );
      writeStatus(runDir, { status: "completed", phase: "done" });
      // No squad-tasks / no orchestrator.log
      break;
    }
    case "F-child-review": {
      writeReviewSidecar(home, CHILD_REVIEW_ID, {
        title: "child final review",
        withLive: true,
      });
      taskDirRound2 = writeBridgeTask(home, TASK_ID_ROUND2, {
        executionId: EXEC_BUILDER,
        sessionId: SESSION_BUILDER,
        process,
        log: linesJson([
          textProgress("进入终验复审", { sessionId: SESSION_BUILDER, at: T0_ISO }),
        ]),
      });
      taskDirRound1 = writeBridgeTask(home, TASK_ID_ROUND1, {
        executionId: `${EXEC_BUILDER}-r1`,
        sessionId: "B0",
        process: null,
        stopped: true,
        executionStatus: "stopped",
        log: linesJson([textProgress("source baseline activity", { sessionId: "B0", at: T0_ISO })]),
      });
      writeJson(
        join(runDir, "repair.json"),
        bindCycles(
          baseRepairState({
            latestReviewId: CHILD_REVIEW_ID,
            cycles: [
              {
                n: 1,
                phase: "closed",
                childReviewId: null,
                squadTaskId: TASK_ID_ROUND1,
                squadTaskDir: taskDirRound1,
              },
              {
                n: 2,
                phase: "reviewed",
                childReviewId: CHILD_REVIEW_ID,
                squadTaskId: TASK_ID_ROUND2,
                squadTaskDir: taskDirRound2,
              },
            ],
          }),
          taskDirRound1,
          taskDirRound2,
        ),
      );
      break;
    }
    case "F-review": {
      writeReviewSidecar(home, REVIEW_RUN_ID, {
        title: "adjacent review regression",
        withLive: true,
      });
      break;
    }
    case "F-squad": {
      writeSquadSidecar(home);
      break;
    }
    default: {
      const _exhaustive: never = name;
      throw new Error(`unknown fixture ${_exhaustive}`);
    }
  }

  // Path-isolation sibling sentinel (always present for E49).
  writeText(join(home, "sibling-run-secret.txt"), PATH_SENTINEL);
  writeText(join(home, "runs", "ck-repair-00000000-0000-4000-8000-000000000999", "secret.txt"), PATH_SENTINEL);

  return {
    home,
    runId: name === "F-review" ? REVIEW_RUN_ID : name === "F-squad" ? SQUAD_RUN_ID : PARENT_RUN_ID,
    taskDirRound1,
    taskDirRound2,
    sourceReviewId: SOURCE_REVIEW_ID,
    childReviewId: CHILD_REVIEW_ID,
    logBytes,
    operationCount,
  };
}

export function hashFileSafe(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export function chmodPath(path: string, mode: number): void {
  chmodSync(path, mode);
}
