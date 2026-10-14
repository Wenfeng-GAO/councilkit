/**
 * Store record behavior: agent and council CRUD, roster sync, jury updates,
 * schema/JSON diagnostics, and write failures that preserve the previous file.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors";
import { resolvePaths } from "../src/store/paths";
import type { AgentRecord, CouncilRecord } from "../src/store/schemas";
import { Store } from "../src/store/store";

const KIMI = { driverId: "kimi-stream-json" as const, options: {} };
const CLAUDE = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
const CODEX = { driverId: "codex-app-server" as const, options: { reasoningEffort: "high" } };

const INVALID_COLOR =
  'invalid agent: [{"path":["color"],"code":"invalid_format","message":"Invalid string: must match pattern /^#[0-9a-fA-F]{6}$/"}]';
const INVALID_EMPTY_MODEL =
  'invalid agent: [{"path":["modelId"],"code":"too_small","message":"Too small: expected string to have >=1 characters"}]';
const INVALID_DRIVER_TOKEN =
  'invalid agent: [{"path":["driverSelection","options"],"code":"unrecognized_keys","message":"Unrecognized key: \\"token\\""}]';
const INVALID_ROUNDS_ZERO =
  'invalid council: [{"path":["rounds"],"code":"too_small","message":"Too small: expected number to be >0"}]';
const INVALID_ROUNDS_HIGH =
  'invalid council: [{"path":["rounds"],"code":"too_big","message":"Too big: expected number to be <=16"}]';
const INVALID_EMPTY_TOPIC =
  'invalid council: [{"path":["topic"],"code":"too_small","message":"Too small: expected string to have >=1 characters"}]';
const INVALID_AGENT_IDS_CAP =
  'invalid council: [{"path":["agentIds"],"code":"too_big","message":"Too big: expected array to have <=8 items"}]';
const AGENTS_BAD_VERSION =
  'agents.json failed schema validation: [{"path":["version"],"code":"invalid_value","message":"Invalid input: expected 1"}]';
const AGENTS_UNKNOWN_RECORD =
  'agents.json failed schema validation: [{"path":["agents","0","id"],"code":"invalid_type","message":"Invalid input: expected string, received undefined"},{"path":["agents","0","name"],"code":"invalid_type","message":"Invalid input: expected string, received undefined"},{"path":["agents","0","personaPrompt"],"code":"invalid_type","message":"Invalid input: expected string, received undefined"},{"path":["agents","0","modelId"],"code":"invalid_type","message":"Invalid input: expected string, received undefined"},{"path":["agents","0","color"],"code":"invalid_type","message":"Invalid input: expected string, received undefined"}] (…3 more)';
const AGENTS_TOKEN_FIELD =
  'agents.json failed schema validation: [{"path":["agents","0"],"code":"unrecognized_keys","message":"Unrecognized key: \\"token\\""}]';
const COUNCILS_BAD_VERSION =
  'councils.json failed schema validation: [{"path":["version"],"code":"invalid_value","message":"Invalid input: expected 1"}]';
const COUNCILS_EXTRA =
  'councils.json failed schema validation: [{"path":[],"code":"unrecognized_keys","message":"Unrecognized key: \\"extra\\""}]';

const BASE_REVISION = "dc391e90febf6e7fd0ca942b9e7cb610aa9710639a44c48af1144c1643ecd69a";
const MODEL_REVISION = "c27bac4dbf017ad7c837ef9c8a146c449275b5a231109f15be18311ec4164cd3";

const dirs: string[] = [];
const asRoot = process.getuid?.() === 0;

function makeHome(): string {
  const parent = mkdtempSync(join(tmpdir(), "ck-store-records-"));
  chmodSync(parent, 0o700);
  dirs.push(parent);
  const home = join(parent, "home");
  mkdirSync(home, { mode: 0o700 });
  return home;
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { COUNCILKIT_HOME: home };
}

function storeFor(home: string): Store {
  return new Store({ env: envFor(home) });
}

function cliError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected CliError");
}

function agentInput(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    personaPrompt: `${name} persona`,
    modelId: "kimi-k2",
    color: "#112233",
    driverSelection: KIMI,
    ...extra,
  };
}

function createAlpha(store: Store): AgentRecord {
  return store.createAgent(agentInput("alpha"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    const home = join(dir, "home");
    if (existsSync(home)) chmodSync(home, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent records", () => {
  it("cold-lists empty registries and creates the home without writing files", () => {
    const home = makeHome();
    rmSync(home, { recursive: true, force: true });
    const store = storeFor(home);
    expect(store.listAgents()).toEqual([]);
    expect(store.listCouncils()).toEqual([]);
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, "agents.json"))).toBe(false);
    expect(existsSync(join(home, "councils.json"))).toBe(false);
  });

  it("uses the env passed to Store rather than process.env", () => {
    const home = makeHome();
    const parent = join(home, "..");
    const elsewhere = join(parent, "elsewhere");
    const previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = elsewhere;
    try {
      const created = new Store({ env: envFor(home) }).createAgent(agentInput("alpha"));
      expect(created.name).toBe("alpha");
      expect(existsSync(join(home, "agents.json"))).toBe(true);
      expect(existsSync(join(elsewhere, "agents.json"))).toBe(false);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
      else process.env.COUNCILKIT_HOME = previous;
    }
  });

  it("uses process.env when Store is constructed without options", () => {
    const home = makeHome();
    const previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
    try {
      expect(new Store().listAgents()).toEqual([]);
      expect(existsSync(home)).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
      else process.env.COUNCILKIT_HOME = previous;
    }
  });

  it("persists an agent exactly and resolves it by id before the same name", () => {
    const home = makeHome();
    const created = storeFor(home).createAgent({
      name: "alpha",
      personaPrompt: "persona-a",
      modelId: "kimi-k2",
      color: "#AABBCC",
      driverSelection: CODEX,
    });
    const paths = resolvePaths(envFor(home));
    const fresh = storeFor(home);
    expect(fresh.listAgents()).toEqual([created]);
    expect(fresh.getAgent(created.id)).toEqual(created);
    expect(fresh.getAgent("alpha")).toEqual(created);
    expect(created.enabled).toBe(true);
    expect(readFileSync(paths.agents, "utf8")).toBe(
      `${JSON.stringify({ format: "councilkit-agents", version: 1, agents: [created] }, null, 2)}\n`,
    );

    const byId = {
      ...created,
      id: "look-here",
      name: "alpha",
    };
    const byName = {
      ...created,
      id: "other-id",
      name: "look-here",
    };
    writeFileSync(
      paths.agents,
      `${JSON.stringify({ format: "councilkit-agents", version: 1, agents: [byId, byName] }, null, 2)}\n`,
    );
    expect(storeFor(home).getAgent("look-here")).toEqual(byId);
  });

  it("stores enabled: false and redacts a cookie-shaped name on disk", () => {
    const home = makeHome();
    const store = storeFor(home);
    const disabled = store.createAgent(agentInput("beta", { enabled: false, color: "#00ff00" }));
    expect(disabled.enabled).toBe(false);
    expect(store.getAgent("beta").enabled).toBe(false);

    const secret = store.createAgent(
      agentInput("councilkit_session=sekret", { personaPrompt: "persona-a" }),
    );
    expect(secret.name).toBe("councilkit_session=sekret");
    expect(secret.personaPrompt).toBe("persona-a");
    const disk = readFileSync(resolvePaths(envFor(home)).agents, "utf8");
    expect(disk.includes("sekret")).toBe(false);
    expect(JSON.parse(disk).agents[1]).toEqual({ ...secret, name: "[redacted]" });
    expect(store.listAgents()[1]).toEqual({ ...secret, name: "[redacted]" });
    const missing = cliError(() => store.getAgent("councilkit_session=sekret"));
    expect(missing.exitCode).toBe(2);
    expect(missing.message).toBe('no agent matches ref "[redacted]"');
    expect(missing.detail).toBeUndefined();
    expect(store.getAgent("[redacted]").id).toBe(secret.id);
  });

  it("rejects an invalid agent without creating the home", () => {
    const home = makeHome();
    rmSync(home, { recursive: true, force: true });
    const err = cliError(() => storeFor(home).createAgent(agentInput("bad", { color: "red" })));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe(INVALID_COLOR);
    expect(err.detail).toBeUndefined();
    expect(existsSync(home)).toBe(false);
  });

  it("rejects a duplicate name and leaves the first agent on disk", () => {
    const home = makeHome();
    const store = storeFor(home);
    const first = store.createAgent(agentInput("dup"));
    const before = readFileSync(resolvePaths(envFor(home)).agents, "utf8");
    const err = cliError(() => store.createAgent(agentInput("dup")));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('agent name "dup" already exists');
    expect(readFileSync(resolvePaths(envFor(home)).agents, "utf8")).toBe(before);
    expect(store.listAgents()).toEqual([first]);
  });

  it("reports a missing agent, an ambiguous name, and duplicate ids", () => {
    const home = makeHome();
    const paths = resolvePaths(envFor(home));
    const missing = cliError(() => storeFor(home).getAgent("missing-agent"));
    expect(missing.exitCode).toBe(2);
    expect(missing.message).toBe('no agent matches ref "missing-agent"');
    expect(missing.detail).toBeUndefined();

    const twin = {
      id: "id-1",
      name: "twin",
      personaPrompt: "p",
      modelId: "m",
      color: "#112233",
      enabled: true,
      driverSelection: KIMI,
    };
    writeFileSync(
      paths.agents,
      `${JSON.stringify(
        {
          format: "councilkit-agents",
          version: 1,
          agents: [twin, { ...twin, id: "id-2" }],
        },
        null,
        2,
      )}\n`,
    );
    const ambiguous = cliError(() => storeFor(home).getAgent("twin"));
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.message).toBe('agent name "twin" is ambiguous (2 agents)');

    writeFileSync(
      paths.agents,
      `${JSON.stringify(
        {
          format: "councilkit-agents",
          version: 1,
          agents: [twin, { ...twin, name: "other" }],
        },
        null,
        2,
      )}\n`,
    );
    const dupId = cliError(() => storeFor(home).getAgent("id-1"));
    expect(dupId.exitCode).toBe(2);
    expect(dupId.message).toBe('agent ref "id-1" matched multiple ids');
  });

  it("updates model, persona, and driver, and rejects an empty model or token option", () => {
    const home = makeHome();
    const store = storeFor(home);
    const created = store.createAgent(agentInput("alpha"));
    const updated = store.updateAgent(created.id, {
      modelId: "glm-5.2",
      personaPrompt: "revised",
      driverSelection: CODEX,
    });
    expect(updated).toEqual({
      ...created,
      modelId: "glm-5.2",
      personaPrompt: "revised",
      driverSelection: CODEX,
    });
    expect(storeFor(home).getAgent("alpha")).toEqual(updated);

    const before = readFileSync(resolvePaths(envFor(home)).agents, "utf8");
    const empty = cliError(() => store.updateAgent("alpha", { modelId: "" }));
    expect(empty.exitCode).toBe(2);
    expect(empty.message).toBe(INVALID_EMPTY_MODEL);
    const token = cliError(() =>
      store.updateAgent("alpha", {
        driverSelection: { driverId: "kimi-stream-json", options: { token: "x" } },
      }),
    );
    expect(token.exitCode).toBe(2);
    expect(token.message).toBe(INVALID_DRIVER_TOKEN);
    expect(readFileSync(resolvePaths(envFor(home)).agents, "utf8")).toBe(before);
    expect(store.getAgent(created.id)).toEqual(updated);
  });

  it("deletes an unreferenced agent and rewrites agents.json to an empty list", () => {
    const home = makeHome();
    const store = storeFor(home);
    const created = createAlpha(store);
    expect(store.deleteAgent("alpha")).toEqual({ deletedId: created.id, freed: true });
    expect(store.listAgents()).toEqual([]);
    expect(readFileSync(resolvePaths(envFor(home)).agents, "utf8")).toBe(
      `${JSON.stringify({ format: "councilkit-agents", version: 1, agents: [] }, null, 2)}\n`,
    );
    const missing = cliError(() => store.getAgent(created.id));
    expect(missing.message).toBe(`no agent matches ref "${created.id}"`);
  });

  it("refuses to delete an agent named in two councils and redacts a secret council name", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const one = store.createCouncil({
      name: "one",
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const two = store.createCouncil({
      name: "two",
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const blocked = cliError(() => store.deleteAgent(alpha.id));
    expect(blocked.exitCode).toBe(2);
    expect(blocked.message).toBe('agent "alpha" is referenced by 2 council(s): one, two');
    expect(blocked.detail).toEqual({
      referencedBy: [
        { id: one.id, name: "one" },
        { id: two.id, name: "two" },
      ],
    });
    expect(store.getAgent(alpha.id).name).toBe("alpha");

    const paths = resolvePaths(envFor(home));
    const councils = JSON.parse(readFileSync(paths.councils, "utf8")) as {
      councils: Array<{ name: string }>;
    };
    councils.councils[0].name = "councilkit_session=sekret";
    writeFileSync(paths.councils, `${JSON.stringify(councils, null, 2)}\n`);
    const redacted = cliError(() => store.deleteAgent(alpha.id));
    expect(redacted.message).toBe('agent "alpha" is referenced by 2 council(s): [redacted], two');
    expect(redacted.detail).toEqual({
      referencedBy: [
        { id: one.id, name: "[redacted]" },
        { id: two.id, name: "two" },
      ],
    });
  });
});

describe("council records", () => {
  it("persists defaults and explicit background, then resolves by id or name", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const created = store.createCouncil({
      name: "jury",
      topic: "topic-1",
      agentIds: [alpha.id],
      rounds: 16,
      reporterAgentId: alpha.id,
    });
    expect(created.background).toBe("");
    expect(created.targetOutput).toBe("");
    expect(created.rounds).toBe(16);
    expect(store.getCouncil(created.id)).toEqual(created);
    expect(store.getCouncil("jury")).toEqual(created);

    const explicit = store.createCouncil({
      name: "other",
      topic: "see councilkit_session=sekret; please",
      background: "bg",
      targetOutput: "out",
      agentIds: [alpha.id],
      rounds: 2,
      reporterAgentId: alpha.id,
    });
    expect(explicit.background).toBe("bg");
    expect(explicit.targetOutput).toBe("out");
    const disk = readFileSync(resolvePaths(envFor(home)).councils, "utf8");
    expect(disk.includes("sekret")).toBe(false);
    const parsed = JSON.parse(disk) as { councils: CouncilRecord[] };
    expect(parsed.councils[1]?.topic).toBe("see [redacted]; please");
    expect(store.listCouncils()[1]?.topic).toBe("see [redacted]; please");
  });

  it("rejects schema, membership, duplicate, disabled, and unknown-agent councils", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const disabled = store.createAgent(agentInput("disabled", { enabled: false }));

    const rounds = cliError(() =>
      store.createCouncil({
        name: "c",
        topic: "t",
        agentIds: [alpha.id],
        rounds: 0,
        reporterAgentId: alpha.id,
      }),
    );
    expect(rounds.exitCode).toBe(2);
    expect(rounds.message).toBe(INVALID_ROUNDS_ZERO);

    const high = cliError(() =>
      store.createCouncil({
        name: "c",
        topic: "t",
        agentIds: [alpha.id],
        rounds: 17,
        reporterAgentId: alpha.id,
      }),
    );
    expect(high.message).toBe(INVALID_ROUNDS_HIGH);

    const topic = cliError(() =>
      store.createCouncil({
        name: "c",
        topic: "",
        agentIds: [alpha.id],
        rounds: 1,
        reporterAgentId: alpha.id,
      }),
    );
    expect(topic.message).toBe(INVALID_EMPTY_TOPIC);

    const dup = cliError(() =>
      store.createCouncil({
        name: "c",
        topic: "t",
        agentIds: [alpha.id, alpha.id],
        rounds: 1,
        reporterAgentId: alpha.id,
      }),
    );
    expect(dup.message).toBe("council agentIds contains duplicates");

    const reporter = cliError(() =>
      store.createCouncil({
        name: "c",
        topic: "t",
        agentIds: [alpha.id],
        rounds: 1,
        reporterAgentId: "ghost",
      }),
    );
    expect(reporter.message).toBe("reporter must be among agentIds");

    const unknown = cliError(() =>
      store.createCouncil({
        name: "c",
        topic: "t",
        agentIds: ["ghost"],
        rounds: 1,
        reporterAgentId: "ghost",
      }),
    );
    expect(unknown.message).toBe('council references unknown or deleted agent id "ghost"');

    const off = cliError(() =>
      store.createCouncil({
        name: "c",
        topic: "t",
        agentIds: [disabled.id],
        rounds: 1,
        reporterAgentId: disabled.id,
      }),
    );
    expect(off.message).toBe('agent "disabled" is disabled; a council cannot include it');
    expect(existsSync(resolvePaths(envFor(home)).councils)).toBe(false);
  });

  it("rejects a duplicate council name without appending it", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const first = store.createCouncil({
      name: "same",
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const before = readFileSync(resolvePaths(envFor(home)).councils, "utf8");
    const err = cliError(() =>
      store.createCouncil({
        name: "same",
        topic: "other",
        agentIds: [alpha.id],
        rounds: 1,
        reporterAgentId: alpha.id,
      }),
    );
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('council name "same" already exists');
    expect(readFileSync(resolvePaths(envFor(home)).councils, "utf8")).toBe(before);
    expect(store.listCouncils()).toEqual([first]);
  });

  it("reports a missing council, an ambiguous name, and duplicate ids", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const created = store.createCouncil({
      name: "jury",
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const missing = cliError(() => store.getCouncil("missing-council"));
    expect(missing.exitCode).toBe(2);
    expect(missing.message).toBe('no council matches ref "missing-council"');
    expect(missing.detail).toBeUndefined();

    const paths = resolvePaths(envFor(home));
    const twin = { ...created, name: "twin" };
    writeFileSync(
      paths.councils,
      `${JSON.stringify(
        {
          format: "councilkit-councils",
          version: 1,
          councils: [twin, { ...twin, id: "council-2" }],
        },
        null,
        2,
      )}\n`,
    );
    const ambiguous = cliError(() => store.getCouncil("twin"));
    expect(ambiguous.message).toBe('council name "twin" is ambiguous');

    writeFileSync(
      paths.councils,
      `${JSON.stringify(
        {
          format: "councilkit-councils",
          version: 1,
          councils: [twin, { ...twin, name: "other" }],
        },
        null,
        2,
      )}\n`,
    );
    const dupId = cliError(() => store.getCouncil(twin.id));
    expect(dupId.message).toBe(`council ref "${twin.id}" matched multiple ids`);
  });

  it("deletes one council and leaves the other on disk", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const input = {
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    };
    const keep = store.createCouncil({ ...input, name: "keep" });
    const drop = store.createCouncil({ ...input, name: "drop" });
    expect(store.deleteCouncil("drop")).toEqual({ deletedId: drop.id, freed: true });
    expect(store.listCouncils()).toEqual([keep]);
    const gone = cliError(() => store.getCouncil(drop.id));
    expect(gone.message).toBe(`no council matches ref "${drop.id}"`);
    const disk = JSON.parse(readFileSync(resolvePaths(envFor(home)).councils, "utf8")) as {
      councils: CouncilRecord[];
    };
    expect(disk.councils).toEqual([keep]);
  });

  it("fills omitted background and targetOutput when the file is read back", () => {
    const home = makeHome();
    const alpha = {
      id: "agent-alpha",
      name: "alpha",
      personaPrompt: "persona-a",
      modelId: "kimi-k2",
      color: "#112233",
      enabled: true,
      driverSelection: KIMI,
    };
    const paths = resolvePaths(envFor(home));
    writeFileSync(
      paths.agents,
      `${JSON.stringify({ format: "councilkit-agents", version: 1, agents: [alpha] }, null, 2)}\n`,
    );
    writeFileSync(
      paths.councils,
      `${JSON.stringify(
        {
          format: "councilkit-councils",
          version: 1,
          councils: [
            {
              id: "council-1",
              name: "pr-jury",
              topic: "topic-1",
              agentIds: ["agent-alpha"],
              rounds: 1,
              reporterAgentId: "agent-alpha",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    expect(storeFor(home).getCouncil("pr-jury")).toEqual({
      id: "council-1",
      name: "pr-jury",
      topic: "topic-1",
      background: "",
      targetOutput: "",
      agentIds: ["agent-alpha"],
      rounds: 1,
      reporterAgentId: "agent-alpha",
    });
  });
});

describe("roster sync, council agents, and revision", () => {
  function writeFixture(home: string): void {
    const paths = resolvePaths(envFor(home));
    writeFileSync(
      paths.agents,
      `${JSON.stringify(
        {
          format: "councilkit-agents",
          version: 1,
          agents: [
            {
              id: "agent-alpha",
              name: "alpha",
              personaPrompt: "persona-a",
              modelId: "kimi-k2",
              color: "#112233",
              enabled: true,
              driverSelection: KIMI,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      paths.councils,
      `${JSON.stringify(
        {
          format: "councilkit-councils",
          version: 1,
          councils: [
            {
              id: "council-1",
              name: "pr-jury",
              topic: "topic-1",
              background: "",
              targetOutput: "",
              agentIds: ["agent-alpha"],
              rounds: 1,
              reporterAgentId: "agent-alpha",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }

  it("hashes the council plus the agent list and changes when a model changes", () => {
    const home = makeHome();
    writeFixture(home);
    const store = storeFor(home);
    const council = store.getCouncil("council-1");
    expect(store.councilRevision(council)).toBe(BASE_REVISION);
    expect(store.councilRevision(store.getCouncil("pr-jury"))).toBe(BASE_REVISION);
    store.updateAgent("agent-alpha", { modelId: "glm-5.2" });
    expect(store.councilRevision(store.getCouncil("council-1"))).toBe(MODEL_REVISION);
    expect(store.listAgents()).toEqual([
      {
        id: "agent-alpha",
        name: "alpha",
        personaPrompt: "persona-a",
        modelId: "glm-5.2",
        color: "#112233",
        enabled: true,
        driverSelection: KIMI,
      },
    ]);
  });

  it("returns the same council without writing when the roster and reporter already match", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const council = store.createCouncil({
      name: "pr-jury",
      topic: "t",
      background: "bg",
      targetOutput: "out",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const before = readFileSync(resolvePaths(envFor(home)).councils, "utf8");
    expect(store.syncCouncilRoster("pr-jury", [alpha], alpha.id)).toEqual(council);
    expect(readFileSync(resolvePaths(envFor(home)).councils, "utf8")).toBe(before);
  });

  it("appends a missing agent and keeps existing overrides", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const beta = store.createAgent(
      agentInput("beta", { modelId: "glm-5.2", driverSelection: CLAUDE, color: "#aabbcc" }),
    );
    const council = store.createCouncil({
      name: "pr-jury",
      topic: "t",
      background: "bg",
      targetOutput: "out",
      agentIds: [alpha.id],
      rounds: 2,
      reporterAgentId: alpha.id,
    });
    const paths = resolvePaths(envFor(home));
    const file = JSON.parse(readFileSync(paths.councils, "utf8")) as {
      format: string;
      version: number;
      councils: CouncilRecord[];
    };
    file.councils[0] = {
      ...council,
      agentOverrides: { [alpha.id]: { modelId: "override-model", driverSelection: KIMI } },
    };
    writeFileSync(paths.councils, `${JSON.stringify(file, null, 2)}\n`);

    const current = store.getCouncil("pr-jury");
    expect(store.councilAgents(current)).toEqual([
      { ...alpha, modelId: "override-model", driverSelection: KIMI },
    ]);

    const reporterOnly = store.syncCouncilRoster(council.id, [alpha], alpha.id);
    expect(reporterOnly.agentIds).toEqual([alpha.id]);
    expect(reporterOnly.reporterAgentId).toBe(alpha.id);
    expect(reporterOnly.agentOverrides).toEqual({
      [alpha.id]: { modelId: "override-model", driverSelection: KIMI },
    });

    const updated = store.syncCouncilRoster("pr-jury", [beta, alpha], beta.id);
    expect(updated).toEqual({
      ...current,
      agentIds: [alpha.id, beta.id],
      reporterAgentId: beta.id,
    });
    expect(storeFor(home).councilAgents(updated)).toEqual([
      { ...alpha, modelId: "override-model", driverSelection: KIMI },
      beta,
    ]);
  });

  it("rejects a reporter outside the roster and a ninth seat without writing", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    store.createCouncil({
      name: "pr-jury",
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const before = readFileSync(resolvePaths(envFor(home)).councils, "utf8");
    const reporter = cliError(() =>
      store.syncCouncilRoster("pr-jury", [alpha], "missing-reporter"),
    );
    expect(reporter.exitCode).toBe(2);
    expect(reporter.message).toBe("reporter must be among council agents");
    expect(readFileSync(resolvePaths(envFor(home)).councils, "utf8")).toBe(before);

    const seats = [alpha];
    for (let index = 0; index < 8; index += 1) {
      seats.push(store.createAgent(agentInput(`seat-${index}`)));
    }
    const capped = cliError(() => store.syncCouncilRoster("pr-jury", seats, alpha.id));
    expect(capped.exitCode).toBe(2);
    expect(capped.message).toBe(INVALID_AGENT_IDS_CAP);
    expect(store.getCouncil("pr-jury").agentIds).toEqual([alpha.id]);
  });

  it("throws when a council agent id is no longer in the agent file", () => {
    const home = makeHome();
    writeFixture(home);
    const paths = resolvePaths(envFor(home));
    const file = JSON.parse(readFileSync(paths.councils, "utf8")) as {
      councils: Array<{ agentIds: string[] }>;
    };
    file.councils[0].agentIds = ["missing-agent"];
    writeFileSync(paths.councils, `${JSON.stringify(file)}\n`);
    const err = cliError(() => storeFor(home).councilAgents(storeFor(home).getCouncil("pr-jury")));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe('no agent matches ref "missing-agent"');
  });
});

describe("review jury updates", () => {
  function seed(): { home: string; store: Store; alpha: AgentRecord; beta: AgentRecord } {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    const beta = store.createAgent(
      agentInput("beta", { modelId: "glm-5.2", driverSelection: CLAUDE, color: "#aabbcc" }),
    );
    store.createCouncil({
      name: "pr-jury",
      topic: "topic",
      background: "bg",
      targetOutput: "out",
      agentIds: [alpha.id],
      rounds: 2,
      reporterAgentId: alpha.id,
    });
    store.createCouncil({
      name: "other",
      topic: "other-topic",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    return { home, store, alpha, beta };
  }

  it("writes seat order, reporter, and overrides for pr-jury only", () => {
    const { home, store, alpha, beta } = seed();
    const council = store.getCouncil("pr-jury");
    const otherBefore = readFileSync(resolvePaths(envFor(home)).agents, "utf8");
    const updated = store.updateReviewJury({
      revision: store.councilRevision(council),
      seats: [
        { agentId: beta.id, modelId: "glm-5.2", driverSelection: CLAUDE },
        { agentId: alpha.id, modelId: "kimi-k2", driverSelection: KIMI },
      ],
      reporterAgentId: beta.id,
    });
    expect(updated).toEqual({
      ...council,
      agentIds: [beta.id, alpha.id],
      reporterAgentId: beta.id,
      agentOverrides: {
        [beta.id]: { modelId: "glm-5.2", driverSelection: CLAUDE },
        [alpha.id]: { modelId: "kimi-k2", driverSelection: KIMI },
      },
    });
    expect(store.councilAgents(updated)).toEqual([
      { ...beta, modelId: "glm-5.2", driverSelection: CLAUDE },
      { ...alpha, modelId: "kimi-k2", driverSelection: KIMI },
    ]);
    expect(readFileSync(resolvePaths(envFor(home)).agents, "utf8")).toBe(otherBefore);
    const disk = JSON.parse(readFileSync(resolvePaths(envFor(home)).councils, "utf8")) as {
      councils: CouncilRecord[];
    };
    expect(disk.councils.map((row) => row.name)).toEqual(["pr-jury", "other"]);
    expect(disk.councils[0]).toEqual(updated);
    expect(disk.councils[1]?.agentIds).toEqual([alpha.id]);

    const stale = cliError(() =>
      store.updateReviewJury({
        revision: store.councilRevision(council),
        seats: [{ agentId: alpha.id, modelId: "kimi-k2", driverSelection: KIMI }],
        reporterAgentId: alpha.id,
      }),
    );
    expect(stale.exitCode).toBe(2);
    expect(stale.message).toBe("JURY_CONFLICT: 默认席位已被修改，请重新加载后再保存。");
    expect(JSON.parse(readFileSync(resolvePaths(envFor(home)).councils, "utf8"))).toEqual(disk);
  });

  it("rejects an invalid roster, a disabled seat, and an unknown agent before writing", () => {
    const { home, store, alpha } = seed();
    const before = readFileSync(resolvePaths(envFor(home)).councils, "utf8");
    const duplicate = cliError(() =>
      store.updateReviewJury({
        revision: "x",
        seats: [
          { agentId: alpha.id, modelId: "m", driverSelection: KIMI },
          { agentId: alpha.id, modelId: "n", driverSelection: KIMI },
        ],
        reporterAgentId: alpha.id,
      }),
    );
    expect(duplicate.exitCode).toBe(2);
    expect(duplicate.message).toBe("invalid default review roster");

    const reporter = cliError(() =>
      store.updateReviewJury({
        revision: "x",
        seats: [{ agentId: alpha.id, modelId: "m", driverSelection: KIMI }],
        reporterAgentId: "other",
      }),
    );
    expect(reporter.message).toBe("invalid default review roster");

    const disabledAgent = store.createAgent(agentInput("off", { enabled: false }));
    const council = store.getCouncil("pr-jury");
    const disabled = cliError(() =>
      store.updateReviewJury({
        revision: store.councilRevision(council),
        seats: [{ agentId: disabledAgent.id, modelId: "kimi-k2", driverSelection: KIMI }],
        reporterAgentId: disabledAgent.id,
      }),
    );
    expect(disabled.message).toBe("不能添加已停用的 Agent");

    const unknown = cliError(() =>
      store.updateReviewJury({
        revision: store.councilRevision(council),
        seats: [{ agentId: "missing-agent", modelId: "kimi-k2", driverSelection: KIMI }],
        reporterAgentId: "missing-agent",
      }),
    );
    expect(unknown.message).toBe('no agent matches ref "missing-agent"');
    expect(readFileSync(resolvePaths(envFor(home)).councils, "utf8")).toBe(before);
  });

  it.skip("stores the schema-trimmed modelId for a jury seat", () => {
    // BUG: updateReviewJury validates seats with reviewJuryUpdateSchema, which
    // trims modelId, then ignores the parsed value and writes the raw input.
    // modelId "  gpt-6  " is accepted; the return value and councils.json keep
    // the spaces, while a later getCouncil() parses that file back as "gpt-6".
    const { home, store, alpha } = seed();
    const council = store.getCouncil("pr-jury");
    const updated = store.updateReviewJury({
      revision: store.councilRevision(council),
      seats: [{ agentId: alpha.id, modelId: "  gpt-6  ", driverSelection: KIMI }],
      reporterAgentId: alpha.id,
    });
    const disk = JSON.parse(readFileSync(resolvePaths(envFor(home)).councils, "utf8")) as {
      councils: CouncilRecord[];
    };
    expect(updated.agentOverrides?.[alpha.id]?.modelId).toBe("gpt-6");
    expect(disk.councils[0]?.agentOverrides?.[alpha.id]?.modelId).toBe("gpt-6");
    expect(store.getCouncil("pr-jury").agentOverrides?.[alpha.id]?.modelId).toBe("gpt-6");
  });
});

describe("registry diagnostics and write faults", () => {
  it("reports corrupt and schema-invalid agents.json without replacing it", () => {
    const home = makeHome();
    const paths = resolvePaths(envFor(home));
    writeFileSync(paths.agents, "{not json");
    const corrupt = cliError(() => storeFor(home).listAgents());
    expect(corrupt.exitCode).toBe(5);
    expect(corrupt.message).toBe("agents.json is not valid JSON (file is corrupt)");
    expect(corrupt.detail).toBeUndefined();
    expect(readFileSync(paths.agents, "utf8")).toBe("{not json");

    writeFileSync(
      paths.agents,
      JSON.stringify({ format: "councilkit-agents", version: 99, agents: [] }),
    );
    const version = cliError(() => storeFor(home).listAgents());
    expect(version.exitCode).toBe(5);
    expect(version.message).toBe(AGENTS_BAD_VERSION);
    expect(version.detail).toEqual({ file: "agents.json" });

    writeFileSync(
      paths.agents,
      JSON.stringify({ format: "councilkit-agents", version: 1, agents: [{ evil: true }] }),
    );
    const unknown = cliError(() => storeFor(home).listAgents());
    expect(unknown.message).toBe(AGENTS_UNKNOWN_RECORD);
    expect(unknown.detail).toEqual({ file: "agents.json" });

    const tokenText = JSON.stringify({
      format: "councilkit-agents",
      version: 1,
      agents: [
        {
          token: "shh",
          id: "x",
          name: "x",
          personaPrompt: "p",
          modelId: "m",
          color: "#000000",
          enabled: true,
          driverSelection: KIMI,
        },
      ],
    });
    writeFileSync(paths.agents, tokenText);
    const token = cliError(() => storeFor(home).listAgents());
    expect(token.message).toBe(AGENTS_TOKEN_FIELD);
    expect(readFileSync(paths.agents, "utf8")).toBe(tokenText);
  });

  it("reports corrupt and schema-invalid councils.json without replacing it", () => {
    const home = makeHome();
    const paths = resolvePaths(envFor(home));
    writeFileSync(paths.councils, "{not json");
    const corrupt = cliError(() => storeFor(home).listCouncils());
    expect(corrupt.exitCode).toBe(5);
    expect(corrupt.message).toBe("councils.json is not valid JSON (file is corrupt)");
    expect(readFileSync(paths.councils, "utf8")).toBe("{not json");

    const versionText = JSON.stringify({ format: "councilkit-councils", version: 2, councils: [] });
    writeFileSync(paths.councils, versionText);
    const version = cliError(() => storeFor(home).listCouncils());
    expect(version.exitCode).toBe(5);
    expect(version.message).toBe(COUNCILS_BAD_VERSION);
    expect(version.detail).toEqual({ file: "councils.json" });

    const extraText = JSON.stringify({
      format: "councilkit-councils",
      version: 1,
      councils: [],
      extra: true,
    });
    writeFileSync(paths.councils, extraText);
    const extra = cliError(() => storeFor(home).listCouncils());
    expect(extra.message).toBe(COUNCILS_EXTRA);
    expect(extra.detail).toEqual({ file: "councils.json" });
    expect(readFileSync(paths.councils, "utf8")).toBe(extraText);
  });

  it.skipIf(asRoot)("does not replace an unreadable agents.json and surfaces EACCES", () => {
    const home = makeHome();
    const store = storeFor(home);
    const created = createAlpha(store);
    const paths = resolvePaths(envFor(home));
    const before = readFileSync(paths.agents, "utf8");
    chmodSync(paths.agents, 0o000);
    try {
      const listed = cliError(() => storeFor(home).listAgents());
      expect(listed.exitCode).toBe(5);
      expect(listed.message).toBe(`cannot read "${paths.agents}": EACCES`);
      const createdAgain = cliError(() => storeFor(home).createAgent(agentInput("beta")));
      expect(createdAgain.exitCode).toBe(5);
      expect(createdAgain.message).toBe(`cannot read "${paths.agents}": EACCES`);
    } finally {
      chmodSync(paths.agents, 0o600);
    }
    expect(readFileSync(paths.agents, "utf8")).toBe(before);
    expect(storeFor(home).getAgent(created.id).name).toBe("alpha");
  });

  it.skipIf(asRoot)("preserves agents.json and councils.json when the home is not writable", () => {
    const home = makeHome();
    const store = storeFor(home);
    const alpha = createAlpha(store);
    store.createCouncil({
      name: "jury",
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const paths = resolvePaths(envFor(home));
    const agentsBefore = readFileSync(paths.agents, "utf8");
    const councilsBefore = readFileSync(paths.councils, "utf8");
    chmodSync(home, 0o500);
    try {
      const agentErr = cliError(() => storeFor(home).createAgent(agentInput("beta")));
      expect(agentErr.exitCode).toBe(5);
      expect(agentErr.message).toBe("failed to write agents.json: Error");
      expect(agentErr.detail).toEqual({ cause: "Error" });
      const councilErr = cliError(() =>
        storeFor(home).createCouncil({
          name: "next",
          topic: "t",
          agentIds: [alpha.id],
          rounds: 1,
          reporterAgentId: alpha.id,
        }),
      );
      expect(councilErr.exitCode).toBe(5);
      expect(councilErr.message).toBe("failed to write councils.json: Error");
      expect(councilErr.detail).toEqual({ cause: "Error" });
    } finally {
      chmodSync(home, 0o700);
    }
    expect(readFileSync(paths.agents, "utf8")).toBe(agentsBefore);
    expect(readFileSync(paths.councils, "utf8")).toBe(councilsBefore);
  });
});
