/**
 * `councilkit init` — discover local review drivers on PATH (and vendor
 * homes `~/.kimi-code/bin` / `~/.grok/bin`) and write the default PR-jury
 * roster into the CLI store. Does not talk to the Runtime Host.
 */
import { isExactDefaultModelAlias } from "@shared/runtime/default-model-alias";
import { errors } from "../errors";
import {
  DEFAULT_AGENT_NAMES,
  DEFAULT_AGENT_SPECS,
  type DefaultAgentSpec,
  NEXT_REVIEW_HINT,
  PR_JURY_BACKGROUND,
  PR_JURY_COUNCIL_NAME,
  PR_JURY_ROUNDS,
  PR_JURY_TARGET_OUTPUT,
  PR_JURY_TOPIC,
} from "../init/defaults";
import { type DriverStatus, collectDriverStatus } from "../init/driver-status";
import { type InitCouncilBrief, initHumanFromOutcome, renderInitHuman } from "../init/human-report";
import {
  IDEATE_AGENT_NAMES,
  IDEATE_AGENT_SPECS,
  IDEATE_REPORTER_FALLBACK,
  type IdeateAgentSpec,
  NEXT_IDEATE_HINT,
  PRODUCT_JURY_BACKGROUND,
  PRODUCT_JURY_COUNCIL_NAME,
  PRODUCT_JURY_ROUNDS,
  PRODUCT_JURY_TARGET_OUTPUT,
  PRODUCT_JURY_TOPIC,
} from "../init/ideate-defaults";
import { CODEX_MODEL_OVERRIDE_NEXT, ideateDriverSkip, reviewSkip } from "../init/skipped-seats";
import type { OutputSink } from "../output";
import type { AgentRecord, CouncilRecord, SkippedSeat } from "../store/schemas";
import { Store } from "../store/store";
import { configuredCodexModel } from "./jury";
import { parseFlags } from "./parse";

export interface InitOutcome {
  createdAgents: Array<{ id: string; name: string; driverId: string; modelId: string }>;
  reusedAgents: Array<{ id: string; name: string; driverId: string; modelId: string }>;
  createdCouncil: { id: string; name: string; reporter: string } | null;
  reusedCouncil: { id: string; name: string; reporter: string } | null;
  missingDrivers: string[];
  /** One row per known driver: found, path, version, login, and a next step. */
  drivers: DriverStatus[];
  /** Default seats this init did not create, also stored on the council. */
  skippedSeats: SkippedSeat[];
  /** Per-council roster used by the human report. Ideate seats stay out of pr-jury. */
  councils: InitCouncilBrief[];
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
  const drivers = collectDriverStatus(env);

  const available: DefaultAgentSpec[] = [];
  const reviewSkips: SkippedSeat[] = [];
  const missingDrivers: string[] = [];
  for (const spec of DEFAULT_AGENT_SPECS) {
    const skip = reviewSkip(spec, drivers);
    if (skip !== null) {
      reviewSkips.push(skip);
      if (skip.reason === "missing" && !missingDrivers.includes(spec.executable)) {
        missingDrivers.push(spec.executable);
      }
    } else {
      available.push(spec);
    }
  }
  const ideateAvailable: IdeateAgentSpec[] = [];
  const ideateSkips: SkippedSeat[] = [];
  for (const spec of IDEATE_AGENT_SPECS) {
    const skip = ideateDriverSkip(spec, drivers);
    if (skip !== null) {
      ideateSkips.push(skip);
      if (skip.reason === "missing" && !missingDrivers.includes(spec.executable)) {
        missingDrivers.push(spec.executable);
      }
    } else {
      ideateAvailable.push(spec);
    }
  }
  noteCodexDefaultModel(drivers, env);

  if (available.length === 0) {
    const skippedSeats = [...reviewSkips, ...ideateSkips];
    const lines = renderInitHuman({
      failure: true,
      councils: [
        {
          name: PR_JURY_COUNCIL_NAME,
          reporter: null,
          ready: [],
          skipped: reviewSkips,
          cldSubstitute: false,
        },
        {
          name: PRODUCT_JURY_COUNCIL_NAME,
          reporter: null,
          ready: [],
          skipped: ideateSkips,
          cldSubstitute: false,
        },
      ],
    });
    throw errors.usage(
      [
        "no review drivers found on PATH (need at least one of: cld, cfuse, kimi, grok, cursor-agent, codex). Install and login to a local CLI, then retry.",
        lines,
      ].join("\n"),
      { missingDrivers, drivers, skippedSeats },
    );
  }

  if (force) recreateDefaults(store);

