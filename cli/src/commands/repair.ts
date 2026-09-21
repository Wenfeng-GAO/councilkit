import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isCliRunId, readCliRun } from "@shared/runtime/cli-runs-index";
import { type RepairPackage, buildRepairPackage } from "@shared/runtime/repair-package";
import { DEFAULT_GATE_POLICY_ID, freezeExpectedGatePolicy } from "@shared/runtime/repair-policy";
import { canExportRepairPackage } from "@shared/runtime/review-case";
import { loadFindingGroups } from "../auto/finding-groups";
import { runDeadlineSupervisorLoop } from "../auto/repair-deadline-supervisor";
import {
  DEFAULT_REPAIR_OUTER_MAX,
  type RepairState,
  bootstrapRepairRun,
  isRepairRunId,
  isReviewRunId,
  readRepairPid,
  readRepairState,
  sourceReviewExists,
  writeRepairLive,
  writeRepairPid,
  writeRepairState,
} from "../auto/repair-persist";
import { loadRepairProfile } from "../auto/repair-profile";
import { type RepairLoopDeps, executeRepairLoop } from "../auto/repair-run";
import { SquadctlBridge, probeSquadBridge } from "../auto/squadctl-bridge";
import { EXIT, errors } from "../errors";
import type { OutputSink } from "../output";
import { resolvePaths } from "../store/paths";
import { parseFlags, parseIntFlag, parseTimeoutMs } from "./parse";

export class RepairExit {
  constructor(readonly exitCode: number) {}
}

export interface RepairCommandDeps extends RepairLoopDeps {
  pid?: number;
  wait?: (signal: AbortSignal) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  abortController?: AbortController;
  loop?: boolean;
  writerPids?: number[];
  isPidAlive?: (pid: number) => boolean;
}

const SUBCOMMANDS = "export|run|status|stop|resume|probe|supervise-deadline";

/** `repair export` plus parent-run bootstrap. Unit 4 does not run the outer loop. */
export async function runRepair(
  argv: string[],
  out: OutputSink,
  deps: RepairCommandDeps = {},
): Promise<void> {
  const sub = argv[0];
  if (sub === "export") return runRepairExport(argv.slice(1), out);
  if (sub === "run") return runRepairRun(argv.slice(1), out, deps);
  if (sub === "status") return runRepairStatus(argv.slice(1), out);
  if (sub === "stop") return runRepairStop(argv.slice(1), out, deps);
  if (sub === "resume") return runRepairResume(argv.slice(1), out, deps);
  if (sub === "probe") return runRepairProbe(argv.slice(1), out);
  if (sub === "supervise-deadline") return runRepairSuperviseDeadline(argv.slice(1), out);
  throw errors.usage(
    sub === undefined
      ? `repair requires a subcommand: ${SUBCOMMANDS}`
      : `unknown repair subcommand "${sub}" (${SUBCOMMANDS})`,
  );
}

