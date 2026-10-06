import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
it("surfaces a corrupt councils.json instead of telling the operator to init", async () => {
  writeFileSync(join(home, "councils.json"), "{not json\n");
  await expect(runJuryCli()).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining("councils.json is not valid JSON"),
  });
}, 20_000);

it("still tells the operator to init when pr-jury is absent", async () => {
  await expect(runJuryCli()).rejects.toMatchObject({
    status: 400,
    message: "无法读取或保存默认席位。请检查 CLI 配置；尚未初始化时先运行 councilkit init。",
  });
}, 20_000);

it("keeps a disabled-seat save error instead of telling the operator to init", async () => {
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
  const agentsPath = join(home, "agents.json");
  const agents = JSON.parse(readFileSync(agentsPath, "utf8")) as {
    agents: Array<{ enabled: boolean }>;
  };
  const seat = agents.agents[0];
  if (!seat) throw new Error("expected a seeded agent");
  seat.enabled = false;
  writeFileSync(agentsPath, `${JSON.stringify(agents)}\n`);
  const data = await runJuryCli();
  await expect(
    runJuryCli({
      revision: data.revision,
      seats: data.seats,
      reporterAgentId: data.reporterAgentId,
    }),
  ).rejects.toMatchObject({
    status: 400,
    message: "不能添加已停用的 Agent",
  });
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

it("clips a long schema error on a whole emoji", async () => {
  const key = `${"k".repeat(400)}😀z`;
  writeFileSync(
    join(home, "councils.json"),
    `${JSON.stringify({
      format: "councilkit-councils",
      version: 1,
      councils: [],
      [key]: true,
    })}\n`,
  );
  const prefix =
    'councils.json failed schema validation: [{"path":[],"code":"unrecognized_keys","message":"Unrecognized key: \\"';
  await expect(runJuryCli()).rejects.toMatchObject({
    status: 400,
    message: `${prefix}${"k".repeat(400)}…`,
  });
}, 20_000);
