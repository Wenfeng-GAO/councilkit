import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewJuryRoutes, runJuryCli } from "@host/routes/review-jury";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Store } from "../../cli/src/store/store";
let home: string;
const previous = process.env.COUNCILKIT_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-host-jury-"));
  process.env.COUNCILKIT_HOME = home;
});
afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});
it("the Host CLI bridge reads, saves and detects conflicting revisions without running agents", async () => {
  const store = new Store();
  const agent = store.createAgent({
    name: "review-security",
    personaPrompt: "Review",
    modelId: "old",
    color: "#123456",
    driverSelection: { driverId: "codex-app-server", options: {} },
  });
  store.createCouncil({
    name: "pr-jury",
    topic: "Review",
    rounds: 1,
    agentIds: [agent.id],
    reporterAgentId: agent.id,
  });
  const data = await runJuryCli();
  const config = {
    revision: data.revision,
    seats: data.seats.map((seat) => ({ ...seat, modelId: "gpt-6-astra" })),
    reporterAgentId: agent.id,
  };
  expect((await runJuryCli(config)).seats[0]?.modelId).toBe("gpt-6-astra");
  await expect(runJuryCli(config)).rejects.toMatchObject({ status: 409 });
}, 20_000);
it("registers authenticated reads and CSRF-protected writes with a strict request schema", () => {
  const routes = reviewJuryRoutes();
  expect(routes.map((route) => [route.method, route.auth])).toEqual([
    ["GET", "session"],
    ["POST", "mutation"],
  ]);
  expect(
    routes[1]?.bodySchema?.safeParse({ revision: "x", seats: [], reporterAgentId: "a", env: {} })
      .success,
  ).toBe(false);
});