  const createdAgents: AgentRecord[] = [];
  const reusedAgents: AgentRecord[] = [];
  for (const spec of available) {
    const modelId = reviewModelId(spec, env);
    const existing = findByName(store, spec.name);
    if (existing !== null) {
      const sameDriver = existing.driverSelection.driverId === spec.driverSelection.driverId;
      const sameModel = existing.modelId === modelId;
      if (!sameDriver || !sameModel) {
        reusedAgents.push(
          store.updateAgent(existing.id, {
            modelId,
            driverSelection: spec.driverSelection,
          }),
        );
      } else {
        reusedAgents.push(existing);
      }
      continue;
    }
    createdAgents.push(
      store.createAgent({
        name: spec.name,
        personaPrompt: spec.personaPrompt,
        modelId,
        color: spec.color,
        driverSelection: spec.driverSelection,
      }),
    );
  }

  const reviewRoster = [...reusedAgents, ...createdAgents];
  const reporter = pickReporter(reviewRoster, available);
  let createdCouncil: CouncilRecord | null = null;
  let reusedCouncil: CouncilRecord | null = null;
  const existingCouncil = findCouncilByName(store, PR_JURY_COUNCIL_NAME);
  if (existingCouncil !== null) {
    reusedCouncil = store.syncCouncilRoster(
      existingCouncil.id,
      reviewRoster,
      reporter.id,
      reviewSkips,
    );
  } else {
    createdCouncil = store.createCouncil({
      name: PR_JURY_COUNCIL_NAME,
      topic: PR_JURY_TOPIC,
      background: PR_JURY_BACKGROUND,
      targetOutput: PR_JURY_TARGET_OUTPUT,
      agentIds: reviewRoster.map((a) => a.id),
      rounds: PR_JURY_ROUNDS,
      reporterAgentId: reporter.id,
      skippedSeats: reviewSkips,
    });
  }

  const ideateRoster: AgentRecord[] = [];
  const dropAgentIds: string[] = [];
  for (const spec of ideateAvailable) {
    const existing = findByName(store, spec.name);
    const modelId = ideateModelId(spec, existing, env);
    if (modelId === null) {
      if (existing !== null) dropAgentIds.push(existing.id);
      continue;
    }
    if (existing !== null) {
      const sameDriver = existing.driverSelection.driverId === spec.driverSelection.driverId;
      const sameModel = existing.modelId === modelId;
      if (!sameDriver || !sameModel) {
        const updated = store.updateAgent(existing.id, {
          modelId,
          driverSelection: spec.driverSelection,
        });
        reusedAgents.push(updated);
        ideateRoster.push(updated);
      } else {
        reusedAgents.push(existing);
        ideateRoster.push(existing);
      }
      continue;
    }
    const created = store.createAgent({
      name: spec.name,
      personaPrompt: spec.personaPrompt,
      modelId,
      color: spec.color,
      driverSelection: spec.driverSelection,
    });
    createdAgents.push(created);
    ideateRoster.push(created);
  }
  let productReporterName: string | null = null;
  const existingProduct = findCouncilByName(store, PRODUCT_JURY_COUNCIL_NAME);
  const persistProduct = ideateRoster.length >= 2;
  const dropFromProduct =
    existingProduct !== null && dropAgentIds.some((id) => existingProduct.agentIds.includes(id));
  if (persistProduct || dropFromProduct) {
    const productReporter = pickProductReporter(store, ideateRoster, existingProduct, dropAgentIds);
    if (productReporter !== null && existingProduct !== null) {
      store.syncCouncilRoster(
        existingProduct.id,
        ideateRoster,
        productReporter.id,
        ideateSkips,
        dropAgentIds,
      );
    } else if (productReporter !== null && persistProduct) {
      store.createCouncil({
        name: PRODUCT_JURY_COUNCIL_NAME,
        topic: PRODUCT_JURY_TOPIC,
        background: PRODUCT_JURY_BACKGROUND,
        targetOutput: PRODUCT_JURY_TARGET_OUTPUT,
        agentIds: ideateRoster.map((a) => a.id),
        rounds: PRODUCT_JURY_ROUNDS,
        reporterAgentId: productReporter.id,
        skippedSeats: ideateSkips,
      });
    }
    if (persistProduct && productReporter !== null) productReporterName = productReporter.name;
  }

