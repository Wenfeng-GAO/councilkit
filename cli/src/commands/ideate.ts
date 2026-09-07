import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_RUN_STATUS_FILE,
  type CliRunLiveHeartbeat,
  liveStateFromRecords,
  withLiveHeartbeats,
} from "@shared/runtime/cli-run-progress";
import { ideateModelsSchema } from "@shared/runtime/schemas";
import { z } from "zod";
import { ideateModelAgents, modelConfigKey } from "../auto/ideate-models";
import {
  renderIdeateReport,
  writeIdeateReport,
  writeIdeateReportCopy,
} from "../auto/ideate-report";
import {
  type AttemptSpec,
  DRIVER_PROBE_PROMPT,
  buildIdeateSpawnSpec,
  executableForDriver,
  findExecutable,
  probeTimeoutMs,
} from "../auto/driver-commands";
import {
  assertIdeateRetryReady,
  disposeIdeateAuthHome,
  prepareIdeateWorkspace,
} from "../auto/ideate-policy";
import { LiveEventWriter } from "../auto/live-events";
import {
  type AttemptResult,
  type RunnerTimers,
  type SpawnImpl,
  runAttempts,
  spawnOnce,
} from "../auto/runner";
import {
  type IdeateAttemptMeta,
  type IdeateIntegrity,
  type IdeateTranscriptRecord,
  writeIdeateTranscript,
} from "../auto/transcript";
import {
  buildAggregatePrompt,
  buildDebatePrompt,
  buildProposalPrompt,
  extractSuccessfulProposal,
  missingReportHeadings,
  type IdeateTask,
} from "../auto/templates/ideate";
import { EXIT, errors } from "../errors";
import { PRODUCT_JURY_COUNCIL_NAME } from "../init/ideate-defaults";
import type { OutputSink } from "../output";
import { atomicWriteFile } from "../store/atomic-write";
import { ensureRunDir, resolvePaths } from "../store/paths";
import type { AgentRecord } from "../store/schemas";
import { Store } from "../store/store";
import { parseFlags, parseJsonFlag, parseNonNegativeIntFlag, parseTimeoutMs } from "./parse";

const DEFAULT_ATTEMPT_TIMEOUT_MS = 300 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 1800 * 1000;
const RUN_ID_RE = /^ck-ideate-[0-9a-fA-F-]+$/;
const agentRefsSchema = z.array(z.string().min(1).max(128)).min(2).max(8);

export interface IdeateDeps {
  spawnImpl?: SpawnImpl;
  abortController?: AbortController;
  timers?: RunnerTimers;
  heartbeatIntervalMs?: number;
  now?: () => number;
}

export class IdeateExit {
  constructor(readonly exitCode: number) {}
}

export interface IdeateOutcome {
  status: "completed" | "failed" | "interrupted";
  exitCode: number;
  runId: string;
  reportPath: string;
  transcriptPath: string;
  incomplete: boolean;
  integrity: IdeateIntegrity;
  failure?: { phase: string; code: string; message: string };
}

