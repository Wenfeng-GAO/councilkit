/**
 * `councilkit agent create|list|show|delete` (brief §2a, plan-a §8). Thin
 * command-layer wrappers over the stateless Store. The Driver Selection is
 * built from `--driver-id` + `--options` (a JSON object) and validated by the
 * strict shared schema inside the Store; the CLI never persists an
 * installationId or credentialMode.
 */
import { z } from "zod";
import { errors } from "../errors";
import type { OutputSink } from "../output";
import type { AgentRecord } from "../store/schemas";
import { Store } from "../store/store";
import { parseFlags, parseJsonFlag } from "./parse";

const optionsSchema = z.record(z.string(), z.unknown());

export async function runAgent(argv: string[], out: OutputSink): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "create":
      return createAgent(rest, out);
    case "list":
      return listAgents(rest, out);
    case "show":
      return showAgent(rest, out);
    case "delete":
      return deleteAgent(rest, out);
    default:
      throw errors.usage(
        sub === undefined
          ? "councilkit agent requires a subcommand: create|list|show|delete"
          : `unknown agent subcommand "${sub}"`,
      );
  }
}

function createAgent(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        name: { type: "string" },
        "persona-prompt": { type: "string" },
        "driver-id": { type: "string" },
        options: { type: "string" },
        "model-id": { type: "string" },
        color: { type: "string" },
        disabled: { type: "boolean" },
      },
      allowPositionals: 0,
    },
    argv,
  );
  if (values.name === undefined) throw errors.usage("--name is required");
  if (values["persona-prompt"] === undefined) throw errors.usage("--persona-prompt is required");
  if (values["driver-id"] === undefined) throw errors.usage("--driver-id is required");
  if (values["model-id"] === undefined) throw errors.usage("--model-id is required");
  if (values.color === undefined) throw errors.usage("--color is required (a #rrggbb hex)");

  const options = parseJsonFlag(values.options as string | undefined, optionsSchema, "options");
  const driverSelection = { driverId: values["driver-id"], options };

  const store = new Store();
  const agent = store.createAgent({
    name: values.name as string,
    personaPrompt: values["persona-prompt"] as string,
    modelId: values["model-id"] as string,
    color: values.color as string,
    enabled: values.disabled !== true,
    driverSelection,
  });
  finishAgent(out, agent, values.json === true);
  return Promise.resolve();
}

function listAgents(argv: string[], out: OutputSink): Promise<void> {
  parseFlags({ flags: { json: { type: "boolean" } }, allowPositionals: 0 }, argv);
  const store = new Store();
  const agents = store.listAgents();
  const view = { agents: agents.map(agentView) };
  out.finish(view, (d) => {
    const list = (d as { agents: ReturnType<typeof agentView>[] }).agents;
    if (list.length === 0) return "no agents stored. create one with `councilkit agent create`.";
    return list
      .map((a) => `${a.id}  ${a.name}  [${a.driverId}]  model=${a.modelId}  enabled=${a.enabled}`)
      .join("\n");
  });
  return Promise.resolve();
}

function showAgent(argv: string[], out: OutputSink): Promise<void> {
  const { values, positionals } = parseFlags(
    { flags: { json: { type: "boolean" } }, allowPositionals: 1 },
    argv,
  );
  const ref = positionals[0];
  if (!ref) throw errors.usage("councilkit agent show requires an agent name or id");
  const store = new Store();
  const agent = store.getAgent(ref);
  finishAgent(out, agent, values.json === true);
  return Promise.resolve();
}

function deleteAgent(argv: string[], out: OutputSink): Promise<void> {
  const { positionals } = parseFlags(
    { flags: { json: { type: "boolean" } }, allowPositionals: 1 },
    argv,
  );
  const ref = positionals[0];
  if (!ref) throw errors.usage("councilkit agent delete requires an agent name or id");
  const store = new Store();
  const res = store.deleteAgent(ref);
  const view = { deleted: true, id: res.deletedId };
  out.finish(view, (d) => `deleted agent ${JSON.stringify((d as typeof view).id)}`);
  return Promise.resolve();
}

function agentView(a: AgentRecord) {
  return {
    id: a.id,
    name: a.name,
    driverId: a.driverSelection.driverId,
    options: a.driverSelection.options,
    modelId: a.modelId,
    color: a.color,
    enabled: a.enabled,
  };
}

function finishAgent(out: OutputSink, agent: AgentRecord, json: boolean): void {
  void json;
  out.finish(agentView(agent), (d) =>
    [
      `id: ${(d as ReturnType<typeof agentView>).id}`,
      `name: ${(d as ReturnType<typeof agentView>).name}`,
    ].join("\n"),
  );
}
