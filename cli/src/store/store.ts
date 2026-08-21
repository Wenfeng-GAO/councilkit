/**
 * Agent/council CRUD (plan-a §3, §9 阶段二). The store is stateless: every call
 * re-reads the managed file(s) and writes atomically, so two Store instances
 * observe each other's committed changes (single-writer assumption documented,
 * D1 §11 — no cross-process locking in V1).
 *
 * Invariants enforced here:
 *  - agent `id` and `name` are unique; reference resolution prefers exact id
 *    then exact name, and reports ambiguity as a usage error.
 *  - deleting an agent referenced by a council is rejected with the referencing
 *    councils listed (no dangling refs, plan-a §3 / A 引用保护).
 *  - council creation validates: reporter is in agentIds, all referenced agents
 *    exist and are enabled, agent count (incl. reporter) ≤ maxParticipantsPerScope.
 *    No reporter fallback (D1).
 *  - disk corruption / unknown fields / unsupported version surface as a
 *    diagnostic CliError(io) carrying the file + redacted zod summary, never the
 *    raw content.
 */
import { randomUUID } from "node:crypto";
import { EXIT, errors } from "../errors";
import { zodFailureMessage } from "../output";
import { redact } from "../redact";
import { atomicWriteJson, readFileText } from "./atomic-write";
import { type StorePaths, ensureHome, resolvePaths } from "./paths";
import {
  AGENTS_FORMAT,
  AGENTS_VERSION,
  type AgentRecord,
  COUNCILS_FORMAT,
  COUNCILS_VERSION,
  type CouncilRecord,
  agentRecordSchema,
  agentsFileSchema,
  councilRecordSchema,
  councilsFileSchema,
} from "./schemas";

export interface StoreEnv {
  env?: NodeJS.ProcessEnv;
}

