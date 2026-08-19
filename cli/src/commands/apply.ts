/**
 * `councilkit apply --run <id>` — implement a completed review report in an
 * isolated checkout of the same PR branch. Defaults to the grok agent
 * `review-adversarial`, then `git push` (opt out with `--no-push`). Never
 * posts PR comments and never opens a new PR.
 */
import { randomUUID } from "node:crypto";
import {
  type Stats,
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type RunCommand,
  checkoutPullRequest,
  commitLeftoverChanges,
  currentBranch,
  defaultRunCommand,
  gitHeadSha,
  gitWorkingTreeDirty,
  pushCurrentBranch,
} from "../auto/checkout-pr";
import { DRIVER_PROBE_PROMPT, buildProbeSpec, buildSpawnSpec } from "../auto/driver-commands";
import { formatDurationMs } from "../auto/duration";
import { type AttemptResult, type SpawnImpl, spawnOnce } from "../auto/runner";
import { APPLY_REPORT_FILENAME, buildApplyPrompt } from "../auto/templates/apply";
import { readReviewTranscript } from "../auto/transcript";
import { CliError, EXIT, errors } from "../errors";
import {
  type TrustedRoot,
  assertWithinRoot,
  bindTrustedRoot,
  revalidateTrustedRoot,
} from "../fs-safe";
import type { OutputSink } from "../output";
import { atomicWriteFile } from "../store/atomic-write";
import { resolvePaths } from "../store/paths";
import type { AgentRecord } from "../store/schemas";
import { Store } from "../store/store";
import { parseFlags, parseTimeoutMs } from "./parse";

const RUN_ID_PATTERN = /^ck-review-[0-9a-fA-F-]+$/;
const PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_AGENT_NAME = "review-adversarial";

export interface ApplyDeps {
  spawnImpl?: SpawnImpl;
  runCommand?: RunCommand;
  abortController?: AbortController;
}

export class ApplyExit {
  constructor(readonly exitCode: number) {}
}

export interface ApplyOutcome {
  status: "completed" | "failed" | "interrupted";
  exitCode: number;
  reviewRunId: string;
  agent: { id: string; name: string; driverId: string; modelId: string };
  workspace: string;
  pr: string;
  branch: string;
  pushed: boolean;
  commit: string | null;
  changed: boolean;
  summary: string;
  failure: { phase: string; code: string; message: string } | null;
}