export async function runIdeate(argv: string[], out: OutputSink, deps: IdeateDeps = {}): Promise<void> {
  const { values, positionals } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        background: { type: "string" },
        "debate-rounds": { type: "string" },
        council: { type: "string" },
        agents: { type: "string" },
        reporter: { type: "string" },
        models: { type: "string" },
        timeout: { type: "string" },
        "run-timeout": { type: "string" },
        concurrency: { type: "string" },
        out: { type: "string" },
        "run-id": { type: "string" },
      },
      allowPositionals: 1,
    },
    argv,
  );

  const idea = (positionals[0] ?? "").trim();
  if (idea.length === 0) throw errors.usage('ideate requires a positional idea, e.g. councilkit ideate "一句话创意"');
  const background = typeof values.background === "string" ? values.background : "";
  const debateRoundsRaw = values["debate-rounds"];
  const debateRounds =
    debateRoundsRaw === undefined ? 1 : parseNonNegativeIntFlag(debateRoundsRaw as string, "debate-rounds");
  if (debateRounds > 2) throw errors.usage("--debate-rounds must be 0, 1, or 2");

  const hasModels = values.models !== undefined;
  const hasCouncil = values.council !== undefined;
  const hasAgents = values.agents !== undefined;
  if (hasModels && (hasCouncil || hasAgents)) {
    throw errors.usage("--models cannot be combined with --council or --agents");
  }
  if (hasCouncil && hasAgents) throw errors.usage("pass --council or --agents, not both");
  if (hasAgents && values.reporter === undefined) {
    throw errors.usage("--reporter is required with --agents (no fallback)");
  }

  const store = new Store();
  let attemptAgents: AgentRecord[];
  let aggregatorAgent: AgentRecord;
  if (hasModels) {
    const models = parseJsonFlag(values.models as string, ideateModelsSchema, "models");
    attemptAgents = ideateModelAgents(models);
    aggregatorAgent = attemptAgents[models.aggregatorIndex] as AgentRecord;
  } else if (hasAgents) {
    const refs = parseJsonFlag(values.agents as string, agentRefsSchema, "agents");
    attemptAgents = refs.map((ref) => store.getAgent(ref));
    aggregatorAgent = store.getAgent(values.reporter as string);
    if (!attemptAgents.some((agent) => agent.id === aggregatorAgent.id)) {
      throw errors.usage("reporter must be among --agents");
    }
  } else {
    const councilRef = typeof values.council === "string" ? values.council : PRODUCT_JURY_COUNCIL_NAME;
    let council;
    try {
      council = store.getCouncil(councilRef);
    } catch {
      throw errors.usage(
        `no council "${councilRef}". Run: councilkit init --json  (creates product-jury)`,
      );
    }
    attemptAgents = store.councilAgents(council);
    aggregatorAgent = store.getAgent(council.reporterAgentId);
  }
  if (attemptAgents.length < 2 || attemptAgents.length > 8) {
    throw errors.usage(`ideate requires 2–8 seats, got ${attemptAgents.length}`);
  }

  const timeoutMs = parseTimeoutMs(values.timeout as string | undefined, DEFAULT_ATTEMPT_TIMEOUT_MS);
  const runTimeoutMs = parseTimeoutMs(
    values["run-timeout"] as string | undefined,
    DEFAULT_RUN_TIMEOUT_MS,
    "run-timeout",
  );
  const concurrency =
    values.concurrency === undefined ? 10 : Number.parseInt(String(values.concurrency), 10);
  const assigned = typeof values["run-id"] === "string" ? values["run-id"].trim() : undefined;
  if (assigned !== undefined && !RUN_ID_RE.test(assigned)) {
    throw errors.usage(`--run-id must be a ck-ideate-<uuid> run id, got "${assigned}"`);
  }
  const runId = assigned ?? `ck-ideate-${randomUUID()}`;
  const paths = resolvePaths();
  if (assigned !== undefined && existsSync(paths.transcript(runId))) {
    throw errors.usage(`--run-id ${runId} already exists`);
  }
  const runDir = ensureRunDir(runId);
  const transcriptPath = paths.transcript(runId);
  const reportPath = paths.report(runId);
  const startedAt = new Date().toISOString();
  const task: IdeateTask = { idea, background };
  const now = deps.now ?? Date.now;
  const deadline = now() + runTimeoutMs;

  const configuredKeys = [...new Set(attemptAgents.map((agent) => modelConfigKey(agent)))];
  const proposals = attemptAgents.map((agent, index) => meta(agent, `proposal-seat${index + 1}`, "proposal", 0, `proposal-seat${index + 1}`));
  const debates: IdeateAttemptMeta[] = [];
  for (let round = 1; round <= debateRounds; round++) {
    const order = rotate(attemptAgents, round === 2 ? 1 : 0);
    for (const agent of order) {
      const seat = attemptAgents.findIndex((row) => row.id === agent.id) + 1;
      debates.push(meta(agent, `debate-r${round}-seat${seat}`, "debate", round, `proposal-seat${seat}`));
    }
  }
  const aggregatorMeta = meta(aggregatorAgent, "aggregate-final", "aggregate", 0, "aggregate-final");

  const controller = deps.abortController ?? new AbortController();
  let signaled = false;
  const onSignal = (): void => {
    if (signaled) return;
    signaled = true;
    controller.abort("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const ephemeralHomes: string[] = [];
  const trackSpec = (spec: AttemptSpec): AttemptSpec => {
    if (spec.ephemeralHome !== undefined) ephemeralHomes.push(spec.ephemeralHome);
    return spec;
  };
  const disposeAuthHomes = (): void => {
    for (const dir of ephemeralHomes) disposeIdeateAuthHome(dir);
    ephemeralHomes.length = 0;
  };
  const budget = (): number => Math.min(timeoutMs, remaining(now, deadline));
  const deadlineHandle = deps.timers
    ? deps.timers.setInterval(() => {
        if (now() >= deadline && !controller.signal.aborted) controller.abort("RUN_DEADLINE");
      }, 25)
    : (() => {
        const handle = setInterval(() => {
          if (now() >= deadline && !controller.signal.aborted) controller.abort("RUN_DEADLINE");
        }, 25);
        handle.unref?.();
        return handle;
      })();
  const clearDeadline = (): void => {
    if (deps.timers) deps.timers.clearInterval(deadlineHandle);
    else clearInterval(deadlineHandle as NodeJS.Timeout);
  };

  const transcript: IdeateTranscriptRecord[] = [];
  const liveBeats = new Map<string, CliRunLiveHeartbeat>();
  const liveWriter = new LiveEventWriter(runDir);
  const flush = (): void => {
    writeIdeateTranscript(transcriptPath, transcript);
    persistStatus(runDir, transcript, liveBeats);
  };
  const noteLiveBeat = (
    attemptId: string,
    elapsedMs: number | undefined,
    lastActivity: string | null,
    started = false,
  ): void => {
    const prev = liveBeats.get(attemptId);
    liveBeats.set(attemptId, {
      attemptId,
      elapsedMs: elapsedMs ?? prev?.elapsedMs,
      lastActivity: lastActivity ?? prev?.lastActivity ?? null,
      started: started || prev?.started === true,
    });
    try {
      persistStatus(runDir, transcript, liveBeats);
    } catch {
      // Live status is a sidecar; never fail ideate because of it.
    }
  };
  const onHeartbeat = (
    attemptId: string,
    _agentName: string,
    elapsedMs: number,
    snapshot?: { lastActivity: string | null },
  ): void => {
    noteLiveBeat(attemptId, elapsedMs, snapshot?.lastActivity ?? null, true);
  };
  const onActivity = (attemptId: string, lastActivity: string): void => {
    noteLiveBeat(attemptId, undefined, lastActivity, true);
  };
  const clearLiveBeat = (attemptId: string): void => {
    liveBeats.delete(attemptId);
  };

  try {
  const probeResults = [];
  const probeCwd = join(runDir, "probe");
  mkdirSync(probeCwd, { recursive: true, mode: 0o700 });
  const probeByKey = new Map<string, { status: "success" | "failure"; durationMs: number; failure?: { code: string; message: string } }>();
  for (const agent of uniqueAgents([...attemptAgents, aggregatorAgent])) {
    if (shouldStop(controller, now, deadline)) break;
    const key = modelConfigKey(agent);
    if (probeByKey.has(key)) continue;
    const exeName = executableForDriver(agent.driverSelection.driverId);
    const exe = exeName === undefined ? null : findExecutable(exeName);
    if (exe === null) {
      const rec = {
        driverId: agent.driverSelection.driverId,
        modelId: agent.modelId,
        status: "failure" as const,
        durationMs: 0,
        failure: { code: "DRIVER_UNREACHABLE", message: "executable not on PATH" },
      };
      probeResults.push(rec);
      probeByKey.set(key, rec);
      continue;
    }
    try {
      const workspace = join(probeCwd, agent.id);
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const spec = trackSpec(
        buildIdeateSpawnSpec(agent, {
          attemptId: `probe-${agent.id}`,
          workspace,
          prompt: DRIVER_PROBE_PROMPT,
          probe: true,
        }),
      );
      const result = await spawnOnce(spec, {
        timeoutMs: Math.min(probeTimeoutMs(agent.driverSelection.driverId), remaining(now, deadline)),
        signal: controller.signal,
        spawnImpl: deps.spawnImpl,
        timers: deps.timers,
      });
      const rec = {
        driverId: agent.driverSelection.driverId,
        modelId: agent.modelId,
        status: result.status,
        durationMs: result.durationMs,
        failure: result.failure,
      };
      probeResults.push(rec);
      probeByKey.set(key, rec);
      out.progress(`  probe ${agent.name} -> ${result.status}`);
    } catch (error) {
      const rec = {
        driverId: agent.driverSelection.driverId,
        modelId: agent.modelId,
        status: "failure" as const,
        durationMs: 0,
        failure: { code: "PROBE_ERROR", message: error instanceof Error ? error.message : String(error) },
      };
      probeResults.push(rec);
      probeByKey.set(key, rec);
    }
  }

  transcript.push({
    kind: "ideate.started",
    version: 1,
    runId,
    startedAt,
    idea,
    background,
    debateRounds,
    proposals,
    debates,
    aggregator: aggregatorMeta,
    probe: probeResults,
    configuredModels: configuredKeys.map((key) => {
      const parsed = JSON.parse(key) as [string, unknown, string];
      return { driverId: parsed[0], options: parsed[1], modelId: parsed[2] };
    }),
  });
  transcript.push({ kind: "ideate.stage", version: 1, stage: "proposing", at: new Date().toISOString() });
  flush();

  const proposalResults: AttemptResult[] = [];
  const debateResults: AttemptResult[] = [];
  let aggregation: AttemptResult | null = null;
  const proposalSpecs = [];
  let contextTruncated = false;
  for (const row of proposals) {
    const agent = attemptAgents.find((item) => item.id === row.agentId) as AgentRecord;
    const probe = probeByKey.get(modelConfigKey(agent));
    if (probe?.status !== "success") {
      const synthetic = failedResult(row, probe?.durationMs ?? 0, {
        code: "DRIVER_UNREACHABLE",
        message: probe?.failure?.message ?? "probe failed",
      });
      proposalResults.push(synthetic);
      recordAttempt(transcript, synthetic);
      continue;
    }
    const built = buildProposalPrompt({
      agentName: agent.name,
      personaPrompt: agent.personaPrompt,
      task,
      proposalRef: row.proposalRef,
    });
    contextTruncated = contextTruncated || built.truncated;
    try {
      const workspace = join(runDir, "workspaces", row.attemptId);
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const spec = trackSpec(
        buildIdeateSpawnSpec(agent, { attemptId: row.attemptId, workspace, prompt: built.prompt }),
      );
      spec.timeoutMs = budget();
      proposalSpecs.push(spec);
    } catch (error) {
      const synthetic = failedResult(row, 0, {
        code: "PROMPT_BUDGET",
        message: error instanceof Error ? error.message : String(error),
      });
      proposalResults.push(synthetic);
      recordAttempt(transcript, synthetic);
    }
  }
  flush();

  if (proposalSpecs.length > 0 && !shouldStop(controller, now, deadline)) {
    const wave = await runAttempts(proposalSpecs, {
      timeoutMs: budget(),
      concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 10,
      signal: controller.signal,
      spawnImpl: deps.spawnImpl,
      timers: deps.timers,
      heartbeatIntervalMs: deps.heartbeatIntervalMs,
      onAttemptStart: (attemptId) => {
        noteLiveBeat(attemptId, 0, null, true);
      },
      onHeartbeat,
      onActivity,
      onAttemptFinish: (result) => {
        clearLiveBeat(result.attemptId);
        recordAttempt(transcript, result);
        flush();
        out.progress(`  proposal ${result.agentName} -> ${result.status}`);
      },
      onLiveEvent: (attemptId, events) => liveWriter.append(attemptId, events),
      rebuildWorkspaceBeforeRetry: (spec) => recreateIdeateWorkspace(spec),
    });
    if (wave.aborted) signaled = true;
    for (const result of wave.results) upsertAttempt(proposalResults, result);
  }

  const successfulProposals = proposalResults.filter(
    (row) => row.status === "success" && extractSuccessfulProposal(row.output, row.attemptId) !== null,
  );
  if (successfulProposals.length === 0) {
    return finish({
      status: controller.signal.aborted || now() >= deadline ? "interrupted" : "failed",
      phase: "proposal",
      code: successfulProposals.length === 0 && !controller.signal.aborted ? "NO_PROPOSALS" : "STOPPED",
      message:
        controller.signal.aborted || now() >= deadline
          ? "run stopped before any successful proposal"
          : "zero successful proposals; refusing debate and aggregation",
    });
  }

  if (debateRounds > 0 && !shouldStop(controller, now, deadline)) {
    transcript.push({ kind: "ideate.stage", version: 1, stage: "debating", at: new Date().toISOString() });
    flush();
    const priorDebates: Array<{ id: string; text: string }> = [];
    for (const row of debates) {
      if (shouldStop(controller, now, deadline)) break;
      const agent = attemptAgents.find((item) => item.id === row.agentId) as AgentRecord;
      const probe = probeByKey.get(modelConfigKey(agent));
      if (probe?.status !== "success") {
        const synthetic = failedResult(row, probe?.durationMs ?? 0, {
          code: "DRIVER_UNREACHABLE",
          message: probe?.failure?.message ?? "probe failed",
        });
        debateResults.push(synthetic);
        recordAttempt(transcript, synthetic);
        flush();
        continue;
      }
      const built = buildDebatePrompt({
        agentName: agent.name,
        personaPrompt: agent.personaPrompt,
        task,
        proposalRef: row.proposalRef,
        proposals: successfulProposals.map((item) => ({ id: item.attemptId, text: item.output })),
        priorDebates,
        round: row.round,
        totalRounds: debateRounds,
      });
      if ("code" in built) {
        const synthetic = failedResult(row, 0, built);
        debateResults.push(synthetic);
        recordAttempt(transcript, synthetic);
        flush();
        continue;
      }
      contextTruncated = contextTruncated || built.truncated;
      try {
        const workspace = join(runDir, "workspaces", row.attemptId);
        mkdirSync(workspace, { recursive: true, mode: 0o700 });
        const spec = trackSpec(
          buildIdeateSpawnSpec(agent, { attemptId: row.attemptId, workspace, prompt: built.prompt }),
        );
        noteLiveBeat(row.attemptId, 0, null, true);
        const result = await spawnOnce(spec, {
          timeoutMs: budget(),
          signal: controller.signal,
          spawnImpl: deps.spawnImpl,
          timers: deps.timers,
          heartbeatIntervalMs: deps.heartbeatIntervalMs,
          onHeartbeat,
          onActivity,
          onLiveEvent: (attemptId, events) => liveWriter.append(attemptId, events),
        });
        clearLiveBeat(result.attemptId);
        debateResults.push(result);
        recordAttempt(transcript, result);
        flush();
        out.progress(`  debate ${result.attemptId} -> ${result.status}`);
        if (result.status === "success" && result.output.trim().length > 0) {
          priorDebates.push({ id: result.attemptId, text: result.output });
        }
      } catch (error) {
        clearLiveBeat(row.attemptId);
        const synthetic = failedResult(row, 0, {
          code: "SPAWN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
        debateResults.push(synthetic);
        recordAttempt(transcript, synthetic);
        flush();
      }
    }
  }

  if (shouldStop(controller, now, deadline) && debateRounds > 0 && debateResults.length < debates.length) {
    // keep going to aggregate only if we still have proposals and were not cancelled mid-deadline with abort
  }

  if (controller.signal.aborted) {
    return finish({
      status: "interrupted",
      phase: "debate",
      code: "INTERRUPTED",
      message: "run cancelled before aggregation",
    });
  }
  if (now() >= deadline) {
    return finish({
      status: "failed",
      phase: "deadline",
      code: "RUN_DEADLINE",
      message: "full-run deadline reached; no new spawn after the budget",
    });
  }

  transcript.push({ kind: "ideate.stage", version: 1, stage: "aggregating", at: new Date().toISOString() });
  flush();
  const successfulDebates = debateResults.filter((row) => row.status === "success" && row.output.trim().length > 0);
  const successConfigs = new Set(
    successfulProposals
      .map((row) => attemptAgents.find((agent) => agent.id === row.agentId))
      .filter((agent): agent is AgentRecord => agent !== undefined)
      .map((agent) => modelConfigKey(agent)),
  );
  const aggPrompt = buildAggregatePrompt({
    task,
    proposals: successfulProposals.map((row) => ({
      id: row.attemptId,
      agentName: row.agentName,
      text: row.output,
    })),
    debates: successfulDebates.map((row) => ({
      id: row.attemptId,
      agentName: row.agentName,
      text: row.output,
    })),
    singleProposal: successfulProposals.length === 1,
    singleModel: successConfigs.size <= 1,
    debateScheduled: debateRounds > 0,
    debateSucceeded: successfulDebates.length,
  });
  contextTruncated = contextTruncated || aggPrompt.truncated;

  const aggProbe = probeByKey.get(modelConfigKey(aggregatorAgent));
  if (aggProbe?.status !== "success") {
    aggregation = failedResult(aggregatorMeta, aggProbe?.durationMs ?? 0, {
      code: "DRIVER_UNREACHABLE",
      message: aggProbe?.failure?.message ?? "aggregator probe failed",
    });
  } else {
    try {
      const workspace = join(runDir, "workspaces", "aggregate-final");
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const spec = trackSpec(
        buildIdeateSpawnSpec(aggregatorAgent, {
          attemptId: "aggregate-final",
          workspace,
          prompt: aggPrompt.prompt,
        }),
      );
      noteLiveBeat("aggregate-final", 0, null, true);
      aggregation = await spawnOnce(spec, {
        timeoutMs: budget(),
        signal: controller.signal,
        spawnImpl: deps.spawnImpl,
        timers: deps.timers,
        heartbeatIntervalMs: deps.heartbeatIntervalMs,
        onHeartbeat,
        onActivity,
        onLiveEvent: (attemptId, events) => liveWriter.append(attemptId, events),
      });
    } catch (error) {
      aggregation = failedResult(aggregatorMeta, 0, {
        code: "SPAWN_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    clearLiveBeat("aggregate-final");
  }
  if (controller.signal.aborted || aggregation.failure?.code === "ABORTED") {
    return finish({
      status: "interrupted",
      phase: "aggregate",
      code: "INTERRUPTED",
      message: "run cancelled during aggregation",
      aggregation,
    });
  }
  const missing =
    aggregation.status === "success" ? missingReportHeadings(aggregation.output) : ["## 决策与范围"];
  const bodyValid = aggregation.status === "success" && aggregation.output.trim().length > 0 && missing.length === 0;
  transcript.push({
    kind: "aggregation.finished",
    version: 1,
    attemptId: "aggregate-final",
    agentName: aggregatorAgent.name,
    driverId: aggregatorAgent.driverSelection.driverId,
    status: bodyValid ? "success" : "failure",
    output: aggregation.output,
    exitCode: aggregation.exitCode,
    durationMs: aggregation.durationMs,
    failure: bodyValid
      ? null
      : {
          code: aggregation.failure?.code ?? "INVALID_DECISION",
          message: bodyValid
            ? ""
            : missing.length > 0
              ? `missing chapters: ${missing.join(", ")}`
              : aggregation.failure?.message ?? "empty aggregator output",
        },
    activity: aggregation.activity,
  });
  flush();

  return finish({
    status: bodyValid ? "completed" : "failed",
    phase: "aggregate",
    code: bodyValid ? "OK" : "INVALID_DECISION",
    message: bodyValid ? "" : missing.length > 0 ? `missing chapters: ${missing.join(", ")}` : "aggregator failed",
    aggregation,
  });

  async function finish(input: {
    status: "completed" | "failed" | "interrupted";
    phase: string;
    code: string;
    message: string;
    aggregation?: AttemptResult | null;
  }): Promise<void> {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    const endedAt = new Date().toISOString();
    const integrity = buildIntegrity({
      proposals,
      debates,
      proposalResults,
      debateResults,
      configured: configuredKeys.length,
      successfulModels: new Set(
        successfulProposals
          .map((row) => attemptAgents.find((agent) => agent.id === row.agentId))
          .filter((agent): agent is AgentRecord => agent !== undefined)
          .map((agent) => modelConfigKey(agent)),
      ).size,
      debateRounds,
      contextTruncated,
      aggregationFailed: input.status !== "completed",
    });
    const agg = input.aggregation ?? aggregation;
    const markdown = renderIdeateReport({
      runId,
      startedAt,
      endedAt,
      idea,
      background,
      debateRounds,
      status: input.status,
      integrity,
      aggregator: {
        agentName: aggregatorAgent.name,
        driverId: aggregatorAgent.driverSelection.driverId,
        modelId: aggregatorAgent.modelId,
      },
      aggregation: agg,
      proposals: proposals.map((row) => ({
        ...row,
        result: latestAttempt(proposalResults, row.attemptId),
      })),
      debates: debates.map((row) => ({
        ...row,
        result: latestAttempt(debateResults, row.attemptId),
      })),
      failure: input.status === "completed" ? undefined : { phase: input.phase, code: input.code, message: input.message },
    });
    writeIdeateReport(reportPath, markdown);
    if (typeof values.out === "string") writeIdeateReportCopy(values.out, markdown);
    liveBeats.clear();
    transcript.push({
      kind: "ideate.finished",
      version: 1,
      status: input.status,
      endedAt,
      incomplete: integrity.incomplete,
      reportPath,
      integrity,
      failure:
        input.status === "completed" ? undefined : { phase: input.phase, code: input.code, message: input.message },
    });
    flush();
    const exitCode =
      input.status === "interrupted" || controller.signal.aborted
        ? EXIT.interrupted
        : input.status === "failed"
          ? EXIT.runFailed
          : EXIT.ok;
    const outcome: IdeateOutcome = {
      status: input.status,
      exitCode,
      runId,
      reportPath,
      transcriptPath,
      incomplete: integrity.incomplete,
      integrity,
      failure:
        input.status === "completed" ? undefined : { phase: input.phase, code: input.code, message: input.message },
    };
    await out.finish(outcome, (data) => renderHuman(data as IdeateOutcome));
    throw new IdeateExit(exitCode);
  }
  } finally {
    clearDeadline();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    disposeAuthHomes();
  }
}

function meta(
  agent: AgentRecord,
  attemptId: string,
  stage: "proposal" | "debate" | "aggregate",
  round: number,
  proposalRef: string,
) {
  return {
    attemptId,
    agentId: agent.id,
    agentName: agent.name,
    driverId: agent.driverSelection.driverId,
    modelId: agent.modelId,
    stage,
    round,
    proposalRef,
  };
}

function rotate<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const n = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

function uniqueAgents(agents: AgentRecord[]): AgentRecord[] {
  const seen = new Set<string>();
  const out: AgentRecord[] = [];
  for (const agent of agents) {
    const key = modelConfigKey(agent);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(agent);
  }
  return out;
}

function shouldStop(controller: AbortController, now: () => number, deadline: number): boolean {
  return controller.signal.aborted || now() >= deadline;
}

function remaining(now: () => number, deadline: number): number {
  return Math.max(1, deadline - now());
}

function failedResult(
  row: { attemptId: string; agentId: string; agentName: string; driverId: string; modelId: string },
  durationMs: number,
  failure: { code: string; message: string },
): AttemptResult {
  return {
    attemptId: row.attemptId,
    agentId: row.agentId,
    agentName: row.agentName,
    driverId: row.driverId,
    modelId: row.modelId,
    status: "failure",
    output: "",
    exitCode: null,
    durationMs,
    workspace: "",
    failure,
  };
}

function recordAttempt(transcript: IdeateTranscriptRecord[], result: AttemptResult): void {
  transcript.push({
    kind: "attempt.finished",
    version: 1,
    attemptId: result.attemptId,
    agentName: result.agentName,
    driverId: result.driverId,
    status: result.status,
    output: result.status === "success" ? result.output : null,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    failure: result.failure ?? null,
    activity: result.activity,
    attemptNumber: result.attemptNumber,
    retryOf: result.retryOf,
  });
}

function persistStatus(
  runDir: string,
  records: IdeateTranscriptRecord[],
  beats: Map<string, CliRunLiveHeartbeat>,
): void {
  const live = liveStateFromRecords(records, new Date().toISOString());
  if (live === null) return;
  const next = beats.size === 0 ? live : withLiveHeartbeats(live, beats.values());
  next.progress.updatedAt = new Date().toISOString();
  atomicWriteFile(join(runDir, CLI_RUN_STATUS_FILE), `${JSON.stringify(next)}\n`);
}

function upsertAttempt(list: AttemptResult[], result: AttemptResult): void {
  const idx = list.findIndex((row) => row.attemptId === result.attemptId);
  if (idx === -1) list.push(result);
  else list[idx] = result;
}

function latestAttempt(list: AttemptResult[], attemptId: string): AttemptResult | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i];
    if (row?.attemptId === attemptId) return row;
  }
  return null;
}

function recreateIdeateWorkspace(spec: AttemptSpec): void {
  rmSync(spec.cwd, { recursive: true, force: true });
  mkdirSync(spec.cwd, { recursive: true, mode: 0o700 });
  prepareIdeateWorkspace(spec.cwd);
  assertIdeateRetryReady(spec);
}

function buildIntegrity(input: {
  proposals: Array<{ attemptId: string; agentName: string }>;
  debates: Array<{ attemptId: string; agentName: string }>;
  proposalResults: AttemptResult[];
  debateResults: AttemptResult[];
  configured: number;
  successfulModels: number;
  debateRounds: number;
  contextTruncated: boolean;
  aggregationFailed: boolean;
}): IdeateIntegrity {
  const logicalProposals = logicalAttempts(input.proposals, input.proposalResults);
  const logicalDebates = logicalAttempts(input.debates, input.debateResults);
  const successfulProposals = logicalProposals.filter(
    (row) => row.status === "success" && extractSuccessfulProposal(row.output, row.attemptId),
  ).length;
  const successfulDebates = logicalDebates.filter(
    (row) => row.status === "success" && row.output.trim().length > 0,
  ).length;
  const failedSeats = [
    ...logicalProposals
      .filter((row) => row.status !== "success")
      .map((row) => ({
        stage: "proposal" as const,
        attemptId: row.attemptId,
        agentName: row.agentName,
        code: row.failure?.code ?? "FAILED",
        message: row.failure?.message ?? "failed",
      })),
    ...logicalDebates
      .filter((row) => row.status !== "success")
      .map((row) => ({
        stage: "debate" as const,
        attemptId: row.attemptId,
        agentName: row.agentName,
        code: row.failure?.code ?? "FAILED",
        message: row.failure?.message ?? "failed",
      })),
  ];
  const degradedReasons: string[] = [];
  if (successfulProposals === 1) degradedReasons.push("单份提案，比较不足");
  if (input.successfulModels <= 1) degradedReasons.push("单模型来源");
  if (input.debateRounds === 0) degradedReasons.push("未安排辩论");
  if (input.debateRounds > 0 && successfulDebates === 0) degradedReasons.push("未完成交叉讨论");
  if (failedSeats.length > 0) degradedReasons.push("部分席位失败");
  if (input.aggregationFailed) degradedReasons.push("汇总未形成合格决策");
  const incomplete =
    successfulProposals < input.proposals.length ||
    (input.debateRounds > 0 && successfulDebates < input.debates.length) ||
    input.aggregationFailed;
  return {
    plannedProposals: input.proposals.length,
    successfulProposals,
    plannedDebates: input.debates.length,
    successfulDebates,
    configuredModels: input.configured,
    successfulModels: input.successfulModels,
    incomplete,
    degradedReasons,
    contextTruncated: input.contextTruncated,
    failedSeats,
  };
}

function logicalAttempts(
  planned: Array<{ attemptId: string }>,
  results: AttemptResult[],
): AttemptResult[] {
  return planned.flatMap((row) => {
    const result = latestAttempt(results, row.attemptId);
    return result === null ? [] : [result];
  });
}

function renderHuman(outcome: IdeateOutcome): string {
  const lines = [
    `ideate ${outcome.status}${outcome.incomplete ? " (incomplete)" : ""}  ${outcome.runId}`,
    `report: ${outcome.reportPath}`,
    `proposals ${outcome.integrity.successfulProposals}/${outcome.integrity.plannedProposals}  debates ${outcome.integrity.successfulDebates}/${outcome.integrity.plannedDebates}  models ${outcome.integrity.successfulModels}/${outcome.integrity.configuredModels}`,
    ...outcome.integrity.degradedReasons.map((reason) => `degraded: ${reason}`),
  ];
  if (outcome.failure) lines.push(`failure [${outcome.failure.phase}/${outcome.failure.code}]: ${outcome.failure.message}`);
  return lines.join("\n");
}