async function runRepairExport(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        run: { type: "string" },
        out: { type: "string" },
        cluster: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: 0,
    },
    argv,
  );
  const runId = typeof values.run === "string" ? values.run : "";
  const output = typeof values.out === "string" ? values.out.trim() : "";
  if (!isCliRunId(runId) || !runId.startsWith("ck-review-"))
    throw errors.usage("--run must identify a review run");
  if (!output) throw errors.usage("--out is required");
  const run = readCliRun(runId);
  if (!run) throw errors.usage("review run not found");
  if (run.hasPlanLock && !run.planLock)
    throw errors.usage("plan.lock.json is invalid or truncated");
  const runDir = join(resolvePaths().runsRoot, runId);
  let findingGroups = null;
  try {
    let findingsBytes: string | undefined;
    try {
      findingsBytes = readFileSync(join(runDir, "findings.json"), "utf8");
    } catch {
      findingsBytes = undefined;
    }
    findingGroups = loadFindingGroups({
      runDir,
      ledger: {
        runId,
        sha: run.reviewEvidence?.sha ?? null,
        findings: run.findings,
        againstRunId: run.reviewEvidence?.againstRunId ?? null,
      },
      findingsBytes,
    });
  } catch (error) {
    throw errors.usage(error instanceof Error ? error.message : "invalid finding-groups sidecar");
  }
  let task: RepairPackage;
  try {
    task = buildRepairPackage({
      runId,
      complete: canExportRepairPackage(run),
      prUrl: run.reviewEvidence?.prUrl ?? null,
      ledger: {
        runId,
        sha: run.reviewEvidence?.sha ?? null,
        findings: run.findings,
        againstRunId: run.reviewEvidence?.againstRunId ?? null,
      },
      planLock: run.planLock,
      clusterId: typeof values.cluster === "string" ? values.cluster : undefined,
      findingGroups,
    });
  } catch (error) {
    throw errors.usage(error instanceof Error ? error.message : "invalid repair source");
  }
  const path = resolve(output);
  try {
    const parent = realpathSync(dirname(path));
    const runsRoot = realpathSync(resolvePaths().runsRoot);
    if (parent === runsRoot || parent.startsWith(runsRoot + sep)) {
      throw errors.usage("--out must be outside the runs history directory");
    }
    // Exclusive creation: export must never overwrite a report, ledger or user file.
    writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
    throw errors.io("cannot create repair package; use a new file in an existing output directory");
  }
  await out.finish(
    { runId, path, findings: task.findings.length, deferred: task.constraints.deferred.length },
    () =>
      `已导出 ${task.findings.length} 个问题：${path}\n仅包含修复范围和验收约束，不授予 push 或合并权限。`,
  );
}

async function runRepairRun(
  argv: string[],
  out: OutputSink,
  deps: RepairCommandDeps,
): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        from: { type: "string" },
        profile: { type: "string" },
        "run-id": { type: "string" },
        "max-outer-cycles": { type: "string" },
        timeout: { type: "string" },
        protocol: { type: "string" },
        isolation: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: 0,
    },
    argv,
  );
  const fromId = typeof values.from === "string" ? values.from.trim() : "";
  const profileName = typeof values.profile === "string" ? values.profile.trim() : "";
  if (!fromId) throw errors.usage("--from <ck-review-…> is required");
  if (!profileName) throw errors.usage("--profile <name> is required");
  if (!isReviewRunId(fromId)) throw errors.usage("--from must identify a review run");
  if (!sourceReviewExists(fromId)) throw errors.usage("review run not found");
  const profile = loadRepairProfile(profileName);
  const assigned = typeof values["run-id"] === "string" ? values["run-id"].trim() : undefined;
  if (assigned !== undefined && !isRepairRunId(assigned)) {
    throw errors.usage(`--run-id must be a ck-repair-<uuid> run id, got "${assigned}"`);
  }
  const outerMax =
    values["max-outer-cycles"] === undefined
      ? DEFAULT_REPAIR_OUTER_MAX
      : parseIntFlag(values["max-outer-cycles"] as string, "max-outer-cycles");
  if (outerMax > DEFAULT_REPAIR_OUTER_MAX) {
    throw errors.usage(`--max-outer-cycles must be <= ${DEFAULT_REPAIR_OUTER_MAX}`);
  }
  const timeoutMs =
    values.timeout === undefined ? null : parseTimeoutMs(values.timeout as string, 1, "timeout");
  const protocolRaw = typeof values.protocol === "string" ? values.protocol.trim() : "";
  const protocolVersion =
    protocolRaw === "v2" || protocolRaw === "v1" ? protocolRaw : profile.protocolVersion;
  if (protocolRaw && protocolRaw !== "v1" && protocolRaw !== "v2") {
    throw errors.usage("--protocol must be v1 or v2");
  }
  const isolationRaw = typeof values.isolation === "string" ? values.isolation.trim() : "";
  const isolationMode =
    isolationRaw === "strong" || isolationRaw === "collaborative"
      ? isolationRaw
      : (profile.isolationMode ?? null);
  if (isolationRaw && isolationRaw !== "strong" && isolationRaw !== "collaborative") {
    throw errors.usage("--isolation must be strong or collaborative");
  }
  if (protocolVersion === "v2" && isolationMode !== "strong" && isolationMode !== "collaborative") {
    throw errors.usage("v2 repair requires --isolation strong|collaborative (explicit opt-in)");
  }
  const runId = assigned ?? `ck-repair-${randomUUID()}`;
  const freeze = freezeExpectedGatePolicy({
    catalogId: DEFAULT_GATE_POLICY_ID,
    profileHash: profile.expectedGatePolicyHash,
  });
  const bootstrapped = bootstrapRepairRun({
    runId,
    sourceRunId: fromId,
    profileName: profile.name,
    outerMax: protocolVersion === "v2" ? (profile.sourceFixMax ?? outerMax) : outerMax,
    timeoutMs: protocolVersion === "v2" ? (profile.deadlineMs ?? timeoutMs) : timeoutMs,
    pid: deps.pid ?? process.pid,
    protocolVersion,
    isolationMode,
    frozenPolicyHash: freeze.ok ? freeze.hash : undefined,
  });
  if (deps.loop === false) {
    const parked = await parkUntilStopped(deps);
    if (parked === "interrupted") {
      markStopped(bootstrapped.runDir, bootstrapped.state);
    }
    await out.finish(
      {
        runId,
        sourceRunId: fromId,
        status: parked === "interrupted" ? "interrupted" : "running",
        reused: bootstrapped.reused,
        pipeline: null,
      },
      () => `自动修复已启动：${runId}\n来源 ${fromId}`,
    );
    return;
  }
  const outcome = await executeRepairLoop({
    runId,
    runDir: bootstrapped.runDir,
    sourceRunId: fromId,
    profileName: profile.name,
    out,
    deps,
  });
  await out.finish(outcome, () => `自动修复${outcome.businessResult}：${runId}`);
  if (outcome.exitCode !== EXIT.ok) throw new RepairExit(outcome.exitCode);
}

