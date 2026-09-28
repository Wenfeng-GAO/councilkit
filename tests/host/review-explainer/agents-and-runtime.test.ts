import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExplanationAgentIdentity,
  ExplanationAgents,
  ExplanationResult,
} from "@shared/runtime/review-explainer/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnInput, SpawnOutput } from "../../../cli/src/auto/runner";
import { Store } from "../../../cli/src/store/store";
import { FINDING, ROUTES, RUN_ID } from "../../review-explainer/contract";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";
import { type ExplainerHttpHost, createExplainerHttpHost } from "./http-helpers";

const payload = {
  kind: "text",
  title: "连续写入失败后会话无法恢复",
  assertion: "冻结证据中的完整断言",
  evidence: ["原评审证据"],
  inference: [],
};
const emptyOutput: SpawnOutput = { stdout: "", exitCode: 0, timedOut: false, aborted: false };
let home: string;
let host: ExplainerHttpHost | undefined;
let store: Store;
let runDir: string;
const originalEnv = {
  PATH: process.env.PATH,
  COUNCILKIT_HOME: process.env.COUNCILKIT_HOME,
  GROK_HOME: process.env.GROK_HOME,
};
const inputs: SpawnInput[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-explainer-runtime-"));
  process.env.COUNCILKIT_HOME = home;
  process.env.GROK_HOME = home; // Never copy real credentials in deterministic tests.
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const name of ["grok", "codex"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
  runDir = seedReviewRun(home).runDir;
  store = new Store();
  inputs.length = 0;
});
afterEach(async () => {
  await host?.close();
  host = undefined;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function agent(name: string, enabled = true) {
  return store.createAgent({
    name,
    enabled,
    personaPrompt: "explain",
    modelId: "fixture-model",
    color: "#abcdef",
    driverSelection: { driverId: "grok-stream-json", options: {} },
  });
}
function defaultReporter(id: string) {
  store.createCouncil({
    name: "pr-jury",
    topic: "review",
    reporterAgentId: id,
    agentIds: [id],
    rounds: 1,
  });
}
async function boot(
  spawn = async (input: SpawnInput): Promise<SpawnOutput> => {
    inputs.push(input);
    return {
      ...emptyOutput,
      stdout: JSON.stringify(
        input.driverId === "codex-app-server"
          ? {
              type: "item.completed",
              item: { type: "agent_message", text: JSON.stringify(payload) },
            }
          : { type: "result", result: JSON.stringify(payload) },
      ),
    };
  },
  extraServices: Record<string, unknown> = {},
) {
  host = await createExplainerHttpHost({
    home,
    extraServices: { reviewExplainerSpawnImpl: spawn, ...extraServices },
  });
  return host;
}
async function explanation(
  agentId?: string,
  generate = true,
  expectedAgent?: ExplanationAgentIdentity,
) {
  if (!host) throw new Error("host not started");
  const query = new URLSearchParams();
  if (!generate) {
    if (agentId) query.set("agentId", agentId);
    if (expectedAgent) {
      query.set("expectedModelId", expectedAgent.modelId);
      query.set("expectedDriverId", expectedAgent.driverId);
    }
  }
  return fetch(
    `${host.baseUrl}${ROUTES.explanation(RUN_ID, FINDING.busy)}${query.size ? `?${query}` : ""}`,
    {
      headers: host.headers(),
      ...(generate ? { method: "POST", body: JSON.stringify({ agentId, expectedAgent }) } : {}),
    },
  );
}
function artifacts(directory: string) {
  const path = join(runDir, "review-explainer", directory);
  return existsSync(path)
    ? readdirSync(path).map((name) => JSON.parse(readFileSync(join(path, name), "utf8")))
    : [];
}
function expectCleaned(input: SpawnInput) {
  expect(existsSync(input.cwd)).toBe(false);
  expect(input.envOverlay?.GROK_HOME).toBeTypeOf("string");
  expect(existsSync(input.envOverlay?.GROK_HOME as string)).toBe(false);
}

describe("explanation Agent selection and actual spawn boundary", () => {
  it("shows current Reporter, disabled alternatives, and authenticated local availability", async () => {
    const current = agent("current-reporter");
    const disabled = agent("disabled", false);
    const alternative = agent("available-alternative");
    defaultReporter(current.id);
    const http = await boot();
    const url = `${http.baseUrl}/api/v1/cli-runs/${RUN_ID}/review-explainer/explanation-agents`;
    expect((await fetch(url)).status).toBe(401);
    const { data } = (await (await fetch(url, { headers: http.headers() })).json()) as {
      data: ExplanationAgents;
    };
    expect(data).toMatchObject({ defaultAgentId: current.id, defaultSource: "pr-jury-reporter" });
    expect(data.agents.find((row) => row.id === current.id)).toMatchObject({
      modelId: "fixture-model",
      driverId: "grok-stream-json",
      available: true,
    });
    expect(data.agents.find((row) => row.id === disabled.id)).toMatchObject({
      available: false,
      reason: "此 Agent 已禁用",
    });
    expect(inputs).toHaveLength(0);
    expect((await explanation(disabled.id)).status).toBe(503);
    expect((await explanation("unknown")).status).toBe(503);
    expect(inputs).toHaveLength(0);
    const agentsPath = join(home, "agents.json");
    const stored = JSON.parse(readFileSync(agentsPath, "utf8"));
    stored.agents.find((row: { id: string }) => row.id === current.id).enabled = false;
    writeFileSync(agentsPath, JSON.stringify(stored));
    const changed = (await (await fetch(url, { headers: http.headers() })).json()) as {
      data: ExplanationAgents;
    };
    expect(changed.data.defaultAgentId).toBe(current.id);
    expect(changed.data.notice).toContain("请选择");
    expect((await explanation()).status).toBe(503);
    expect(inputs).toHaveLength(0);
    expect((await explanation(alternative.id)).status).toBe(200);
  });

  it("does not replace a missing frozen Aggregator with another available Agent", async () => {
    const selectable = agent("selectable");
    const http = await boot();
    const { data } = (await (
      await fetch(`${http.baseUrl}/api/v1/cli-runs/${RUN_ID}/review-explainer/explanation-agents`, {
        headers: http.headers(),
      })
    ).json()) as { data: ExplanationAgents };
    expect(data).toMatchObject({ defaultAgentId: "a", defaultSource: "run-aggregator" });
    expect(data.notice).toContain("请选择");
    expect((await explanation()).status).toBe(503);
    expect(inputs).toHaveLength(0);
    expect((await explanation(selectable.id)).status).toBe(200);
    expectCleaned(inputs[0] as SpawnInput);
  });

  it("keys cached output by chosen Agent and driver options and stamps truthful provenance", async () => {
    const first = agent("first");
    const second = agent("second");
    defaultReporter(first.id);
    await boot();
    const generated = (await (await explanation()).json()) as { data: ExplanationResult };
    expect(generated.data.provenance).toMatchObject({ agentId: first.id, agentName: first.name });
    expect(generated.data.payload.title).toBe(payload.title);
    expect((await explanation(second.id, false)).status).toBe(404);
    const alternate = (await (await explanation(second.id)).json()) as { data: ExplanationResult };
    expect(alternate.data.provenance.agentId).toBe(second.id);
    expect(alternate.data.provenance.cacheKey).not.toBe(generated.data.provenance.cacheKey);
    const cached = (await (await explanation(first.id, false)).json()) as {
      data: ExplanationResult;
    };
    expect(cached.data.cached).toBe(true);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expectCleaned(input);
    const optionAgent = store.createAgent({
      name: "option-agent",
      personaPrompt: "explain",
      modelId: "fixture-model",
      color: "#abcdef",
      driverSelection: { driverId: "codex-app-server", options: { reasoningEffort: "low" } },
    });
    expect((await explanation(optionAgent.id)).status).toBe(200);
    store.updateAgent(optionAgent.id, {
      driverSelection: { driverId: "codex-app-server", options: { reasoningEffort: "high" } },
    });
    expect((await explanation(optionAgent.id, false)).status).toBe(404);
    expect((await explanation(optionAgent.id)).status).toBe(200);
    expect(inputs).toHaveLength(4);
  });

  it("records only the narrow normalization in execution metadata while retaining raw output", async () => {
    defaultReporter(agent("reporter").id);
    const rawOutput = `${JSON.stringify(payload)}\n}`;
    await boot(async (input) => {
      inputs.push(input);
      return { ...emptyOutput, stdout: JSON.stringify({ type: "result", result: rawOutput }) };
    });
    const response = await explanation();
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: ExplanationResult };
    expect(data.payload).toEqual(payload);
    expect(artifacts("executions")[0]).toMatchObject({
      output: rawOutput,
      outputNormalization: "single-trailing-closing-brace",
    });
    expect(JSON.stringify(data)).not.toContain("outputNormalization");
    expectCleaned(inputs[0] as SpawnInput);
  });

  it("rejects model drift since the displayed catalog before spawning or returning cached output", async () => {
    const selected = agent("reporter");
    defaultReporter(selected.id);
    const http = await boot();
    const { data } = (await (
      await fetch(`${http.baseUrl}/api/v1/cli-runs/${RUN_ID}/review-explainer/explanation-agents`, {
        headers: http.headers(),
      })
    ).json()) as { data: ExplanationAgents };
    const shown = data.agents.find((row) => row.id === selected.id);
    if (!shown) throw new Error("missing catalog Agent");
    const expected = { modelId: shown.modelId, driverId: shown.driverId };
    store.updateAgent(selected.id, { modelId: "changed-model" });
    for (const generate of [true, false]) {
      const response = await explanation(selected.id, generate, expected);
      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).toContain("配置已变化");
      expect(body).toContain("EXECUTION_CONFLICT");
    }
    expect(inputs).toHaveLength(0);
    const refreshed = { ...expected, modelId: "changed-model" };
    const generated = await explanation(selected.id, true, refreshed);
    expect(generated.status).toBe(200);
    expect(inputs).toHaveLength(1);
    expect((await explanation(selected.id, false, expected)).status).toBe(409);
    expect((await explanation(selected.id, false, refreshed)).status).toBe(200);
    expect(
      (await explanation(selected.id, false, { ...refreshed, driverId: "wrong-driver" })).status,
    ).toBe(409);
    const cacheDir = join(runDir, "review-explainer", "explanations");
    const cachePath = join(cacheDir, readdirSync(cacheDir)[0] as string);
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    cache.provenance.agentId = "different-agent";
    writeFileSync(cachePath, JSON.stringify(cache));
    expect((await explanation(selected.id, false, refreshed)).status).toBe(409);
    expect(inputs).toHaveLength(1);
  });

  it("requires the complete strict expected model/driver pair in query and body", async () => {
    const selected = agent("reporter");
    defaultReporter(selected.id);
    const http = await boot();
    const url = `${http.baseUrl}${ROUTES.explanation(RUN_ID, FINDING.busy)}`;
    for (const suffix of [
      "expectedModelId=M1",
      "expectedDriverId=grok-stream-json",
      "expectedModelId=&expectedDriverId=grok-stream-json",
    ]) {
      expect(
        (await fetch(`${url}?agentId=${selected.id}&${suffix}`, { headers: http.headers() }))
          .status,
      ).toBe(400);
    }
    for (const expectedAgent of [
      { modelId: "M1" },
      { driverId: "grok-stream-json" },
      { modelId: "M1", driverId: "grok-stream-json", extra: true },
    ]) {
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: http.headers(),
            body: JSON.stringify({ agentId: selected.id, expectedAgent }),
          })
        ).status,
      ).toBe(400);
    }
    expect(inputs).toHaveLength(0);
  });

  it("also protects the injected virtual Agent against displayed model drift", async () => {
    let calls = 0;
    const executor = {
      modelId: "injected-first",
      async generate() {
        calls += 1;
        return payload;
      },
    };
    await boot(undefined, { reviewExplainerExecutor: executor });
    const expected = { modelId: executor.modelId, driverId: "injected" };
    executor.modelId = "injected-changed";
    expect((await explanation("injected-explainer", true, expected)).status).toBe(409);
    expect((await explanation("injected-explainer", false, expected)).status).toBe(409);
    expect(calls).toBe(0);
    expect(
      (await explanation("injected-explainer", true, { ...expected, modelId: executor.modelId }))
        .status,
    ).toBe(200);
    expect(calls).toBe(1);
    expect(inputs).toHaveLength(0);
  });

  it.each([
    ["TIMEOUT", { timedOut: true }, 504, "TURN_TIMEOUT"],
    ["ABORTED", { aborted: true }, 409, "CANCELLED"],
    ["SPAWN_ERROR", { error: "secret-canary in spawn error" }, 503, "DRIVER_SPAWN_FAILED"],
    ["NO_OUTPUT", {}, 502, "EMPTY_OUTPUT"],
    ["EXIT", { exitCode: 1, stderr: "secret-canary in stderr" }, 502, "MODEL_UNAVAILABLE"],
  ] as const)(
    "persists %s diagnostics, returns actionable errors, and cleans isolated homes",
    async (failure, overrides, status, code) => {
      defaultReporter(agent("reporter").id);
      await boot(async (input) => {
        inputs.push(input);
        return { ...emptyOutput, ...overrides, activity: { toolCalls: 2, commands: ["grep"] } };
      });
      const response = await explanation();
      expect(response.status).toBe(status);
      const body = await response.text();
      expect(JSON.parse(body).error.code).toBe(code);
      expect(body).not.toContain("secret-canary");
      const executions = artifacts("executions");
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        status: "failure",
        failure: { code: failure },
        durationMs: expect.any(Number),
        activity: { toolCalls: 2 },
      });
      expect(JSON.stringify(executions)).not.toContain("secret-canary");
      expect(artifacts("explanations")).toEqual([]);
      expectCleaned(inputs[0] as SpawnInput);
    },
  );

  it("keeps the in-flight request and workspace until the runner finishes timeout cleanup", async () => {
    defaultReporter(agent("reporter").id);
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const spawnStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reaped = new Promise<void>((resolve) => {
      release = resolve;
    });
    await boot(
      async (input) => {
        inputs.push(input);
        started();
        await reaped;
        return { ...emptyOutput, timedOut: true };
      },
      { reviewExplainerTimeoutMs: 1 },
    );
    let finished = false;
    const first = explanation().then((response) => {
      finished = true;
      return response;
    });
    await spawnStarted;
    const second = explanation();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    expect(inputs).toHaveLength(1);
    expect(existsSync((inputs[0] as SpawnInput).cwd)).toBe(true);
    release();
    expect((await first).status).toBe(504);
    expect((await second).status).toBe(504);
    expectCleaned(inputs[0] as SpawnInput);
  });

  it("offers the injected executor as an explicit virtual default without spawning a CLI", async () => {
    const http = await boot(undefined, {
      reviewExplainerExecutor: {
        modelId: "injected-fixture",
        async generate() {
          return payload;
        },
      },
    });
    const { data } = (await (
      await fetch(`${http.baseUrl}/api/v1/cli-runs/${RUN_ID}/review-explainer/explanation-agents`, {
        headers: http.headers(),
      })
    ).json()) as { data: ExplanationAgents };
    expect(data).toMatchObject({
      defaultSource: "injected",
      defaultAgentId: "injected-explainer",
      agents: [{ id: "injected-explainer", modelId: "injected-fixture", available: true }],
    });
    expect((await explanation("injected-explainer")).status).toBe(200);
    expect((await explanation("not-injected")).status).toBe(503);
    expect(inputs).toHaveLength(0);
  });

  it("still times out an injected executor and signals its cancellation", async () => {
    let signal: AbortSignal | undefined;
    await boot(undefined, {
      reviewExplainerTimeoutMs: 5,
      reviewExplainerExecutor: {
        generate(input: { signal: AbortSignal }) {
          signal = input.signal;
          return new Promise(() => undefined);
        },
      },
    });
    const response = await explanation("injected-explainer");
    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "TURN_TIMEOUT",
    );
    expect(signal?.aborted).toBe(true);
    expect(artifacts("explanations")).toEqual([]);
  });
});
