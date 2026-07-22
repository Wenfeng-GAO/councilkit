/**
 * `councilkit council create|list|show|delete` (brief §2a, plan-a §8). Wraps the
 * Store with the council creation contract: Reporter is mandatory and must be
 * among agentIds; all referenced agents exist + are enabled; agentIds
 * (incl. Reporter) ≤ maxParticipantsPerScope. No reporter fallback.
 */
import { z } from "zod";
import { errors } from "../errors";
import type { OutputSink } from "../output";
import type { CouncilRecord } from "../store/schemas";
import { Store } from "../store/store";
import { parseFlags, parseIntFlag, parseJsonFlag } from "./parse";

const agentRefsSchema = z.array(z.string().min(1).max(128)).min(1);

export async function runCouncilCmd(argv: string[], out: OutputSink): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "create":
      return createCouncil(rest, out);
    case "list":
      return listCouncils(rest, out);
    case "show":
      return showCouncil(rest, out);
    case "delete":
      return deleteCouncil(rest, out);
    default:
      throw errors.usage(
        sub === undefined
          ? "councilkit council requires a subcommand: create|list|show|delete"
          : `unknown council subcommand "${sub}"`,
      );
  }
}

function createCouncil(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        name: { type: "string" },
        topic: { type: "string" },
        background: { type: "string" },
        "target-output": { type: "string" },
        agents: { type: "string" },
        rounds: { type: "string" },
        reporter: { type: "string" },
      },
      allowPositionals: 0,
    },
    argv,
  );
  if (values.name === undefined) throw errors.usage("--name is required");
  if (values.topic === undefined) throw errors.usage("--topic is required");
  if (values.reporter === undefined) throw errors.usage("--reporter is required (no fallback)");

  const agentRefs = parseJsonFlag(values.agents as string | undefined, agentRefsSchema, "agents");
  const rounds = parseIntFlag(values.rounds as string | undefined, "rounds");

  const store = new Store();
  // Resolve every ref to an agent id up front (refs may be names; a run needs
  // stable ids). Reporter ref resolved the same way.
  const ids = agentRefs.map((ref) => store.getAgent(ref).id);
  const reporterId = store.getAgent(values.reporter as string).id;

  const council = store.createCouncil({
    name: values.name as string,
    topic: values.topic as string,
    background: values.background as string | undefined,
    targetOutput: values["target-output"] as string | undefined,
    agentIds: ids,
    rounds,
    reporterAgentId: reporterId,
  });
  finishCouncil(out, council);
  return Promise.resolve();
}

function listCouncils(argv: string[], out: OutputSink): Promise<void> {
  parseFlags({ flags: { json: { type: "boolean" } }, allowPositionals: 0 }, argv);
  const store = new Store();
  const councils = store.listCouncils();
  const view = { councils: councils.map(councilView) };
  out.finish(view, (d) => {
    const list = (d as { councils: ReturnType<typeof councilView>[] }).councils;
    if (list.length === 0)
      return "no councils stored. create one with `councilkit council create`.";
    return list
      .map(
        (c) =>
          `${c.id}  ${c.name}  rounds=${c.rounds}  agents=${c.agentIds.length}  reporter=${c.reporterAgentId}`,
      )
      .join("\n");
  });
  return Promise.resolve();
}

function showCouncil(argv: string[], out: OutputSink): Promise<void> {
  const { positionals } = parseFlags(
    { flags: { json: { type: "boolean" } }, allowPositionals: 1 },
    argv,
  );
  const ref = positionals[0];
  if (!ref) throw errors.usage("councilkit council show requires a council name or id");
  const store = new Store();
  finishCouncil(out, store.getCouncil(ref));
  return Promise.resolve();
}

function deleteCouncil(argv: string[], out: OutputSink): Promise<void> {
  const { positionals } = parseFlags(
    { flags: { json: { type: "boolean" } }, allowPositionals: 1 },
    argv,
  );
  const ref = positionals[0];
  if (!ref) throw errors.usage("councilkit council delete requires a council name or id");
  const store = new Store();
  const res = store.deleteCouncil(ref);
  const view = { deleted: true, id: res.deletedId };
  out.finish(view, (d) => `deleted council ${JSON.stringify((d as typeof view).id)}`);
  return Promise.resolve();
}

function councilView(c: CouncilRecord) {
  return {
    id: c.id,
    name: c.name,
    topic: c.topic,
    background: c.background,
    targetOutput: c.targetOutput,
    agentIds: c.agentIds,
    rounds: c.rounds,
    reporterAgentId: c.reporterAgentId,
  };
}

function finishCouncil(out: OutputSink, council: CouncilRecord): void {
  out.finish(councilView(council), (d) => {
    const c = d as ReturnType<typeof councilView>;
    return [
      `id: ${c.id}`,
      `name: ${c.name}`,
      `topic: ${c.topic}`,
      `rounds: ${c.rounds}`,
      `reporter: ${c.reporterAgentId}`,
      `agents: ${c.agentIds.join(", ")}`,
    ].join("\n");
  });
}