async function runRepairStatus(argv: string[], out: OutputSink): Promise<void> {
  const runId = parseParentRunId(argv);
  const run = readCliRun(runId);
  if (!run) throw errors.usage("repair run not found");
  const state = readRepairState(resolvePaths().runDir(runId));
  await out.finish(
    {
      runId,
      status: run.status,
      pipeline: run.pipeline,
      progress: run.progress,
      sourceRunId: state?.sourceRunId ?? null,
      businessResult: state?.businessResult ?? null,
      protocolVersion: state?.protocolVersion ?? "v1",
      isolationMode: state?.isolationMode ?? null,
      goalSummary: state?.goalSummary ?? null,
      acceptanceCoverage: state?.acceptanceCoverage ?? null,
      remainingBudget: state?.remainingBudget ?? null,
      recoveryAction: state?.recoveryAction ?? null,
      interrupted: run.status === "interrupted",
    },
    () => `${runId} ${run.status}${run.pipeline ? "" : " pipeline=null"}`,
  );
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runRepairProbe(argv: string[], out: OutputSink): Promise<void> {
  void argv;
  const probe = probeSquadBridge();
  await out.finish(probe, () =>
    probe.available
      ? `Squad 桥可用 ${probe.version ?? ""}`
      : `Squad 桥不可用：${probe.reason ?? ""}`,
  );
  if (!probe.available) throw new RepairExit(EXIT.usage);
}

async function runRepairSuperviseDeadline(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        execution: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: 0,
    },
    argv,
  );
  const executionPath = typeof values.execution === "string" ? values.execution.trim() : "";
  if (!executionPath) throw errors.usage("--execution is required");
  const execution = await runDeadlineSupervisorLoop({ executionPath });
  await out.finish(execution, () => `${execution.executionId} ${execution.state}`);
}

