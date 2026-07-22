/**
 * `councilkit run` — drive a Council Run and emit a Markdown report (brief §2a,
 * plan-a §6/§8). Two forms: `--council <ref>` for a stored Council, or a
 * one-shot `--agents '<json-array>'` with `--topic`/`--reporter`. `--rounds`
 * overrides the Council's rounds; `--out` adds an atomic report copy.
 *
 * The command resolves installations + readiness up front (exit 3 on any
 * pre-run fault), hands the RunInput to the orchestrator with a SIGINT-coupled
 * AbortSignal, and exits with the orchestrator's outcome exit code
 * (0/4/5/7/130). Progress/diagnostics go to stderr in --json mode; the final
 * RunOutcome is the single stdout JSON document.
 */
import { randomUUID } from "node:crypto";
import { QUOTAS } from "@shared/runtime/contracts";
import { z } from "zod";
import { errors } from "../errors";
import { HostClient } from "../host/client";
import type { OutputSink } from "../output";
import { resolveRunAgents, runCouncil } from "../run/orchestrator";
import type { CouncilSnapshot, RunInput } from "../run/types";
import { resolvePaths } from "../store/paths";
import type { CouncilRecord } from "../store/schemas";
import { Store } from "../store/store";
import { parseFlags, parseIntFlag, parseJsonFlag } from "./parse";

const agentRefsSchema = z.array(z.string().min(1).max(128)).min(1);

export async function runRun(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        council: { type: "string" },
        agents: { type: "string" },
        topic: { type: "string" },
        background: { type: "string" },
        "target-output": { type: "string" },
        reporter: { type: "string" },
        rounds: { type: "string" },
        out: { type: "string" },
      },
      allowPositionals: 0,
    },
    argv,
  );

  const store = new Store();
  const paths = resolvePaths();

  let council: CouncilRecord;
  let rounds: number;
  if (values.council !== undefined) {
    if (
      values.agents !== undefined ||
      values.topic !== undefined ||
      values.reporter !== undefined
    ) {
      throw errors.usage("--council is mutually exclusive with --agents/--topic/--reporter");
    }
    council = store.getCouncil(values.council as string);
    rounds =
      values.rounds !== undefined
        ? parseIntFlag(values.rounds as string, "rounds")
        : council.rounds;
  } else {
    // One-shot inline run.
    if (values.topic === undefined) throw errors.usage("--topic is required for an inline run");
    if (values.reporter === undefined) throw errors.usage("--reporter is required (no fallback)");
    const refs = parseJsonFlag(values.agents as string | undefined, agentRefsSchema, "agents");
    const ids = refs.map((ref) => store.getAgent(ref).id);
    const reporterId = store.getAgent(values.reporter as string).id;
    rounds = values.rounds !== undefined ? parseIntFlag(values.rounds as string, "rounds") : 1;
    council = synthesizeInlineCouncil(ids, reporterId, values, rounds);
  }

  if (rounds > 16) {
    throw errors.usage("--rounds must be ≤ 16");
  }
  if (council.agentIds.length > QUOTAS.maxParticipantsPerScope) {
    throw errors.usage(
      `council has ${council.agentIds.length} agents; max is ${QUOTAS.maxParticipantsPerScope} (incl. reporter)`,
    );
  }

  // Resolve installations + readiness (exit 3 on fault).
  const host = new HostClient();
  let installations: Awaited<ReturnType<HostClient["listInstallations"]>>;
  try {
    await host.health();
    installations = await host.listInstallations();
  } catch (error) {
    throw errors.hostUnavailable(
      `Host unreachable before run: ${error instanceof Error ? error.message : String(error)}`,
      { hint: "start the Runtime Host (pnpm start) and retry" },
    );
  }

  const allAgents = store.listAgents();
  const agents = await resolveRunAgents({
    council: { agentIds: council.agentIds, reporterAgentId: council.reporterAgentId },
    agents: allAgents.map((snapshot) => ({ snapshot })),
    installations,
    host,
  });

  const reporter = agents.find((a) => a.snapshot.id === council.reporterAgentId);
  if (!reporter) {
    throw errors.usage("reporter agent is not among the participating agents");
  }

  const runId = `ck-run-${randomUUID()}`;
  const councilSnapshot: CouncilSnapshot = {
    id: council.id,
    name: council.name,
    topic: council.topic,
    background: council.background,
    targetOutput: council.targetOutput,
    rounds,
    reporterAgentId: council.reporterAgentId,
    agentIds: council.agentIds,
  };
  const runInput: RunInput = {
    runId,
    council: councilSnapshot,
    agents,
    reporter,
    rounds,
    outPath: values.out as string | undefined,
  };

  // SIGINT/SIGTERM → bounded cleanup inside the orchestrator, then exit 130.
  const controller = new AbortController();
  let signaled = false;
  const onSignal = () => {
    if (signaled) return;
    signaled = true;
    controller.abort("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const outcome = await runCouncil(runInput, {
      host,
      paths,
      signal: controller.signal,
      onProgress: (ev) => out.progress(progressMessage(ev)),
    });
    out.finish(outcome, (d) => renderHuman(d as typeof outcome));
    // Surface the exit code to the main layer via a thrown sentinel.
    throw new RunExit(outcome.exitCode);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Sentinel carrying the orchestrator's exit code up to main(). */
export class RunExit {
  constructor(readonly exitCode: number) {}
}

function synthesizeInlineCouncil(
  ids: string[],
  reporterId: string,
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
  rounds: number,
): CouncilRecord {
  if (!ids.includes(reporterId)) {
    throw errors.usage("--reporter must be among --agents");
  }
  // Construct an in-memory CouncilRecord (not persisted). It only needs to pass
  // the orchestrator's snapshot shape; the store is bypassed for inline runs.
  const rec: CouncilRecord = {
    id: `inline-${randomUUID()}`,
    name: "inline-run",
    topic: values.topic as string,
    background: (values.background as string | undefined) ?? "",
    targetOutput: (values["target-output"] as string | undefined) ?? "",
    agentIds: ids,
    rounds,
    reporterAgentId: reporterId,
  };
  return rec;
}

function progressMessage(ev: import("../run/types").RunProgressEvent): string {
  switch (ev.type) {
    case "run.starting":
      return `run ${ev.runId} starting (council ${ev.council})`;
    case "round.start":
      return `round ${ev.round}/${ev.totalRounds}`;
    case "turn.start":
      return `  turn ${ev.round}.${ev.turnIndex} ${ev.agent} (${ev.role})`;
    case "turn.done":
      return `  turn ${ev.round}.${ev.turnIndex} ${ev.agent} -> ${ev.verdict} (${ev.durationMs}ms)`;
    case "report.writing":
      return `writing report for run ${ev.runId}`;
    case "run.finishing":
      return `run finishing: ${ev.status}`;
  }
}

function renderHuman(o: import("../run/types").RunOutcome): string {
  const lines: string[] = [];
  lines.push(`Run ${o.runId}: ${o.status} (exit ${o.exitCode})`);
  lines.push(`  report: ${o.reportPath}`);
  lines.push(`  transcript: ${o.transcriptPath}`);
  lines.push(`  turns: ${o.turns.length}`);
  if (o.failure)
    lines.push(`  failure: [${o.failure.phase}] ${o.failure.code} — ${o.failure.message}`);
  if (o.artifactIoFailure)
    lines.push(
      `  artifact IO: [${o.artifactIoFailure.phase}] ${o.artifactIoFailure.code} — ${o.artifactIoFailure.message}`,
    );
  if (o.incomplete) lines.push("  (INCOMPLETE — see report.md)");
  return lines.join("\n");
}
