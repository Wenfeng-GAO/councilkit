/**
 * `councilkit fix --run <id>` — draft a repair plan, jury-review the plan
 * until consensus (or max rounds), apply that plan, then optionally start a
 * follow-up PR jury. The Host may spawn this command; agents still bypass Host.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextUnlandedCluster } from "@shared/runtime/cli-ledger";
import {
  CLI_RUN_STATUS_FILE,
  type CliRunApplyStatus,
  type CliRunAttemptProgress,
  type CliRunLiveState,
  type CliRunPipeline,
  type CliRunPipelinePhase,
  type CliRunPlanVerdict,
  type CliRunProgressPhase,
} from "@shared/runtime/cli-run-progress";
import { type RunCommand, defaultRunCommand } from "../auto/checkout-pr";
import {
  type AttemptSpec,
  DRIVER_PROBE_PROMPT,
  buildProbeSpec,
  buildSpawnSpec,
} from "../auto/driver-commands";
import { formatDurationMs } from "../auto/duration";
import {
  attachClosesFromFindings,
  ensureFindings,
  parsePlanDocument,
  readLandings,
  readPlanLock,
  writePlanLock,
} from "../auto/ledger";
import { type SpawnImpl, runAttempts, spawnOnce } from "../auto/runner";
import {
  PLAN_REVIEW_FILE,
  PLAN_RUN_FILE,
  PLAN_WORKSPACE_FILE,
  buildPlanAggregatePrompt,
  buildPlanDraftPrompt,
  buildPlanReviewPrompt,
  extractConsensusPlan,
  extractVerdictToken,
  looksLikePlanDocument,
} from "../auto/templates/plan";
import { readReviewTranscript } from "../auto/transcript";
import { CliError, EXIT, errors } from "../errors";
import { PR_JURY_COUNCIL_NAME } from "../init/defaults";
import { progressOnlySink } from "../output";
import type { OutputSink } from "../output";
import { atomicWriteFile } from "../store/atomic-write";
import { resolvePaths } from "../store/paths";
import type { AgentRecord } from "../store/schemas";
import { Store } from "../store/store";
import { ApplyExit, runApply } from "./apply";
import { DEFAULT_CODEX_TIMEOUT_MS, parseFlags, parseTimeoutMs } from "./parse";
import { ReviewExit, runReview } from "./review";

const RUN_ID_PATTERN = /^ck-review-[0-9a-fA-F-]+$/;
const PROBE_TIMEOUT_MS = 90_000;
const DEFAULT_PLANNER_NAME = "review-adversarial";
const DEFAULT_MAX_PLAN_ROUNDS = 2;

export class FixExit {
  constructor(readonly exitCode: number) {}
}

export interface FixDeps {
  spawnImpl?: SpawnImpl;
  runCommand?: RunCommand;
  abortController?: AbortController;
}

export interface FixOutcome {
  status: "completed" | "failed" | "interrupted";
  exitCode: number;
  reviewRunId: string;
  planVerdict: CliRunPlanVerdict | null;
  planRounds: number;
  applied: boolean;
  followUpRunId: string | null;
  summary: string;
  failure: { phase: string; code: string; message: string } | null;
}

export async function runFix(argv: string[], out: OutputSink, deps: FixDeps = {}): Promise<void> {
  const { values, positionals } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        run: { type: "string" },
        agent: { type: "string" },
        timeout: { type: "string" },
        "codex-timeout": { type: "string" },
        "no-push": { type: "boolean" },
        "no-re-review": { type: "boolean" },
        "re-review-only": { type: "boolean" },
        "plan-only": { type: "boolean" },
      },
      allowPositionals: 1,
    },
    argv,
  );

  const positionalRun = positionals[0];
  if (positionalRun !== undefined && values.run !== undefined) {
    throw errors.usage("pass the run id as a positional or --run, not both");
  }
  const runRaw = positionalRun ?? (values.run as string | undefined);
  if (runRaw === undefined || runRaw.trim().length === 0) {
    throw errors.usage("--run <ck-review-…> is required");
  }
  const runId = runRaw.trim();
  if (!RUN_ID_PATTERN.test(runId)) {
    throw errors.usage(`--run must be a ck-review-<uuid> run id, got "${runRaw}"`);
  }
  if (values["re-review-only"] === true && values["plan-only"] === true) {
    throw errors.usage("--re-review-only and --plan-only are mutually exclusive");
  }

  const timeoutMs = parseTimeoutMs(values.timeout as string | undefined);
  const codexTimeoutMs = parseTimeoutMs(
    values["codex-timeout"] as string | undefined,
    DEFAULT_CODEX_TIMEOUT_MS,
    "codex-timeout",
  );
  const seatTimeout = (agent: AgentRecord): number =>
    agent.driverSelection.driverId === "codex-app-server" ? codexTimeoutMs : timeoutMs;
  const poolTimeoutMs = Math.max(timeoutMs, codexTimeoutMs);
  const reReview = values["no-re-review"] !== true;
  const reReviewOnly = values["re-review-only"] === true;
  const planOnly = values["plan-only"] === true;
  const applyArgs: string[] = ["--run", runId];
  if (values["no-push"] === true) applyArgs.push("--no-push");
  if (values.timeout !== undefined) applyArgs.push("--timeout", values.timeout as string);
  if (values.agent !== undefined) applyArgs.push("--agent", values.agent as string);

  const store = new Store();
  const paths = resolvePaths();
  const runDir = paths.runDir(runId);
  const reportPath = paths.report(runId);
  const transcriptPath = paths.transcript(runId);
  const planPath = join(runDir, PLAN_RUN_FILE);

  const records = readReviewTranscript(transcriptPath);
  const started = records.find((r) => r.kind === "review.started");
  if (started === undefined) {
    throw errors.usage(`run ${runId} has no review.started record`);
  }
  const finished = records.find((r) => r.kind === "review.finished");
  if (finished === undefined) {
    throw errors.usage("review is still running; wait for it to finish before fix");
  }
  const pr = started.task.pr?.trim();
  if (pr === undefined || pr.length === 0) {
    throw errors.usage("fix requires a PR URL in the review transcript (this run used --task)");
  }
  const report = readRequired(reportPath, `report.md for ${runId}`);
  const findings = ensureFindings({ runDir, runId, markdown: report });

  const planner = resolvePlanner(store, values.agent as string | undefined);
  const jury = resolveJury(store);
  const planAggregator = resolvePlanAggregator(planner, jury);

  const controller = deps.abortController ?? new AbortController();
  let signaled = false;
  const onSignal = (): void => {
    if (signaled) return;
    signaled = true;
    controller.abort("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const nested = progressOnlySink(out);
  let planVerdict: CliRunPlanVerdict | null = null;
  let planRounds = 0;
  let applied = false;
  let followUpRunId: string | null = null;
  let summary = "";

  const persist = (
    status: CliRunLiveState["status"],
    phase: CliRunPipelinePhase,
    extra: {
      progressPhase?: CliRunProgressPhase;
      attempts?: CliRunAttemptProgress[];
      applyStatus?: CliRunApplyStatus | null;
      planVerdict?: CliRunPlanVerdict | null;
      followUpRunId?: string | null;
      summary?: string | null;
    } = {},
  ): void => {
    const pipeline: CliRunPipeline = {
      phase,
      round: planRounds,
      maxRounds: DEFAULT_MAX_PLAN_ROUNDS,
      planVerdict: extra.planVerdict ?? planVerdict,
      applyStatus: extra.applyStatus ?? (applied ? "success" : null),
      followUpRunId: extra.followUpRunId ?? followUpRunId,
      summary: extra.summary ?? (summary.length > 0 ? summary : null),
      updatedAt: new Date().toISOString(),
    };
    const live: CliRunLiveState = {
      version: 1,
      status,
      progress: {
        phase: extra.progressPhase ?? pipelineProgressPhase(phase),
        attempts: extra.attempts ?? [],
        updatedAt: pipeline.updatedAt,
      },
      pipeline,
    };
    try {
      atomicWriteFile(join(runDir, CLI_RUN_STATUS_FILE), `${JSON.stringify(live)}\n`);
    } catch {
      // sidecar
    }
  };

  const finish = async (partial: {
    status: FixOutcome["status"];
    exitCode: number;
    failure: FixOutcome["failure"];
    extra?: Partial<FixOutcome>;
  }): Promise<never> => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    const outcome: FixOutcome = {
      status: partial.status,
      exitCode: partial.exitCode,
      reviewRunId: runId,
      planVerdict,
      planRounds,
      applied,
      followUpRunId,
      summary,
      failure: partial.failure,
      ...partial.extra,
    };
    persist(partial.status === "interrupted" ? "interrupted" : "completed", "done", {
      applyStatus: applied
        ? "success"
        : partial.status === "failed"
          ? "failure"
          : planOnly || !planVerdict || planVerdict !== "approve"
            ? "skipped"
            : "failure",
      summary: outcome.summary || partial.failure?.message || null,
    });
    await out.finish(outcome, renderFixHuman);
    throw new FixExit(outcome.exitCode);
  };

  try {
    out.progress(`fix ${runId} starting`);
    out.progress(`  pr: ${pr}`);
    out.progress(
      `  planner: ${planner.name} — ${planner.driverSelection.driverId}/${planner.modelId}`,
    );
    out.progress(
      `  plan aggregator: ${planAggregator.name} (not the planner unless the roster is a single agent)`,
    );
    persist("running", reReviewOnly ? "re-reviewing" : "planning", {
      applyStatus: reReviewOnly ? null : "pending",
      summary: reReviewOnly ? "正在启动复审（不再改代码）…" : "正在探测模型是否可用…",
    });

    const existingLock = readPlanLock(runDir);
    const existingLandings = readLandings(runDir);
    const nextCluster = nextUnlandedCluster(existingLock, existingLandings);
    const skipPlan =
      !planOnly &&
      existingLock !== null &&
      existingLock.verdict === "approve" &&
      nextCluster !== null;

    if (reReviewOnly) {
      persist("running", "re-reviewing", { applyStatus: null });
      followUpRunId = await startFollowUpReview({
        pr,
        sourceRunId: runId,
        planPath,
        out: nested,
        deps,
        controller,
        timeoutFlag: values.timeout as string | undefined,
        codexTimeoutFlag: values["codex-timeout"] as string | undefined,
        onFollowUp: (id) => {
          followUpRunId = id;
          persist("running", "re-reviewing", {
            followUpRunId: id,
            applyStatus: applied ? "success" : null,
          });
        },
      });
      summary = `follow-up review ${followUpRunId}`;
      persist("completed", "done", { followUpRunId, summary });
      await finish({
        status: "completed",
        exitCode: EXIT.ok,
        failure: null,
        extra: { summary, followUpRunId },
      });
    }

    const spawnImpl = deps.spawnImpl;
    if (skipPlan && nextCluster && existingLock) {
      planVerdict = existingLock.verdict;
      summary = `locked plan; next cluster ${nextCluster.id}`;
      out.progress(`  using plan.lock.json; apply cluster ${nextCluster.id}`);
      applyArgs.push("--cluster", nextCluster.id);
    }

    if (!skipPlan) {
      const probeCwd = join(runDir, "probe");
      mkdirSync(probeCwd, { recursive: true, mode: 0o700 });
      const probeTargets = uniqueAgents([planner, planAggregator, ...jury]);
      await Promise.all(
        probeTargets.map((agent) => probeAgent(agent, controller.signal, spawnImpl, probeCwd)),
      );
      if (controller.signal.aborted) {
        await finish({
          status: "interrupted",
          exitCode: EXIT.interrupted,
          failure: { phase: "probe", code: "ABORTED", message: "run aborted by signal" },
        });
      }

      let draft = "";
      let juryFeedback: string | undefined;
      for (let round = 1; round <= DEFAULT_MAX_PLAN_ROUNDS; round += 1) {
        planRounds = round;
        out.progress(`  plan draft round ${round}/${DEFAULT_MAX_PLAN_ROUNDS}`);
        persist("running", "planning", { progressPhase: "planning" });

        const planWorkspace = join(runDir, "workspaces", `plan-draft-${round}`);
        mkdirSync(planWorkspace, { recursive: true, mode: 0o700 });
        writeFileSync(join(planWorkspace, PLAN_REVIEW_FILE), report, {
          encoding: "utf8",
          mode: 0o600,
        });
        if (draft.length > 0) {
          writeFileSync(join(planWorkspace, PLAN_WORKSPACE_FILE), draft, {
            encoding: "utf8",
            mode: 0o600,
          });
        }
        const plannerPrompt = buildPlanDraftPrompt({
          agentName: planner.name,
          prUrl: pr,
          reportFile: PLAN_REVIEW_FILE,
          previousPlanFile: draft.length > 0 ? PLAN_WORKSPACE_FILE : undefined,
          juryFeedback,
          round,
        });
        const plannerSpec = buildSpawnSpec(planner, {
          attemptId: `plan-draft-${round}`,
          workspace: planWorkspace,
          prompt: plannerPrompt,
        });
        plannerSpec.timeoutMs = seatTimeout(planner);
        const draftResult = await spawnOnce(plannerSpec, {
          timeoutMs: plannerSpec.timeoutMs,
          signal: controller.signal,
          spawnImpl,
        });
        if (controller.signal.aborted) {
          await finish({
            status: "interrupted",
            exitCode: EXIT.interrupted,
            failure: { phase: "planning", code: "ABORTED", message: "run aborted by signal" },
          });
        }
        if (draftResult.status !== "success" || draftResult.output.trim().length === 0) {
          await finish({
            status: "failed",
            exitCode: EXIT.runFailed,
            failure: {
              phase: "planning",
              code: draftResult.failure?.code ?? "PLAN_DRAFT_FAILED",
              message: draftResult.failure?.message ?? "planner produced no plan",
            },
          });
        }
        draft = draftResult.output.trim();
        if (!looksLikePlanDocument(draft)) {
          out.progress("  planner output lacked plan headings; keeping it as the draft anyway");
        }
        writePlan(planPath, draft);
        out.progress(`  plan draft ${formatDurationMs(draftResult.durationMs)}`);

        out.progress("  plan jury reviewing the draft");
        const reviewWorkspaceRoot = join(runDir, "workspaces", `plan-jury-${round}`);
        mkdirSync(reviewWorkspaceRoot, { recursive: true, mode: 0o700 });
        const attemptSpecs: AttemptSpec[] = [];
        const attemptRows: CliRunAttemptProgress[] = [];
        for (const [index, agent] of jury.entries()) {
          const cwd = join(reviewWorkspaceRoot, `attempt-${index}`);
          mkdirSync(cwd, { recursive: true, mode: 0o700 });
          writeFileSync(join(cwd, PLAN_REVIEW_FILE), report, { encoding: "utf8", mode: 0o600 });
          writeFileSync(join(cwd, PLAN_WORKSPACE_FILE), draft, { encoding: "utf8", mode: 0o600 });
          const spec = buildSpawnSpec(agent, {
            attemptId: `plan-${round}-attempt-${index}`,
            workspace: cwd,
            prompt: buildPlanReviewPrompt({
              agentName: agent.name,
              personaPrompt: agent.personaPrompt,
              prUrl: pr,
              reportFile: PLAN_REVIEW_FILE,
              planFile: PLAN_WORKSPACE_FILE,
            }),
          });
          spec.timeoutMs = seatTimeout(agent);
          attemptSpecs.push(spec);
          attemptRows.push(progressRow(spec, "queued"));
        }
        attemptRows.push({
          attemptId: "plan-aggregator",
          agentName: planAggregator.name,
          driverId: planAggregator.driverSelection.driverId,
          modelId: planAggregator.modelId,
          role: "aggregator",
          status: "pending",
          durationMs: null,
          lastActivity: null,
        });
        persist("running", "plan-review", {
          progressPhase: "plan-review",
          attempts: attemptRows,
        });

        const juryOutcome = await runAttempts(attemptSpecs, {
          timeoutMs: poolTimeoutMs,
          signal: controller.signal,
          spawnImpl,
          onAttemptStart: (attemptId) => {
            const row = attemptRows.find((item) => item.attemptId === attemptId);
            if (row) row.status = "running";
            persist("running", "plan-review", {
              progressPhase: "plan-review",
              attempts: attemptRows,
            });
          },
          onAttemptFinish: (result) => {
            const row = attemptRows.find((item) => item.attemptId === result.attemptId);
            if (row) {
              row.status = result.status;
              row.durationMs = result.durationMs;
              row.lastActivity = null;
            }
            out.progress(
              `  plan seat ${result.agentName} -> ${result.status} (${formatDurationMs(result.durationMs)})`,
            );
            persist("running", "plan-review", {
              progressPhase: "plan-review",
              attempts: attemptRows,
            });
          },
        });
        if (controller.signal.aborted) {
          await finish({
            status: "interrupted",
            exitCode: EXIT.interrupted,
            failure: { phase: "plan-review", code: "ABORTED", message: "run aborted by signal" },
          });
        }

        persist("running", "plan-aggregating", {
          progressPhase: "plan-aggregating",
          attempts: attemptRows.map((row) =>
            row.attemptId === "plan-aggregator" ? { ...row, status: "running" } : row,
          ),
        });
        const aggWorkspace = join(reviewWorkspaceRoot, "aggregator");
        mkdirSync(aggWorkspace, { recursive: true, mode: 0o700 });
        const aggPrompt = buildPlanAggregatePrompt({
          aggregatorName: planAggregator.name,
          aggregatorPersona: planAggregator.personaPrompt,
          prUrl: pr,
          draftPlan: draft,
          attempts: juryOutcome.results.map((r) => ({
            name: r.agentName,
            status: r.status,
            output: r.output,
          })),
        });
        const aggSpec = buildSpawnSpec(planAggregator, {
          attemptId: `plan-${round}-aggregator`,
          workspace: aggWorkspace,
          prompt: aggPrompt,
        });
        aggSpec.timeoutMs = seatTimeout(planAggregator);
        const aggResult = await spawnOnce(aggSpec, {
          timeoutMs: aggSpec.timeoutMs,
          signal: controller.signal,
          spawnImpl,
        });
        if (controller.signal.aborted) {
          await finish({
            status: "interrupted",
            exitCode: EXIT.interrupted,
            failure: {
              phase: "plan-aggregating",
              code: "ABORTED",
              message: "run aborted by signal",
            },
          });
        }
        if (aggResult.status !== "success") {
          await finish({
            status: "failed",
            exitCode: EXIT.runFailed,
            failure: {
              phase: "plan-aggregating",
              code: aggResult.failure?.code ?? "PLAN_AGGREGATE_FAILED",
              message: aggResult.failure?.message ?? "plan aggregator produced no output",
            },
          });
        }
        const consensus = extractConsensusPlan(aggResult.output);
        if (consensus && looksLikePlanDocument(consensus)) {
          draft = consensus;
          writePlan(planPath, draft);
        }
        planVerdict = extractVerdictToken(aggResult.output) ?? "changes-requested";
        out.progress(
          `  plan aggregator -> ${planVerdict} (${formatDurationMs(aggResult.durationMs)})`,
        );
        persist("running", "plan-aggregating", {
          progressPhase: "plan-aggregating",
          attempts: attemptRows.map((row) =>
            row.attemptId === "plan-aggregator"
              ? { ...row, status: "success", durationMs: aggResult.durationMs }
              : row,
          ),
          planVerdict,
        });
        if (planVerdict === "approve" || planVerdict === "comment") {
          summary = `plan ${planVerdict} after ${round} round(s)`;
          break;
        }
        juryFeedback = aggResult.output;
        if (round === DEFAULT_MAX_PLAN_ROUNDS) {
          summary = `plan did not reach consensus after ${round} round(s)`;
          await finish({
            status: "failed",
            exitCode: EXIT.runFailed,
            failure: {
              phase: "plan-review",
              code: "PLAN_NO_CONSENSUS",
              message: "plan jury did not approve the repair plan; not applying",
            },
            extra: { summary, planVerdict },
          });
        }
      }

      if (planVerdict === "approve" || planVerdict === "comment") {
        const lock = attachClosesFromFindings(
          parsePlanDocument(draft, {
            sourceRunId: runId,
            approvedAt: new Date().toISOString(),
            verdict: planVerdict === "comment" ? "comment" : "approve",
          }),
          findings.findings,
        );
        writePlanLock(runDir, lock);
        out.progress(`  wrote plan.lock.json (${lock.clusters.length} cluster(s))`);
      }
    }

    if (planOnly) {
      summary = `${summary}; --plan-only, skipped apply`;
      await finish({ status: "completed", exitCode: EXIT.ok, failure: null, extra: { summary } });
    }

    out.progress("  applying consensus plan");
    persist("running", "applying", { applyStatus: "running", progressPhase: "applying" });
    try {
      await runApply(applyArgs, nested, {
        spawnImpl: deps.spawnImpl,
        runCommand: deps.runCommand ?? defaultRunCommand,
        abortController: controller,
      });
    } catch (error) {
      if (error instanceof ApplyExit) {
        if (error.exitCode === EXIT.interrupted || controller.signal.aborted) {
          await finish({
            status: "interrupted",
            exitCode: EXIT.interrupted,
            failure: { phase: "apply", code: "ABORTED", message: "apply aborted by signal" },
          });
        }
        if (error.exitCode !== EXIT.ok) {
          await finish({
            status: "failed",
            exitCode: error.exitCode,
            failure: { phase: "apply", code: "APPLY_FAILED", message: "apply did not complete" },
          });
        }
        applied = true;
      } else {
        throw error;
      }
    }
    // runApply only returns via ApplyExit
    applied = true;
    persist("running", "applying", { applyStatus: "success", progressPhase: "applying" });

    if (reReview) {
      out.progress("  starting follow-up jury review");
      persist("running", "re-reviewing", {
        applyStatus: "success",
        progressPhase: "re-reviewing",
      });
      followUpRunId = await startFollowUpReview({
        pr,
        sourceRunId: runId,
        planPath,
        out: nested,
        deps,
        controller,
        timeoutFlag: values.timeout as string | undefined,
        codexTimeoutFlag: values["codex-timeout"] as string | undefined,
        onFollowUp: (id) => {
          followUpRunId = id;
          persist("running", "re-reviewing", {
            followUpRunId: id,
            applyStatus: applied ? "success" : null,
          });
        },
      });
      summary = `${summary}; applied; follow-up ${followUpRunId}`;
    } else {
      summary = `${summary}; applied; skipped re-review`;
    }

    await finish({
      status: "completed",
      exitCode: EXIT.ok,
      failure: null,
      extra: { summary, applied: true, followUpRunId },
    });
  } catch (error) {
    if (error instanceof FixExit) throw error;
    if (error instanceof ReviewExit && error.exitCode === EXIT.interrupted) {
      await finish({
        status: "interrupted",
        exitCode: EXIT.interrupted,
        failure: { phase: "re-review", code: "ABORTED", message: "follow-up review aborted" },
      });
    }
    if (error instanceof CliError) {
      persist("completed", "done", {
        applyStatus: applied ? "success" : "failure",
        summary: error.message,
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await finish({
      status: "failed",
      exitCode: EXIT.runFailed,
      failure: { phase: "fix", code: "FIX_FAILED", message },
    });
  }
}

async function startFollowUpReview(input: {
  pr: string;
  sourceRunId: string;
  planPath: string;
  out: OutputSink;
  deps: FixDeps;
  controller: AbortController;
  timeoutFlag?: string;
  codexTimeoutFlag?: string;
  onFollowUp?: (runId: string) => void;
}): Promise<string> {
  let created: string | null = null;
  let planExcerpt = "";
  try {
    planExcerpt = readFileSync(input.planPath, "utf8").trim().slice(0, 6000);
  } catch {
    planExcerpt = "";
  }
  const focus = [
    `这是对 ${input.sourceRunId} 落地后的复审。`,
    "只报告：(1) 共识方案声称关闭但现在仍不成立的不变量；(2) 本次 apply 新引入的缺陷。",
    "不要把方案「本轮不落地」的项再标成阻塞，除非实现偏离了已接受的合同。",
    planExcerpt.length > 0 ? `上一轮共识方案摘要：\n${planExcerpt}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  const argv = [input.pr, "--against", input.sourceRunId, "--focus", focus];
  if (input.timeoutFlag) argv.push("--timeout", input.timeoutFlag);
  if (input.codexTimeoutFlag) argv.push("--codex-timeout", input.codexTimeoutFlag);
  try {
    await runReview(argv, input.out, {
      spawnImpl: input.deps.spawnImpl,
      runCommand: input.deps.runCommand,
      abortController: input.controller,
      onRunCreated: (id) => {
        created = id;
        input.onFollowUp?.(id);
      },
    });
  } catch (error) {
    if (error instanceof ReviewExit) {
      if (error.exitCode === EXIT.interrupted) throw error;
      if (created === null) {
        throw errors.runFailed("follow-up review did not assign a run id");
      }
      return created;
    }
    throw error;
  }
  if (created === null) throw errors.runFailed("follow-up review did not assign a run id");
  return created;
}

function resolvePlanner(store: Store, ref: string | undefined): AgentRecord {
  if (ref !== undefined) {
    const agent = store.getAgent(ref);
    if (!agent.enabled) throw errors.usage(`agent "${agent.name}" is disabled; cannot plan`);
    return agent;
  }
  const enabled = store.listAgents().filter((a) => a.enabled);
  const named = enabled.find((a) => a.name === DEFAULT_PLANNER_NAME);
  if (named?.driverSelection.driverId === "grok-stream-json") return named;
  const groks = enabled.filter((a) => a.driverSelection.driverId === "grok-stream-json");
  if (groks.length === 1) return groks[0];
  if (groks.length > 1) {
    throw errors.usage("multiple grok-stream-json agents; pass --agent <name|id>");
  }
  throw errors.usage(
    "fix defaults to a grok-stream-json planner (review-adversarial). Run `councilkit init` with grok on PATH, or pass --agent.",
  );
}

function resolveJury(store: Store): AgentRecord[] {
  try {
    const council = store.getCouncil(PR_JURY_COUNCIL_NAME);
    const agents = council.agentIds.map((id) => store.getAgent(id)).filter((a) => a.enabled);
    if (agents.length === 0) {
      throw errors.usage("pr-jury has no enabled agents; run `councilkit init`");
    }
    return agents;
  } catch (error) {
    if (error instanceof CliError) {
      throw errors.usage(
        "default pr-jury is missing or empty; run `councilkit init` before `councilkit fix`",
      );
    }
    throw error;
  }
}

function resolvePlanAggregator(planner: AgentRecord, jury: AgentRecord[]): AgentRecord {
  const others = jury.filter((a) => a.id !== planner.id);
  const correctness = others.find((a) => a.name === "review-correctness");
  if (correctness) return correctness;
  if (others[0]) return others[0];
  return planner;
}

function uniqueAgents(agents: AgentRecord[]): AgentRecord[] {
  const seen = new Set<string>();
  const out: AgentRecord[] = [];
  for (const agent of agents) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    out.push(agent);
  }
  return out;
}

async function probeAgent(
  agent: AgentRecord,
  signal: AbortSignal,
  spawnImpl: SpawnImpl | undefined,
  probeCwd: string,
): Promise<void> {
  const probe = await spawnOnce(
    buildProbeSpec(agent, {
      probeId: `probe-${agent.driverSelection.driverId}`,
      cwd: probeCwd,
      prompt: DRIVER_PROBE_PROMPT,
    }),
    { timeoutMs: PROBE_TIMEOUT_MS, signal, spawnImpl },
  );
  if (probe.status !== "success") {
    throw errors.runFailed(
      `fix agent probe failed for ${agent.name}: ${probe.failure?.message ?? "unreachable"}`,
    );
  }
}

function writePlan(path: string, body: string): void {
  writeFileSync(path, `${body.trim()}\n`, { encoding: "utf8", mode: 0o600 });
}

function readRequired(path: string, label: string): string {
  try {
    const text = readFileSync(path, "utf8");
    if (text.trim().length === 0) throw errors.usage(`${label} is empty`);
    return text;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw errors.io(`cannot read ${label}`, {
      cause: error instanceof Error ? error.name : "IO",
    });
  }
}

function progressRow(
  spec: AttemptSpec,
  status: CliRunAttemptProgress["status"],
): CliRunAttemptProgress {
  return {
    attemptId: spec.attemptId,
    agentName: spec.agentName,
    driverId: spec.driverId,
    modelId: spec.modelId,
    role: "attempt",
    status,
    durationMs: null,
    lastActivity: null,
  };
}

function pipelineProgressPhase(phase: CliRunPipelinePhase): CliRunProgressPhase {
  if (phase === "done") return "done";
  return phase;
}

function renderFixHuman(data: unknown): string {
  const o = data as FixOutcome;
  return [
    `fix ${o.status} (exit ${o.exitCode})`,
    `  review: ${o.reviewRunId}`,
    `  plan: ${o.planVerdict ?? "n/a"} (${o.planRounds} round(s))`,
    `  applied: ${o.applied ? "yes" : "no"}`,
    o.followUpRunId ? `  follow-up: ${o.followUpRunId}` : "  follow-up: (none)",
    o.summary ? `  ${o.summary}` : "",
    o.failure ? `  failure: ${o.failure.phase}/${o.failure.code} ${o.failure.message}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
