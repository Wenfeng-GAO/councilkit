/**
 * `councilkit init` — discover local review drivers on PATH and write the
 * default PR-jury roster into the CLI store. Does not talk to the Runtime Host.
 */
import { findExecutable } from "../auto/driver-commands";
import { errors } from "../errors";
import {
  DEFAULT_AGENT_SPECS,
  type DefaultAgentSpec,
  NEXT_REVIEW_HINT,
  PR_JURY_BACKGROUND,
  PR_JURY_COUNCIL_NAME,
  PR_JURY_ROUNDS,
  PR_JURY_TARGET_OUTPUT,
  PR_JURY_TOPIC,
} from "../init/defaults";
import type { OutputSink } from "../output";
import type { AgentRecord, CouncilRecord } from "../store/schemas";
import { Store } from "../store/store";
import { parseFlags } from "./parse";

export interface InitOutcome {
  createdAgents: Array<{ id: string; name: string; driverId: string; modelId: string }>;
  reusedAgents: Array<{ id: string; name: string; driverId: string; modelId: string }>;
  createdCouncil: { id: string; name: string; reporter: string } | null;
  reusedCouncil: { id: string; name: string; reporter: string } | null;
  missingDrivers: string[];
  next: string;
}

export async function runInit(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    { flags: { json: { type: "boolean" }, force: { type: "boolean" } }, allowPositionals: 0 },
    argv,
  );
  const force = values.force === true;
  const store = new Store();
  const env = process.env;

  const available: DefaultAgentSpec[] = [];
  const missingDrivers: string[] = [];
  for (const spec of DEFAULT_AGENT_SPECS) {
    if (findExecutable(spec.executable, env) !== null) available.push(spec);
    else missingDrivers.push(spec.executable);
  }
  if (available.length === 0) {
    throw errors.usage(
      "no review drivers found on PATH (need at least one of: cld, kimi, codex). Install and login to a local CLI, then retry.",
      { missingDrivers },
    );
  }

  if (force) recreateDefaults(store);

  const createdAgents: AgentRecord[] = [];
  const reusedAgents: AgentRecord[] = [];
  for (const spec of available) {
    const existing = findByName(store, spec.name);
    if (existing !== null) {
      reusedAgents.push(existing);
      continue;
    }
    createdAgents.push(
      store.createAgent({
        name: spec.name,
        personaPrompt: spec.personaPrompt,
        modelId: spec.modelId,
        color: spec.color,
        driverSelection: spec.driverSelection,
      }),
    );
  }

  const roster = [...reusedAgents, ...createdAgents];
  const reporter = pickReporter(roster, available);
  let createdCouncil: CouncilRecord | null = null;
  let reusedCouncil: CouncilRecord | null = null;
  const existingCouncil = findCouncilByName(store, PR_JURY_COUNCIL_NAME);
  if (existingCouncil !== null) {
    reusedCouncil = existingCouncil;
  } else {
    createdCouncil = store.createCouncil({
      name: PR_JURY_COUNCIL_NAME,
      topic: PR_JURY_TOPIC,
      background: PR_JURY_BACKGROUND,
      targetOutput: PR_JURY_TARGET_OUTPUT,
      agentIds: roster.map((a) => a.id),
      rounds: PR_JURY_ROUNDS,
      reporterAgentId: reporter.id,
    });
  }

  const outcome: InitOutcome = {
    createdAgents: createdAgents.map(briefAgent),
    reusedAgents: reusedAgents.map(briefAgent),
    createdCouncil: createdCouncil === null ? null : briefCouncil(createdCouncil, store),
    reusedCouncil: reusedCouncil === null ? null : briefCouncil(reusedCouncil, store),
    missingDrivers,
    next: NEXT_REVIEW_HINT,
  };
  await out.finish(outcome, (d) => renderHuman(d as InitOutcome));
}

function recreateDefaults(store: Store): void {
  const council = findCouncilByName(store, PR_JURY_COUNCIL_NAME);
  if (council !== null) store.deleteCouncil(council.id);
  for (const spec of DEFAULT_AGENT_SPECS) {
    const agent = findByName(store, spec.name);
    if (agent !== null) store.deleteAgent(agent.id);
  }
}

function pickReporter(roster: AgentRecord[], available: DefaultAgentSpec[]): AgentRecord {
  const preferred = available.find((s) => s.preferredReporter)?.name;
  if (preferred !== undefined) {
    const match = roster.find((a) => a.name === preferred);
    if (match !== undefined) return match;
  }
  return roster[0];
}

function findByName(store: Store, name: string): AgentRecord | null {
  return store.listAgents().find((a) => a.name === name) ?? null;
}

function findCouncilByName(store: Store, name: string): CouncilRecord | null {
  return store.listCouncils().find((c) => c.name === name) ?? null;
}

function briefAgent(agent: AgentRecord): InitOutcome["createdAgents"][number] {
  return {
    id: agent.id,
    name: agent.name,
    driverId: agent.driverSelection.driverId,
    modelId: agent.modelId,
  };
}

function briefCouncil(
  council: CouncilRecord,
  store: Store,
): { id: string; name: string; reporter: string } {
  let reporter = council.reporterAgentId;
  try {
    reporter = store.getAgent(council.reporterAgentId).name;
  } catch {
    // keep id if the agent was deleted out of band
  }
  return { id: council.id, name: council.name, reporter };
}

function renderHuman(outcome: InitOutcome): string {
  const lines: string[] = [];
  const created = outcome.createdAgents.length;
  const reused = outcome.reusedAgents.length;
  const councilBit =
    outcome.createdCouncil !== null
      ? `created council ${outcome.createdCouncil.name} (reporter ${outcome.createdCouncil.reporter})`
      : outcome.reusedCouncil !== null
        ? `reused council ${outcome.reusedCouncil.name} (reporter ${outcome.reusedCouncil.reporter})`
        : "no council";
  lines.push(`init: created ${created} agent(s), reused ${reused}; ${councilBit}`);
  for (const agent of [...outcome.createdAgents, ...outcome.reusedAgents]) {
    const mark = outcome.createdAgents.some((a) => a.id === agent.id) ? "new" : "kept";
    lines.push(`  ${agent.name}  ${agent.driverId}/${agent.modelId}  [${mark}]`);
  }
  if (outcome.missingDrivers.length > 0) {
    lines.push(`missing on PATH: ${outcome.missingDrivers.join(", ")}`);
  }
  lines.push(`next: ${outcome.next}`);
  lines.push("open reports: http://127.0.0.1:43127/reports");
  return lines.join("\n");
}
