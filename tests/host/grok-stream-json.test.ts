import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "@host/config";
import {
  createGrokStreamJsonDriver,
  grokModelVerdict,
  parseGrokJsonResult,
  parseGrokModelsText,
} from "@host/drivers/grok-stream-json";
import type {
  DriverDeps,
  DriverEvent,
  DriverTimeouts,
  ExecuteInput,
  ParticipantDriver,
} from "@host/drivers/types";
import type { InstallationRecord } from "@host/installations/registry";
import { createLogger } from "@host/logging";
import { type ProcessSupervisor, createProcessSupervisor } from "@host/process/process-supervisor";
import type { ParticipantSpec } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const WATCHDOG_PROGRAM = join(repoRoot, "runtime-host/process/watchdog-child.mjs");
const FAKE_GROK = join(repoRoot, "tests/fixtures/drivers/fake-grok.mjs");
const FINGERPRINT = "f".repeat(64);
const MODEL = "grok-4.6";

const BASE_TIMEOUTS: DriverTimeouts = {
  handshakeMs: 8000,
  dispatchAckMs: 1500,
  streamIdleMs: 3000,
  turnMs: 15000,
  interruptGraceMs: 800,
  shutdownGraceMs: 3000,
};

let tempRoot = "";
let supervisors: ProcessSupervisor[] = [];
let drivers: ParticipantDriver[] = [];

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "councilkit-grok-"));
});

afterEach(async () => {
  for (const driver of drivers) await driver.close().catch(() => undefined);
  drivers = [];
  for (const supervisor of supervisors) await supervisor.shutdownAll(300).catch(() => undefined);
  supervisors = [];
  await waitFor(
    () => pgrepCount("fake-grok[.]mjs") === 0 && pgrepCount("watchdog-child[.]mjs") === 0,
    5000,
  ).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
});