async function runRepairStop(
  argv: string[],
  out: OutputSink,
  deps: RepairCommandDeps,
): Promise<void> {
  const runId = parseParentRunId(argv);
  const runDir = resolvePaths().runDir(runId);
  const state = readRepairState(runDir);
  if (state === null) throw errors.usage("repair run not found");
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const taskIds = uniqueTaskIds(state);
  if (taskIds.length > 0) {
    const bridge =
      deps.bridge ?? new SquadctlBridge({ workspaceCwd: state.workspaceCwd ?? undefined });
    for (const taskId of taskIds) {
      try {
        bridge.stop({ taskId });
      } catch (error) {
        await out.finish(
          {
            runId,
            status: "interrupted",
            businessResult: "stopped",
            leaseReleased: false,
            pipeline: null,
            error: error instanceof Error ? error.message : "stop failed",
          },
          () => `停止 ${runId} 失败：writer 仍存活`,
        );
        throw new RepairExit(EXIT.interrupted);
      }
    }
  }
  const pid = readRepairPid(runDir);
  if (pid !== null) {
    try {
      (deps.kill ?? process.kill)(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const extras = [
    ...(deps.writerPids ?? []),
    ...(state.writerPids ?? []),
    ...(deps.bridge?.writerPids?.() ?? []),
  ];
  const alive = extras.find((writer) => isPidAlive(writer));
  if (alive !== undefined) {
    await out.finish(
      {
        runId,
        status: "interrupted",
        businessResult: "stopped",
        leaseReleased: false,
        pipeline: null,
      },
      () => `已停止 ${runId}，写入锁仍阻塞`,
    );
    throw new RepairExit(EXIT.interrupted);
  }
  const next = markStopped(runDir, state);
  await out.finish(
    {
      runId,
      status: "interrupted",
      businessResult: next.businessResult,
      leaseReleased: true,
      pipeline: null,
    },
    () => `已停止 ${runId}`,
  );
  throw new RepairExit(EXIT.interrupted);
}

async function runRepairResume(
  argv: string[],
  out: OutputSink,
  deps: RepairCommandDeps,
): Promise<void> {
  const runId = parseParentRunId(argv);
  const runDir = resolvePaths().runDir(runId);
  const state = readRepairState(runDir);
  if (state === null) throw errors.usage("repair run not found");
  const resumed = {
    ...state,
    businessResult: null,
    reasonCode: null,
  };
  writeRepairState(runDir, resumed);
  writeRepairPid(runDir, deps.pid ?? process.pid);
  writeRepairLive(runDir, { status: "running", phase: "repair-preparing" });
  if (deps.loop === false) {
    const parked = await parkUntilStopped(deps);
    if (parked === "interrupted") {
      markStopped(runDir, resumed);
    }
    await out.finish(
      {
        runId,
        sourceRunId: resumed.sourceRunId,
        status: parked === "interrupted" ? "interrupted" : "running",
        pipeline: null,
      },
      () => `已恢复 ${runId}`,
    );
    return;
  }
  const outcome = await executeRepairLoop({
    runId,
    runDir,
    sourceRunId: resumed.sourceRunId,
    profileName: resumed.profileName,
    out,
    deps,
  });
  await out.finish(outcome, () => `已恢复 ${runId} → ${outcome.businessResult}`);
  if (outcome.exitCode !== EXIT.ok) throw new RepairExit(outcome.exitCode);
}

function parseParentRunId(argv: string[]): string {
  const { values } = parseFlags(
    {
      flags: {
        run: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: 0,
    },
    argv,
  );
  const runId = typeof values.run === "string" ? values.run.trim() : "";
  if (!isRepairRunId(runId)) throw errors.usage("--run must identify a repair run");
  return runId;
}

function markStopped(runDir: string, state: RepairState): RepairState {
  const next: RepairState = { ...state, businessResult: "stopped" };
  writeRepairState(runDir, next);
  writeRepairLive(runDir, { status: "interrupted", phase: "repair-preparing" });
  return next;
}

async function parkUntilStopped(deps: RepairCommandDeps): Promise<"running" | "interrupted"> {
  const controller = deps.abortController ?? new AbortController();
  if (deps.wait) {
    await deps.wait(controller.signal);
    return controller.signal.aborted ? "interrupted" : "running";
  }
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await waitUntilAbort(controller.signal);
    return "interrupted";
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

function waitUntilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function uniqueTaskIds(state: RepairState): string[] {
  const ids = [
    state.currentSquadTaskId,
    ...(state.cycles ?? []).map((cycle) => cycle.squadTaskId),
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}