export async function runApply(
  argv: string[],
  out: OutputSink,
  deps: ApplyDeps = {},
): Promise<void> {
  const { values, positionals } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        run: { type: "string" },
        agent: { type: "string" },
        timeout: { type: "string" },
        "no-push": { type: "boolean" },
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

  const push = values["no-push"] !== true;
  const timeoutMs = parseTimeoutMs(values.timeout as string | undefined);
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const env = process.env;
  const store = new Store();
  const agent = resolveApplyAgent(store, values.agent as string | undefined);
  const paths = resolvePaths();
  const runDir = paths.runDir(runId);
  const reportPath = paths.report(runId);
  const transcriptPath = paths.transcript(runId);

  const records = readReviewTranscript(transcriptPath);
  const started = records.find((r) => r.kind === "review.started");
  if (started === undefined) {
    throw errors.usage(`run ${runId} has no review.started record`);
  }
  if (started.runId !== runId) {
    throw errors.usage(`--run ${runId} does not match the transcript runId`);
  }
  const finished = records.find((r) => r.kind === "review.finished");
  if (finished === undefined) {
    throw errors.usage("review is still running; wait for it to finish before apply");
  }
  const pr = started.task.pr?.trim();
  if (pr === undefined || pr.length === 0) {
    throw errors.usage("apply requires a PR URL in the review transcript (this run used --task)");
  }

  let report: string;
  try {
    report = readFileSync(reportPath, "utf8");
  } catch (cause) {
    throw errors.io(`cannot read report.md for ${runId}`, {
      cause: cause instanceof Error ? cause.name : "IO",
    });
  }
  if (report.trim().length === 0) {
    throw errors.usage(`report.md for ${runId} is empty`);
  }

  const root = bindTrustedRoot(paths.runsRoot);
  if (root === null) {
    throw errors.io("the runs dir is missing (refusing to create an apply workspace)");
  }
  const workspace = prepareApplyWorkspace(runDir, root);

  const controller = deps.abortController ?? new AbortController();
  let signaled = false;
  const onSignal = (): void => {
    if (signaled) return;
    signaled = true;
    controller.abort("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const outcomeBase = {
    reviewRunId: runId,
    agent: {
      id: agent.id,
      name: agent.name,
      driverId: agent.driverSelection.driverId,
      modelId: agent.modelId,
    },
    workspace,
    pr,
    branch: "",
    pushed: false,
    commit: null as string | null,
    changed: false,
    summary: "",
  };

  const finish = async (partial: {
    status: ApplyOutcome["status"];
    exitCode: number;
    failure: ApplyOutcome["failure"];
    extra?: Partial<ApplyOutcome>;
  }): Promise<never> => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    const outcome: ApplyOutcome = {
      ...outcomeBase,
      ...partial.extra,
      status: partial.status,
      exitCode: partial.exitCode,
      failure: partial.failure,
    };
    try {
      atomicWriteFile(join(runDir, "apply.json"), `${JSON.stringify(outcome, null, 2)}\n`);
    } catch {
      // best-effort sidecar
    }
    await out.finish(outcome, renderApplyHuman);
    throw new ApplyExit(outcome.exitCode);
  };

  try {
    out.progress(`apply ${runId} starting`);
    out.progress(`  agent: ${agent.name} — ${agent.driverSelection.driverId}/${agent.modelId}`);
    out.progress(`  pr: ${pr}`);
    out.progress(`  push: ${push ? "yes (default)" : "no"}`);

    const probeSpec = buildProbeSpec(agent, {
      probeId: `probe-${agent.driverSelection.driverId}`,
      cwd: process.cwd(),
      prompt: DRIVER_PROBE_PROMPT,
    });
    const probe = await spawnOnce(probeSpec, {
      timeoutMs: PROBE_TIMEOUT_MS,
      signal: controller.signal,
      spawnImpl: deps.spawnImpl,
    });
    if (controller.signal.aborted) {
      await finish({
        status: "interrupted",
        exitCode: EXIT.interrupted,
        failure: { phase: "probe", code: "ABORTED", message: "run aborted by signal" },
      });
    }
    if (probe.status !== "success") {
      await finish({
        status: "failed",
        exitCode: EXIT.runFailed,
        failure: {
          phase: "probe",
          code: probe.failure?.code ?? "DRIVER_UNREACHABLE",
          message: probe.failure?.message ?? "apply agent probe failed",
        },
      });
    }

    out.progress("  checking out PR into isolated workspace");
    const checked = await checkoutPullRequest(pr, workspace, runCommand, env);
    outcomeBase.branch = checked.branch;
    excludeApplyReport(workspace);
    writeFileSync(join(workspace, APPLY_REPORT_FILENAME), report, {
      encoding: "utf8",
      mode: 0o600,
    });
    const shaBefore = await gitHeadSha(workspace, runCommand, env);

    const prompt = buildApplyPrompt({
      agentName: agent.name,
      prUrl: pr,
      branch: checked.branch,
      reportFile: APPLY_REPORT_FILENAME,
    });
    const spec = buildSpawnSpec(agent, {
      attemptId: `apply-${randomUUID()}`,
      workspace,
      prompt,
    });
    out.progress(`  spawning ${agent.name} in ${workspace}`);
    const result: AttemptResult = await spawnOnce(spec, {
      timeoutMs,
      signal: controller.signal,
      spawnImpl: deps.spawnImpl,
    });
    if (controller.signal.aborted) {
      await finish({
        status: "interrupted",
        exitCode: EXIT.interrupted,
        extra: { branch: checked.branch, summary: result.output },
        failure: { phase: "apply", code: "ABORTED", message: "run aborted by signal" },
      });
    }
    if (result.status !== "success") {
      await finish({
        status: "failed",
        exitCode: EXIT.runFailed,
        extra: { branch: checked.branch, summary: result.output },
        failure: {
          phase: "apply",
          code: result.failure?.code ?? "APPLY_FAILED",
          message: result.failure?.message ?? "apply agent produced no output",
        },
      });
    }

    const leftover = await gitWorkingTreeDirty(workspace, runCommand, env, [APPLY_REPORT_FILENAME]);
    if (leftover) {
      await commitLeftoverChanges(
        workspace,
        `fix: apply CouncilKit review ${runId}`,
        runCommand,
        env,
        [APPLY_REPORT_FILENAME],
      );
    }
    const sha = await gitHeadSha(workspace, runCommand, env);
    const branch = await currentBranch(workspace, runCommand, env, checked.branch);
    outcomeBase.branch = branch;
    outcomeBase.commit = sha;
    outcomeBase.changed = leftover || (sha !== null && sha !== shaBefore);
    outcomeBase.summary = result.output;

    if (push) {
      out.progress(`  git push ${branch}`);
      await pushCurrentBranch(workspace, runCommand, env);
      outcomeBase.pushed = true;
    } else {
      out.progress("  skipping git push (--no-push)");
    }

    out.progress(
      `  apply -> success (${formatDurationMs(result.durationMs)}${outcomeBase.pushed ? ", pushed" : ""})`,
    );
    await finish({
      status: "completed",
      exitCode: EXIT.ok,
      extra: {
        branch,
        pushed: outcomeBase.pushed,
        commit: sha,
        changed: outcomeBase.changed,
        summary: result.output,
      },
      failure: null,
    });
  } catch (error) {
    if (error instanceof ApplyExit) throw error;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (controller.signal.aborted) {
      await finish({
        status: "interrupted",
        exitCode: EXIT.interrupted,
        failure: { phase: "apply", code: "ABORTED", message: "run aborted by signal" },
      });
    }
    if (error instanceof CliError) {
      await finish({
        status: "failed",
        exitCode: error.exitCode,
        extra: { branch: outcomeBase.branch, commit: outcomeBase.commit },
        failure: {
          phase: typeof error.detail?.phase === "string" ? error.detail.phase : "apply",
          code: "APPLY_FAILED",
          message: error.message,
        },
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    await finish({
      status: "failed",
      exitCode: EXIT.runFailed,
      extra: { branch: outcomeBase.branch },
      failure: { phase: "apply", code: "APPLY_FAILED", message },
    });
  }
}

function resolveApplyAgent(store: Store, ref: string | undefined): AgentRecord {
  if (ref !== undefined) {
    const agent = store.getAgent(ref);
    if (!agent.enabled) {
      throw errors.usage(`agent "${agent.name}" is disabled; cannot apply`);
    }
    return agent;
  }
  const enabled = store.listAgents().filter((a) => a.enabled);
  const named = enabled.find((a) => a.name === DEFAULT_AGENT_NAME);
  if (named?.driverSelection.driverId === "grok-stream-json") return named;
  const groks = enabled.filter((a) => a.driverSelection.driverId === "grok-stream-json");
  if (groks.length === 1) return groks[0];
  if (groks.length > 1) {
    throw errors.usage(
      "multiple grok-stream-json agents; pass --agent <name|id> (default is review-adversarial)",
    );
  }
  throw errors.usage(
    "apply defaults to a grok-stream-json agent (review-adversarial). Run `councilkit init` with grok on PATH, or pass --agent.",
  );
}

function prepareApplyWorkspace(runDir: string, root: TrustedRoot): string {
  revalidateTrustedRoot(root);
  const workspace = join(runDir, "workspaces", "apply");
  assertWithinRoot(root, workspace);
  let runStat: Stats;
  try {
    runStat = lstatSync(runDir);
  } catch (cause) {
    throw errors.io("failed to stat the run dir", {
      cause: cause instanceof Error ? cause.name : "IO",
    });
  }
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw errors.io("the run dir is not a real directory (refusing to create apply workspace)");
  }
  let wsStat: Stats | null = null;
  try {
    wsStat = lstatSync(workspace);
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") {
      throw errors.io("failed to stat apply workspace", {
        cause: cause instanceof Error ? cause.name : "IO",
      });
    }
  }
  if (wsStat !== null) {
    if (!wsStat.isDirectory() || wsStat.isSymbolicLink()) {
      throw errors.io("the apply workspace path is not a real directory (refusing to remove it)");
    }
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch (cause) {
      throw errors.io("failed to clear apply workspace", {
        cause: cause instanceof Error ? cause.name : "IO",
      });
    }
  }
  try {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw errors.io("failed to create apply workspace", {
      cause: cause instanceof Error ? cause.name : "IO",
    });
  }
  return workspace;
}

function excludeApplyReport(workspace: string): void {
  const excludePath = join(workspace, ".git", "info", "exclude");
  try {
    mkdirSync(dirname(excludePath), { recursive: true, mode: 0o700 });
    appendFileSync(excludePath, `\n${APPLY_REPORT_FILENAME}\n`, { encoding: "utf8" });
  } catch {
    // Best effort: the prompt also forbids committing the report file.
  }
}

function renderApplyHuman(data: unknown): string {
  const o = data as ApplyOutcome;
  const lines = [
    `apply ${o.status} (exit ${o.exitCode})`,
    `  review: ${o.reviewRunId}`,
    `  agent: ${o.agent.name} (${o.agent.driverId}/${o.agent.modelId})`,
    `  pr: ${o.pr}`,
    `  branch: ${o.branch || "(unknown)"}`,
    `  workspace: ${o.workspace}`,
    `  commit: ${o.commit ?? "(none)"}`,
    `  pushed: ${o.pushed ? "yes" : "no"}`,
  ];
  if (o.failure) {
    lines.push(`  failure: [${o.failure.phase}] ${o.failure.code} — ${o.failure.message}`);
  }
  if (o.summary.trim().length > 0) {
    lines.push("", o.summary.trim());
  }
  return lines.join("\n");
}
