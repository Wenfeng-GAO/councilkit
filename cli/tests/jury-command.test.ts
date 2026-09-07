import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedCodexModels, configuredCodexModel, readJury, readReviewJury, runJury } from "../src/commands/jury";
import type { OutputSink } from "../src/output";
import { resolvePaths } from "../src/store/paths";
import { Store } from "../src/store/store";

let home: string;
const oldHome = process.env.COUNCILKIT_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-jury-"));
  process.env.COUNCILKIT_HOME = home;
});
afterEach(() => {
  if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});
function seed() {
  const store = new Store();
  const agent = store.createAgent({
    name: "review-security",
    personaPrompt: "Keep this persona",
    modelId: "old-model",
    driverSelection: { driverId: "codex-app-server", options: {} },
    color: "#123456",
  });
  const other = store.createAgent({
    name: "review-correctness",
    personaPrompt: "Check correctness",
    modelId: "second-model",
    driverSelection: { driverId: "codex-app-server", options: {} },
    color: "#abcdef",
  });
  for (const name of ["pr-jury", "other-council"])
    store.createCouncil({
      name,
      topic: "review",
      agentIds: [agent.id, other.id],
      reporterAgentId: agent.id,
      rounds: 1,
    });
  return { store, agent, other };
}
describe("default jury configuration", () => {
  it("persists models and aggregator atomically in the council without changing shared agents", async () => {
    const { store, agent, other } = seed();
    const initial = readReviewJury(store);
    const beforeAgents = readFileSync(resolvePaths().agents, "utf8");
    let output: unknown;
    const sink: OutputSink = {
      json: true,
      progress() {},
      diag() {},
      async finish(value) {
        output = value;
      },
    };
    const config = {
      revision: initial.revision,
      seats: initial.seats.map((seat) => ({ ...seat, modelId: "gpt-6-astra" })),
      reporterAgentId: other.id,
    };
    await runJury(["save", "--config", JSON.stringify(config)], sink);
    const updated = readReviewJury(new Store());
    expect(output).toEqual(updated);
    expect(updated.reporterAgentId).toBe(other.id);
    expect(updated.seats.every((seat) => seat.modelId === "gpt-6-astra")).toBe(true);
    expect(readFileSync(resolvePaths().agents, "utf8")).toBe(beforeAgents);
    expect(store.councilAgents(store.getCouncil("other-council"))[0]?.modelId).toBe("old-model");
    expect(store.councilAgents(store.getCouncil("pr-jury"))[0]?.personaPrompt).toBe(
      agent.personaPrompt,
    );
    await expect(runJury(["save", "--config", JSON.stringify(config)], sink)).rejects.toThrow(
      "JURY_CONFLICT",
    );
  });
  it("removes membership without deleting the underlying agent and requires a participating reporter", () => {
    const { store, agent, other } = seed();
    const initial = readReviewJury(store);
    expect(() =>
      store.updateReviewJury({
        revision: initial.revision,
        seats: [initial.seats[1]],
        reporterAgentId: agent.id,
      }),
    ).toThrow();
    store.updateReviewJury({
      revision: initial.revision,
      seats: [initial.seats[1]],
      reporterAgentId: other.id,
    });
    expect(store.getCouncil("pr-jury").agentIds).toEqual([other.id]);
    expect(store.getAgent(agent.id).name).toBe("review-security");
  });
  it("reads visible Codex model IDs without leaking cache prompts or hidden models", () => {
    writeFileSync(
      join(home, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-6-astra", visibility: "list", model_messages: "do not expose" },
          { slug: "hidden", visibility: "hide" },
          { slug: "--bad", visibility: "list" },
        ],
      }),
    );
    expect(cachedCodexModels({ CODEX_HOME: home })).toEqual(["gpt-6-astra"]);
  });

  it("shows product-jury without writing it", async () => {
    const store = new Store();
    const product = store.createAgent({
      name: "ideate-product",
      personaPrompt: "Product",
      modelId: "grok-4.6",
      driverSelection: { driverId: "grok-stream-json", options: {} },
      color: "#38bdf8",
    });
    const engineering = store.createAgent({
      name: "ideate-engineering",
      personaPrompt: "Engineering",
      modelId: "kimi-code/k3",
      driverSelection: { driverId: "kimi-stream-json", options: {} },
      color: "#4ade80",
    });
    store.createCouncil({
      name: "product-jury",
      topic: "ideate",
      agentIds: [product.id, engineering.id],
      reporterAgentId: engineering.id,
      rounds: 1,
    });
    let output: unknown;
    const sink: OutputSink = {
      json: true,
      progress() {},
      diag() {},
      async finish(value) {
        output = value;
      },
    };
    await runJury(["show", "--council", "product-jury"], sink);
    expect(output).toMatchObject({
      reporterAgentId: engineering.id,
      seats: [{ agentId: product.id }, { agentId: engineering.id }],
    });
    expect(readJury("product-jury").reporterAgentId).toBe(engineering.id);
    await expect(runJury(["save", "--council", "product-jury"], sink)).rejects.toThrow(
      "jury save only updates pr-jury",
    );
  });

  it("reads the top-level Codex model before the first table", () => {
    writeFileSync(
      join(home, "config.toml"),
      ['model = "gpt-6-astra"', "", "[profiles.default]", 'model = "ignore-me"', ""].join("\n"),
    );
    expect(configuredCodexModel({ CODEX_HOME: home })).toBe("gpt-6-astra");
  });
});