function pgrepCount(pattern: string): number {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!condition()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function makeSpec(modelId = MODEL): ParticipantSpec {
  return {
    participantId: "p-1",
    profile: {
      driverId: "grok-stream-json",
      installationId: "fake-grok",
      credentialMode: "installation-managed",
      options: {},
    },
    modelId,
  };
}

function makeInstallation(): InstallationRecord {
  return {
    installationId: "fake-grok",
    driverId: "grok-stream-json",
    name: "grok",
    discoveredPath: FAKE_GROK,
    realpath: FAKE_GROK,
    fingerprint: FINGERPRINT,
    state: "trusted",
    components: [{ role: "wrapper", path: FAKE_GROK, fingerprint: FINGERPRINT }],
    detail: null,
  };
}

async function createDriver(config: Record<string, unknown> = {}): Promise<ParticipantDriver> {
  const participantId = "p-1";
  const config2: HostConfig = {
    mode: "production",
    hostname: "127.0.0.1",
    port: 0,
    hostHeader: "127.0.0.1",
    distDir: tempRoot,
    watchdogProgram: WATCHDOG_PROGRAM,
    driverWorkRoot: join(tempRoot, "work"),
  };
  const logger = createLogger({ sink: () => {} });
  const supervisor = createProcessSupervisor({ config: config2, logger });
  supervisors.push(supervisor);
  const deps: DriverDeps = {
    supervisor,
    logger,
    timeouts: BASE_TIMEOUTS,
    workRoot: join(tempRoot, "work"),
  };
  const driver = createGrokStreamJsonDriver(deps)(participantId);
  drivers.push(driver);
  const dir = join(tempRoot, "work", participantId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fake-driver-config.json"), JSON.stringify(config));
  await driver.prewarm({
    participantId,
    spec: makeSpec(),
    installation: makeInstallation(),
  });
  return driver;
}

function executeCollecting(driver: ParticipantDriver, input: ExecuteInput) {
  const events: DriverEvent[] = [];
  const done = driver.execute(input, (event) => events.push(event));
  return { events, done };
}

type Terminal = Extract<DriverEvent, { type: "completed" | "failed" | "interrupted" }>;
function terminalOf(events: DriverEvent[]): Terminal {
  const terminal = events.find(
    (event): event is Terminal =>
      event.type === "completed" || event.type === "failed" || event.type === "interrupted",
  );
  if (!terminal) throw new Error(`no terminal in [${events.map((e) => e.type).join(",")}]`);
  return terminal;
}

describe("grok protocol parsers", () => {
  it("parses grok models text into catalog + default", () => {
    const parsed = parseGrokModelsText(
      "You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n",
    );
    expect(parsed.canonical).toBe("grok-4.6");
    expect(parsed.catalog).toEqual(["grok-4.6", "grok-4.5"]);
  });

  it("parses pretty-printed grok json and treats grok-4.6-build as a match", () => {
    const parsed = parseGrokJsonResult(
      JSON.stringify(
        {
          text: "COUNCILKIT_OK",
          sessionId: "sid-1",
          usage: { input_tokens: 10, output_tokens: 2, total_cost_usd: 0.01 },
          modelUsage: { "grok-4.6-build": {} },
        },
        null,
        2,
      ),
    );
    expect(parsed?.text).toBe("COUNCILKIT_OK");
    expect(parsed?.sessionId).toBe("sid-1");
    expect(parsed?.effectiveModel).toBe("grok-4.6-build");
    expect(grokModelVerdict("grok-4.6", "grok-4.6-build")).toBe("match");
  });
});

describe("grok-stream-json driver", () => {
  it("prewarm reads grok models and returns the live catalog", async () => {
    const driver = await createDriver();
    const prewarm = await driver.prewarm({
      participantId: "p-1",
      spec: makeSpec(),
      installation: makeInstallation(),
    });
    expect(prewarm.canonicalModelId).toBe("grok-4.6");
    expect(prewarm.catalog).toEqual(["grok-4.6", "grok-4.5"]);
    expect(prewarm.modelAliases).toEqual(["grok-4.6-build"]);
    expect(prewarm.capability.protocol).toBe("grok-stream-json");
    expect(driver.capabilityState()).toBe("ready");
  });

  it("two turns resume the same session and complete with usage", async () => {
    const driver = await createDriver({ reply: "Turn text." });
    const first = executeCollecting(driver, {
      executionId: "exec-1",
      prompt: "One",
      modelId: MODEL,
      coldStart: true,
    });
    await first.done;
    const done1 = terminalOf(first.events);
    expect(done1.type).toBe("completed");
    if (done1.type !== "completed") throw new Error("unreachable");
    expect(done1.output).toBe("Turn text.");
    expect(done1.usage?.inputTokens).toBe(10);
    expect(done1.modelVerdict).toBe("match");
    expect(first.events.filter((e) => e.type === "output.delta")).toHaveLength(0);

    const second = executeCollecting(driver, {
      executionId: "exec-2",
      prompt: "Two",
      modelId: MODEL,
      coldStart: false,
    });
    await second.done;
    expect(terminalOf(second.events).type).toBe("completed");
    expect(driver.sessionEpoch).toBe(0);
  });

  it("empty json text is EMPTY_OUTPUT", async () => {
    const driver = await createDriver({ emptyText: true });
    const run = executeCollecting(driver, {
      executionId: "exec-1",
      prompt: "x",
      modelId: MODEL,
      coldStart: true,
    });
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("EMPTY_OUTPUT");
  });

  it("models probe non-zero exit is AUTH_REQUIRED", async () => {
    const participantId = "p-auth";
    const config2: HostConfig = {
      mode: "production",
      hostname: "127.0.0.1",
      port: 0,
      hostHeader: "127.0.0.1",
      distDir: tempRoot,
      watchdogProgram: WATCHDOG_PROGRAM,
      driverWorkRoot: join(tempRoot, "work"),
    };
    const logger = createLogger({ sink: () => {} });
    const supervisor = createProcessSupervisor({ config: config2, logger });
    supervisors.push(supervisor);
    const driver = createGrokStreamJsonDriver({
      supervisor,
      logger,
      timeouts: BASE_TIMEOUTS,
      workRoot: join(tempRoot, "work"),
    })(participantId);
    drivers.push(driver);
    await mkdir(join(tempRoot, "work", participantId), { recursive: true });
    await writeFile(
      join(tempRoot, "work", participantId, "fake-driver-config.json"),
      JSON.stringify({ modelsExit: 1, modelsText: "Please run grok login" }),
    );
    await expect(
      driver.prewarm({
        participantId,
        spec: makeSpec(),
        installation: makeInstallation(),
      }),
    ).rejects.toMatchObject({ runtimeCode: "AUTH_REQUIRED" });
  });
});