export class Store {
  private readonly paths: StorePaths;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: StoreEnv = {}) {
    this.env = opts.env ?? process.env;
    this.paths = resolvePaths(this.env);
  }

  // ----- agents -----------------------------------------------------------

  listAgents(): AgentRecord[] {
    return this.readAgents().agents;
  }

  /** Resolve an agent by id-or-name. Returns the agent or throws a usage error
   * (not found / ambiguous name). */
  getAgent(ref: string): AgentRecord {
    const agents = this.listAgents();
    const byId = agents.filter((a) => a.id === ref);
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) {
      throw errors.usage(`agent ref "${redactName(ref)}" matched multiple ids`);
    }
    const byName = agents.filter((a) => a.name === ref);
    if (byName.length === 0) {
      throw errors.usage(`no agent matches ref "${redactName(ref)}"`);
    }
    if (byName.length > 1) {
      throw errors.usage(`agent name "${redactName(ref)}" is ambiguous (${byName.length} agents)`);
    }
    return byName[0];
  }

  createAgent(input: {
    name: string;
    personaPrompt: string;
    modelId: string;
    color: string;
    enabled?: boolean;
    driverSelection: unknown;
  }): AgentRecord {
    const parsed = agentRecordSchema.safeParse({
      id: randomUUID(),
      name: input.name,
      personaPrompt: input.personaPrompt,
      modelId: input.modelId,
      color: input.color,
      enabled: input.enabled ?? true,
      driverSelection: input.driverSelection,
    });
    if (!parsed.success) {
      throw errors.usage(zodFailureMessage(parsed.error.issues, "invalid agent"));
    }
    const file = this.readAgents();
    if (file.agents.some((a) => a.id === parsed.data.id)) {
      throw errors.usage("agent id collision (retry)");
    }
    if (file.agents.some((a) => a.name === parsed.data.name)) {
      throw errors.usage(`agent name "${redactName(parsed.data.name)}" already exists`);
    }
    file.agents.push(parsed.data);
    this.writeAgents(file);
    return parsed.data;
  }

  updateAgent(
    ref: string,
    patch: { modelId?: string; driverSelection?: unknown; personaPrompt?: string },
  ): AgentRecord {
    const current = this.getAgent(ref);
    const parsed = agentRecordSchema.safeParse({
      ...current,
      modelId: patch.modelId ?? current.modelId,
      personaPrompt: patch.personaPrompt ?? current.personaPrompt,
      driverSelection: patch.driverSelection ?? current.driverSelection,
    });
    if (!parsed.success) {
      throw errors.usage(zodFailureMessage(parsed.error.issues, "invalid agent"));
    }
    const file = this.readAgents();
    file.agents = file.agents.map((row) => (row.id === current.id ? parsed.data : row));
    this.writeAgents(file);
    return parsed.data;
  }

  deleteAgent(ref: string): { deletedId: string; freed: true } {
    const agent = this.getAgent(ref);
    const councils = this.readCouncils().councils;
    const referencing = councils.filter((c) => c.agentIds.includes(agent.id));
    if (referencing.length > 0) {
      throw errors.usage(
        `agent "${redactName(agent.name)}" is referenced by ${referencing.length} ` +
          `council(s): ${referencing.map((c) => redactName(c.name)).join(", ")}`,
        { referencedBy: referencing.map((c) => ({ id: c.id, name: redactName(c.name) })) },
      );
    }
    const file = this.readAgents();
    const next = file.agents.filter((a) => a.id !== agent.id);
    if (next.length === file.agents.length) {
      throw errors.usage(`no agent matches ref "${redactName(ref)}"`);
    }
    file.agents = next;
    this.writeAgents(file);
    return { deletedId: agent.id, freed: true };
  }

  // ----- councils ---------------------------------------------------------

  listCouncils(): CouncilRecord[] {
    return this.readCouncils().councils;
  }

  getCouncil(ref: string): CouncilRecord {
    const councils = this.listCouncils();
    const byId = councils.filter((c) => c.id === ref);
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) {
      throw errors.usage(`council ref "${redactName(ref)}" matched multiple ids`);
    }
    const byName = councils.filter((c) => c.name === ref);
    if (byName.length === 0) {
      throw errors.usage(`no council matches ref "${redactName(ref)}"`);
    }
    if (byName.length > 1) {
      throw errors.usage(`council name "${redactName(ref)}" is ambiguous`);
    }
    return byName[0];
  }

  createCouncil(input: {
    name: string;
    topic: string;
    background?: string;
    targetOutput?: string;
    agentIds: string[];
    rounds: number;
    reporterAgentId: string;
  }): CouncilRecord {
    const parsed = councilRecordSchema.safeParse({
      id: randomUUID(),
      name: input.name,
      topic: input.topic,
      background: input.background ?? "",
      targetOutput: input.targetOutput ?? "",
      agentIds: input.agentIds,
      rounds: input.rounds,
      reporterAgentId: input.reporterAgentId,
    });
    if (!parsed.success) {
      throw errors.usage(zodFailureMessage(parsed.error.issues, "invalid council"));
    }
    const rec = parsed.data;
    // Unique agentIds (no repeats).
    if (new Set(rec.agentIds).size !== rec.agentIds.length) {
      throw errors.usage("council agentIds contains duplicates");
    }
    // Reporter must be a member.
    if (!rec.agentIds.includes(rec.reporterAgentId)) {
      throw errors.usage("reporter must be among agentIds");
    }
    // All referenced agents exist and are enabled (fail-fast, D1 引用保护).
    const agents = this.listAgents();
    const agentsById = new Map(agents.map((a) => [a.id, a]));
    for (const id of rec.agentIds) {
      const found = agentsById.get(id);
      if (!found) {
        throw errors.usage(`council references unknown or deleted agent id "${redactName(id)}"`);
      }
      if (!found.enabled) {
        throw errors.usage(
          `agent "${redactName(found.name)}" is disabled; a council cannot include it`,
        );
      }
    }
    // Count including reporter ≤ maxParticipantsPerScope (reporter is already in
    // agentIds per the membership check above).
    // (councilRecordSchema already caps agentIds length at the quota.)

    const file = this.readCouncils();
    if (file.councils.some((c) => c.id === rec.id)) {
      throw errors.usage("council id collision (retry)");
    }
    if (file.councils.some((c) => c.name === rec.name)) {
      throw errors.usage(`council name "${redactName(rec.name)}" already exists`);
    }
    file.councils.push(rec);
    this.writeCouncils(file);
    return rec;
  }

  /** Add missing roster agents and set the reporter. Used by `init` to keep
   * pr-jury aligned with discovered drivers without `--force`. */
  syncCouncilRoster(councilRef: string, roster: AgentRecord[], reporterId: string): CouncilRecord {
    const council = this.getCouncil(councilRef);
    const ids = [...council.agentIds];
    for (const agent of roster) {
      if (!ids.includes(agent.id)) ids.push(agent.id);
    }
    if (!ids.includes(reporterId)) {
      throw errors.usage("reporter must be among council agents");
    }
    if (
      ids.length === council.agentIds.length &&
      ids.every((id, i) => id === council.agentIds[i]) &&
      council.reporterAgentId === reporterId
    ) {
      return council;
    }
    const file = this.readCouncils();
    const idx = file.councils.findIndex((c) => c.id === council.id);
    if (idx < 0) throw errors.usage(`no council matches ref "${redactName(councilRef)}"`);
    const next: CouncilRecord = { ...council, agentIds: ids, reporterAgentId: reporterId };
    file.councils[idx] = next;
    this.writeCouncils(file);
    return next;
  }

  deleteCouncil(ref: string): { deletedId: string; freed: true } {
    const council = this.getCouncil(ref);
    const file = this.readCouncils();
    const next = file.councils.filter((c) => c.id !== council.id);
    if (next.length === file.councils.length) {
      throw errors.usage(`no council matches ref "${redactName(ref)}"`);
    }
    file.councils = next;
    this.writeCouncils(file);
    return { deletedId: council.id, freed: true };
  }

  // ----- low-level read/write ---------------------------------------------

  private readAgents(): { format: "councilkit-agents"; version: 1; agents: AgentRecord[] } {
    ensureHome(this.env);
    const text = readFileText(this.paths.agents);
    if (text === null) {
      // Fresh array — never share the EMPTY_AGENTS reference, or a push here
      // would corrupt every later call that also took the empty branch.
      return { format: AGENTS_FORMAT, version: AGENTS_VERSION, agents: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw errors.io("agents.json is not valid JSON (file is corrupt)");
    }
    const validated = agentsFileSchema.safeParse(parsed);
    if (!validated.success) {
      throw errors.io(
        zodFailureMessage(validated.error.issues, "agents.json failed schema validation"),
        { file: "agents.json" },
      );
    }
    return validated.data;
  }

  private writeAgents(file: {
    format: "councilkit-agents";
    version: 1;
    agents: AgentRecord[];
  }): void {
    try {
      atomicWriteJson(this.paths.agents, redact(file));
    } catch (cause) {
      throw errors.io(`failed to write agents.json: ${ioName(cause)}`, { cause: ioName(cause) });
    }
  }

  private readCouncils(): {
    format: "councilkit-councils";
    version: 1;
    councils: CouncilRecord[];
  } {
    ensureHome(this.env);
    const text = readFileText(this.paths.councils);
    if (text === null) {
      return { format: COUNCILS_FORMAT, version: COUNCILS_VERSION, councils: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw errors.io("councils.json is not valid JSON (file is corrupt)");
    }
    const validated = councilsFileSchema.safeParse(parsed);
    if (!validated.success) {
      throw errors.io(
        zodFailureMessage(validated.error.issues, "councils.json failed schema validation"),
        { file: "councils.json" },
      );
    }
    return validated.data;
  }

  private writeCouncils(file: {
    format: "councilkit-councils";
    version: 1;
    councils: CouncilRecord[];
  }): void {
    try {
      atomicWriteJson(this.paths.councils, redact(file));
    } catch (cause) {
      throw errors.io(`failed to write councils.json: ${ioName(cause)}`, {
        cause: ioName(cause),
      });
    }
  }
}

// Suppress unused-export lint for EXIT re-export parity if needed elsewhere.
export { EXIT };

function ioName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return "IOFailure";
}

function redactName(name: string): string {
  // Names are user content, not secrets, but run them through the redactor so a
  // name that happens to contain a cookie-shaped string can never leak through a
  // diagnostic. Keeps secret-hygiene tests honest.
  return redact(name) as string;
}