  const outcome: InitOutcome = {
    createdAgents: createdAgents.map(briefAgent),
    reusedAgents: reusedAgents.map(briefAgent),
    createdCouncil: createdCouncil === null ? null : briefCouncil(createdCouncil, store),
    reusedCouncil: reusedCouncil === null ? null : briefCouncil(reusedCouncil, store),
    missingDrivers,
    drivers,
    skippedSeats: [...reviewSkips, ...ideateSkips],
    councils: [
      {
        name: PR_JURY_COUNCIL_NAME,
        reporter: reporter.name,
        ready: seatsInOrder(reviewRoster, DEFAULT_AGENT_NAMES),
        skippedSeats: reviewSkips,
      },
      ...(ideateRoster.length === 0 && ideateSkips.length === 0
        ? []
        : [
            {
              name: PRODUCT_JURY_COUNCIL_NAME,
              reporter: productReporterName,
              ready: seatsInOrder(ideateRoster, IDEATE_AGENT_NAMES),
              skippedSeats: ideateSkips,
            },
          ]),
    ],
    next: `${NEXT_REVIEW_HINT} · ${NEXT_IDEATE_HINT}`,
  };
  await out.finish(outcome, (d) => initHumanFromOutcome(d as InitOutcome));
}

function recreateDefaults(store: Store): void {
  for (const name of [PR_JURY_COUNCIL_NAME, PRODUCT_JURY_COUNCIL_NAME]) {
    const council = findCouncilByName(store, name);
    if (council !== null) store.deleteCouncil(council.id);
  }
  for (const spec of [...DEFAULT_AGENT_SPECS, ...IDEATE_AGENT_SPECS]) {
    const agent = findByName(store, spec.name);
    if (agent === null) continue;
    const stillUsed = store.listCouncils().some((council) => council.agentIds.includes(agent.id));
    if (stillUsed) continue;
    store.deleteAgent(agent.id);
  }
}

function seatsInOrder(
  agents: readonly AgentRecord[],
  names: readonly string[],
): Array<{ name: string; modelId: string }> {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  return names.flatMap((name) => {
    const agent = byName.get(name);
    return agent === undefined ? [] : [{ name: agent.name, modelId: agent.modelId }];
  });
}

function reviewModelId(spec: DefaultAgentSpec, env: NodeJS.ProcessEnv): string {
  if (spec.name !== "review-codex") return spec.modelId;
  return configuredCodexModel(env) ?? spec.modelId;
}

function ideateModelId(
  spec: IdeateAgentSpec,
  existing: AgentRecord | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (spec.modelId !== null) return spec.modelId;
  if (existing !== null && !isExactDefaultModelAlias(existing.modelId)) return existing.modelId;
  // No top-level model: leave ideate-challenger uncreated. review-codex still
  // stores `default` and omits `-m`. Do not record a no-model skip.
  return configuredCodexModel(env);
}

function pickProductReporter(
  store: Store,
  roster: readonly AgentRecord[],
  existing: CouncilRecord | null,
  dropAgentIds: readonly string[],
): AgentRecord | null {
  if (roster.length > 0) return pickIdeateReporter(roster, existing);
  if (existing === null) return null;
  const drop = new Set(dropAgentIds);
  const remaining = existing.agentIds.filter((id) => !drop.has(id)).map((id) => store.getAgent(id));
  if (remaining.length === 0) return null;
  return remaining.find((agent) => agent.id === existing.reporterAgentId) ?? remaining[0];
}

function noteCodexDefaultModel(drivers: DriverStatus[], env: NodeJS.ProcessEnv): void {
  if (configuredCodexModel(env) !== null) return;
  const row = drivers.find((item) => item.driver === "codex");
  if (row === undefined || !row.found || row.login === "logged-out" || row.next !== null) return;
  row.next = CODEX_MODEL_OVERRIDE_NEXT;
}

const REPORTER_FALLBACK = ["review-adversarial", "review-correctness"] as const;

function pickReporter(roster: AgentRecord[], available: DefaultAgentSpec[]): AgentRecord {
  const availableNames = new Set(available.map((s) => s.name));
  for (const name of REPORTER_FALLBACK) {
    if (!availableNames.has(name)) continue;
    const match = roster.find((a) => a.name === name);
    if (match !== undefined) return match;
  }
  const preferred = available.find((s) => s.preferredReporter)?.name;
  if (preferred !== undefined) {
    const match = roster.find((a) => a.name === preferred);
    if (match !== undefined) return match;
  }
  return roster[0];
}

function pickIdeateReporter(
  roster: readonly AgentRecord[],
  existing: CouncilRecord | null,
): AgentRecord {
  if (existing !== null) {
    const current = roster.find((agent) => agent.id === existing.reporterAgentId);
    if (current !== undefined) return current;
  }
  for (const name of IDEATE_REPORTER_FALLBACK) {
    const match = roster.find((agent) => agent.name === name);
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
