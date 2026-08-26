import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "@host/config";
import {
  createCursorStreamJsonDriver,
  cursorModelVerdict,
  parseCursorJsonResult,
  parseCursorModelsText,
} from "@host/drivers/cursor-stream-json";
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
const FAKE_CURSOR = join(repoRoot, "tests/fixtures/drivers/fake-cursor.mjs");
const FINGERPRINT = "f".repeat(64);
const MODEL = "auto";

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
  tempRoot = await mkdtemp(join(tmpdir(), "councilkit-cursor-"));
});

afterEach(async () => {
  for (const driver of drivers) await driver.close().catch(() => undefined);
  drivers = [];
  for (const supervisor of supervisors) await supervisor.shutdownAll(300).catch(() => undefined);
  supervisors = [];
  await waitFor(
    () => pgrepCount("fake-cursor[.]mjs") === 0 && pgrepCount("watchdog-child[.]mjs") === 0,
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
      driverId: "cursor-stream-json",
      installationId: "fake-cursor",
      credentialMode: "installation-managed",
      options: {},
    },
    modelId,
  };
}

function makeInstallation(): InstallationRecord {
  return {
    installationId: "fake-cursor",
    driverId: "cursor-stream-json",
    name: "cursor-agent",
    discoveredPath: FAKE_CURSOR,
    realpath: FAKE_CURSOR,
    fingerprint: FINGERPRINT,
    state: "trusted",
    components: [{ role: "wrapper", path: FAKE_CURSOR, fingerprint: FINGERPRINT }],
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
  const driver = createCursorStreamJsonDriver(deps)(participantId);
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

describe("cursor protocol parsers", () => {
  it("parses cursor-agent models text into catalog + default auto", () => {
    const parsed = parseCursorModelsText(
      "Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\n",
    );
    expect(parsed.canonical).toBe("auto");
    expect(parsed.catalog).toEqual(["auto", "composer-2.5"]);
  });

  it("parses a result JSON object and treats auto as a match", () => {
    const parsed = parseCursorJsonResult(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "COUNCILKIT_OK",
        session_id: "sid-1",
        model: "Composer 2.5",
      }),
    );
    expect(parsed?.text).toBe("COUNCILKIT_OK");
    expect(parsed?.sessionId).toBe("sid-1");
    expect(cursorModelVerdict("auto", "Composer 2.5")).toBe("match");
  });
});

describe("cursor-stream-json driver", () => {
  it("prewarm reads cursor-agent models and returns the live catalog", async () => {
    const driver = await createDriver();
    const prewarm = await driver.prewarm({
      participantId: "p-1",
      spec: makeSpec(),
      installation: makeInstallation(),
    });
    expect(prewarm.canonicalModelId).toBe("auto");
    expect(prewarm.catalog).toEqual(["auto", "composer-2.5"]);
    expect(prewarm.capability.protocol).toBe("cursor-stream-json");
    expect(driver.capabilityState()).toBe("ready");
  });

  it("two turns resume the same session", async () => {
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
    expect(done1.modelVerdict).toBe("match");

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

  it("empty result text is EMPTY_OUTPUT", async () => {
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
    const driver = createCursorStreamJsonDriver({
      supervisor,
      logger,
      timeouts: BASE_TIMEOUTS,
      workRoot: join(tempRoot, "work"),
    })(participantId);
    drivers.push(driver);
    await mkdir(join(tempRoot, "work", participantId), { recursive: true });
    await writeFile(
      join(tempRoot, "work", participantId, "fake-driver-config.json"),
      JSON.stringify({ modelsExit: 1, modelsText: "Please run agent login" }),
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
