/**
 * Store unit tests (plan-a §10 AC1, store bucket). Covers: cold init, CRUD
 * across fresh Store instances, strict-schema rejection of unknown/secret/bad-
 * version records, corrupt-JSON diagnostics, reporter-required / dangling-ref
 * / disabled-agent validation, agent-delete reference protection, and the atomic
 * write fault preserving the previous file.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, EXIT } from "../src/errors";
import { resolvePaths } from "../src/store/paths";
import { Store } from "../src/store/store";

const KIMI = { driverId: "kimi-stream-json" as const, options: {} };
const CLAUDE_CFUSE = {
  driverId: "claude-stream-json" as const,
  options: { route: "cfuse" as const },
};

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "councilkit-store-"));
}

function env(home: string): NodeJS.ProcessEnv {
  return { ...process.env, COUNCILKIT_HOME: home };
}

function makeStore(home: string): Store {
  return new Store({ env: env(home) });
}

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected an error to be thrown");
}

describe("cli store", () => {
  let home: string;

  beforeEach(() => {
    home = newHome();
  });
  afterEach(() => {
    try {
      chmodSync(home, 0o700);
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures on some sandboxed FS
    }
  });

  it("cold-inits to empty agents and councils", () => {
    const store = makeStore(home);
    expect(store.listAgents()).toEqual([]);
    expect(store.listCouncils()).toEqual([]);
  });

  it("persists agents/councils across fresh Store instances", () => {
    const a = makeStore(home).createAgent({
      name: "alpha",
      personaPrompt: "a persona",
      modelId: "kimi-k2",
      color: "#112233",
      driverSelection: KIMI,
    });
    const b = makeStore(home).createAgent({
      name: "beta",
      personaPrompt: "b persona",
      modelId: "glm-5.2",
      color: "#aabbcc",
      driverSelection: CLAUDE_CFUSE,
      enabled: false,
    });

    const fresh = makeStore(home);
    const agents = fresh.listAgents();
    expect(agents.map((x) => x.name).sort()).toEqual(["alpha", "beta"]);
    const gotB = fresh.getAgent("beta");
    expect(gotB.id).toBe(b.id);
    expect(gotB.enabled).toBe(false);

    // Resolve by id and by name.
    expect(fresh.getAgent(a.id).name).toBe("alpha");
    expect(() => fresh.getAgent("nope")).toThrowError(CliError);
  });

  it("rejects duplicate agent names", () => {
    const store = makeStore(home);
    store.createAgent({
      name: "dup",
      personaPrompt: "p",
      modelId: "m",
      color: "#000000",
      driverSelection: KIMI,
    });
    expect(() =>
      store.createAgent({
        name: "dup",
        personaPrompt: "p",
        modelId: "m",
        color: "#000000",
        driverSelection: KIMI,
      }),
    ).toThrowError(/already exists/);
  });

  it("strict schema rejects unknown, secret and bad-version records", () => {
    const paths = resolvePaths(env(home));
    // Unknown field.
    writeFileSync(
      paths.agents,
      JSON.stringify({ format: "councilkit-agents", version: 1, agents: [{ evil: true }] }),
    );
    expect(() => makeStore(home).listAgents()).toThrowError(CliError);
    // Secret-shaped unknown field.
    writeFileSync(
      paths.agents,
      JSON.stringify({
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
      }),
    );
    expect(() => makeStore(home).listAgents()).toThrowError(CliError);
    // Unsupported version.
    writeFileSync(
      paths.agents,
      JSON.stringify({ format: "councilkit-agents", version: 99, agents: [] }),
    );
    expect(() => makeStore(home).listAgents()).toThrowError(CliError);
  });

  it("reports corrupt JSON as a diagnostic IO error", () => {
    const paths = resolvePaths(env(home));
    writeFileSync(paths.agents, "{not json");
    const err = captureError(() => makeStore(home).listAgents());
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.io);
    expect(err.message).toMatch(/corrupt/);
  });

  it("reports an unreadable agents.json as an IO error, not an empty list (F4)", () => {
    const store = makeStore(home);
    store.createAgent({
      name: "a",
      personaPrompt: "p",
      modelId: "m",
      color: "#000001",
      driverSelection: KIMI,
    });
    const paths = resolvePaths(env(home));
    chmodSync(paths.agents, 0o000);
    try {
      // A present-but-unreadable file must surface as a diagnostic IO error,
      // NOT a silent empty array that the next create would overwrite.
      const err = captureError(() => makeStore(home).listAgents());
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(EXIT.io);
    } finally {
      chmodSync(paths.agents, 0o600);
    }
  });

  it("does not overwrite an unreadable agents.json on a later create (F4)", () => {
    const store = makeStore(home);
    store.createAgent({
      name: "a",
      personaPrompt: "p",
      modelId: "m",
      color: "#000001",
      driverSelection: KIMI,
    });
    const paths = resolvePaths(env(home));
    const before = readFileSync(paths.agents, "utf8");
    chmodSync(paths.agents, 0o000);
    try {
      const err = captureError(() =>
        makeStore(home).createAgent({
          name: "b",
          personaPrompt: "p",
          modelId: "m",
          color: "#000002",
          driverSelection: KIMI,
        }),
      );
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(EXIT.io);
    } finally {
      chmodSync(paths.agents, 0o600);
    }
    // The unreadable file was NOT silently replaced with a single-agent file.
    const after = readFileSync(paths.agents, "utf8");
    expect(after).toBe(before);
    // Survivor still resolvable.
    expect(makeStore(home).getAgent("a").name).toBe("a");
  });

  it("requires the reporter and validates membership/enabled/existence", () => {
    const store = makeStore(home);
    const a = store.createAgent({
      name: "a",
      personaPrompt: "p",
      modelId: "m",
      color: "#000001",
      driverSelection: KIMI,
    });
    const disabled = store.createAgent({
      name: "dis",
      personaPrompt: "p",
      modelId: "m",
      color: "#000002",
      driverSelection: KIMI,
      enabled: false,
    });

    // Reporter not among agentIds.
    expect(() =>
      store.createCouncil({
        name: "c",
        topic: "t",
        agentIds: [a.id],
        rounds: 1,
        reporterAgentId: "ghost",
      }),
    ).toThrowError(/reporter must be among agentIds/);

    // Reporter is a member but references a non-existent agent (dangling ref).
    expect(() =>
      store.createCouncil({
        name: "c-dangling",
        topic: "t",
        agentIds: ["ghost"],
        rounds: 1,
        reporterAgentId: "ghost",
      }),
    ).toThrowError(/unknown or deleted agent/);

    // Reporter missing entirely.
    expect(() =>
      store.createCouncil({
        name: "c2",
        topic: "t",
        agentIds: [a.id],
        rounds: 1,
        reporterAgentId: "" as string,
      }),
    ).toThrowError(CliError);

    // Disabled agent cannot be in a council.
    expect(() =>
      store.createCouncil({
        name: "c3",
        topic: "t",
        agentIds: [disabled.id],
        rounds: 1,
        reporterAgentId: disabled.id,
      }),
    ).toThrowError(/disabled/);

    // Valid council: reporter is a member.
    const council = store.createCouncil({
      name: "ok",
      topic: "t",
      agentIds: [a.id],
      rounds: 2,
      reporterAgentId: a.id,
    });
    expect(council.reporterAgentId).toBe(a.id);

    // Duplicate agentIds rejected.
    expect(() =>
      store.createCouncil({
        name: "dup",
        topic: "t",
        agentIds: [a.id, a.id],
        rounds: 1,
        reporterAgentId: a.id,
      }),
    ).toThrowError(/duplicates/);
  });

  it("protects agents referenced by a council (no dangling refs)", () => {
    const store = makeStore(home);
    const a = store.createAgent({
      name: "a",
      personaPrompt: "p",
      modelId: "m",
      color: "#000001",
      driverSelection: KIMI,
    });
    store.createCouncil({
      name: "ok",
      topic: "t",
      agentIds: [a.id],
      rounds: 1,
      reporterAgentId: a.id,
    });

    const err = captureError(() => store.deleteAgent(a.id));
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.usage);
    expect(err.message).toMatch(/referenced/);
    // The agent and council are intact.
    expect(makeStore(home).getAgent(a.id).name).toBe("a");
  });

  it("atomic write fault preserves the previous file", () => {
    const store = makeStore(home);
    const a = store.createAgent({
      name: "survivor",
      personaPrompt: "p",
      modelId: "m",
      color: "#000001",
      driverSelection: KIMI,
    });
    const paths = resolvePaths(env(home));
    const before = readFileSync(paths.agents, "utf8");

    // Make the home dir read-only (no write/exec for others); atomic write opens
    // a same-dir tmp file, which must fail — leaving the prior file intact.
    chmodSync(home, 0o500);
    const err = captureError(() =>
      makeStore(home).createAgent({
        name: "new",
        personaPrompt: "p",
        modelId: "m",
        color: "#000002",
        driverSelection: KIMI,
      }),
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.io);

    const after = readFileSync(paths.agents, "utf8");
    expect(after).toBe(before);
    // Survivor is still resolvable.
    chmodSync(home, 0o700);
    expect(makeStore(home).getAgent(a.id).name).toBe("survivor");
  });
});
