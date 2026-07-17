import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "@host/config";
import { createClaudeStreamJsonDriver } from "@host/drivers/claude-stream-json";
import type {
  DriverDeps,
  DriverEvent,
  DriverTimeouts,
  ExecuteInput,
  ParticipantDriver,
  PrewarmResult,
} from "@host/drivers/types";
import type { InstallationRecord } from "@host/installations/registry";
import { createLogger } from "@host/logging";
import { type ProcessSupervisor, createProcessSupervisor } from "@host/process/process-supervisor";
import type { ParticipantSpec } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * claude-stream-json driver protocol tests against the real driver factory,
 * the real process supervisor, and tests/fixtures/drivers/fake-cld.mjs.
 *
 * Fixture behavior is configured via `fake-driver-config.json` in the
 * Participant-dedicated cwd (the supervisor's env hygiene blocks FIXTURE_*
 * env vars from reaching the supervised process by design).
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const WATCHDOG_PROGRAM = join(repoRoot, "runtime-host/process/watchdog-child.mjs");
const FAKE_CLD = join(repoRoot, "tests/fixtures/drivers/fake-cld.mjs");
const FINGERPRINT = "f".repeat(64);
const MODEL_ID = "GLM-5.2[1m]";
const REPLY = "Fake cld answer.";

const BASE_TIMEOUTS: DriverTimeouts = {
  handshakeMs: 8000,
  dispatchAckMs: 1500,
  streamIdleMs: 3000,
  turnMs: 15000,
  interruptGraceMs: 800,
  shutdownGraceMs: 3000,
};

// ---------------------------------------------------------------------------
// Shared plumbing (kept local: this file owns its own harness)
// ---------------------------------------------------------------------------

let tempRoot = "";
let supervisors: ProcessSupervisor[] = [];
let drivers: ParticipantDriver[] = [];

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "councilkit-claude-driver-"));
});

afterEach(async () => {
  for (const driver of drivers) await driver.close().catch(() => undefined);
  drivers = [];
  for (const supervisor of supervisors) await supervisor.shutdownAll(300).catch(() => undefined);
  supervisors = [];
  await waitFor(
    () => pgrepCount("fake-cld[.]mjs") === 0 && pgrepCount("watchdog-child[.]mjs") === 0,
    5000,
  ).catch(() => undefined);
  expect(pgrepCount("fake-cld[.]mjs")).toBe(0);
  expect(pgrepCount("watchdog-child[.]mjs")).toBe(0);
  await rm(tempRoot, { recursive: true, force: true });
});

function pgrepCount(pattern: string): number {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  if (!condition()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function writeFixtureConfig(
  participantId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const dir = join(tempRoot, "work", participantId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "fake-driver-config.json"),
    JSON.stringify({ statsPath: join(tempRoot, "stats"), ...config }),
  );
}

interface AggregatedStats {
  counts: Record<string, number>;
  pids: number[];
}

function aggregateStats(): AggregatedStats {
  const counts: Record<string, number> = {};
  const pids: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(tempRoot);
  } catch {
    return { counts, pids };
  }
  for (const name of names) {
    if (!name.startsWith("stats.") || name.endsWith(".tmp")) continue;
    const pid = Number(name.slice("stats.".length));
    if (Number.isInteger(pid)) pids.push(pid);
    try {
      const parsed = JSON.parse(readFileSync(join(tempRoot, name), "utf8")) as Record<
        string,
        unknown
      >;
      for (const [key, value] of Object.entries(parsed)) {
        if (key !== "pid" && typeof value === "number") counts[key] = (counts[key] ?? 0) + value;
      }
    } catch {
      // Atomic tmp+rename writes; ignore anything unexpected.
    }
  }
  return { counts, pids };
}

type CompletedDriverEvent = Extract<DriverEvent, { type: "completed" }>;
type FailedDriverEvent = Extract<DriverEvent, { type: "failed" }>;
type InterruptedDriverEvent = Extract<DriverEvent, { type: "interrupted" }>;
type UsageDriverEvent = Extract<DriverEvent, { type: "usage" }>;
type TerminalDriverEvent = CompletedDriverEvent | FailedDriverEvent | InterruptedDriverEvent;

interface Run {
  events: DriverEvent[];
  done: Promise<void>;
}

function executeCollecting(driver: ParticipantDriver, input: ExecuteInput): Run {
  const events: DriverEvent[] = [];
  const done = driver.execute(input, (event) => events.push(event));
  return { events, done };
}

function terminalOf(events: DriverEvent[]): TerminalDriverEvent {
  const terminal = events.find(
    (event): event is TerminalDriverEvent =>
      event.type === "completed" || event.type === "failed" || event.type === "interrupted",
  );
  if (!terminal) {
    throw new Error(`no terminal event in [${events.map((event) => event.type).join(", ")}]`);
  }
  return terminal;
}

function usageEventsOf(events: DriverEvent[]): UsageDriverEvent[] {
  return events.filter((event): event is UsageDriverEvent => event.type === "usage");
}

function execInput(executionId: string, prompt: string): ExecuteInput {
  return { executionId, prompt, modelId: MODEL_ID, coldStart: executionId === "exec-1" };
}

function makeSpec(participantId: string): ParticipantSpec {
  return {
    participantId,
    profile: {
      driverId: "claude-stream-json",
      installationId: "fake-cld",
      credentialMode: "installation-managed",
      options: { route: "ant-glm5.2" },
    },
    modelId: MODEL_ID,
  };
}

function makeInstallation(): InstallationRecord {
  return {
    installationId: "fake-cld",
    driverId: "claude-stream-json",
    name: "cld",
    discoveredPath: FAKE_CLD,
    realpath: FAKE_CLD,
    fingerprint: FINGERPRINT,
    state: "trusted",
    components: [
      { role: "wrapper", path: FAKE_CLD, fingerprint: FINGERPRINT },
      { role: "claude-binary", path: FAKE_CLD, fingerprint: FINGERPRINT },
    ],
    detail: null,
  };
}

interface Rig {
  driver: ParticipantDriver;
  supervisor: ProcessSupervisor;
  participantId: string;
  prewarmResult: PrewarmResult;
}

async function createRig(
  options: {
    config?: Record<string, unknown>;
    timeouts?: Partial<DriverTimeouts>;
    spec?: ParticipantSpec;
  } = {},
): Promise<Rig> {
  const participantId = "p-1";
  const config: HostConfig = {
    mode: "production",
    hostname: "127.0.0.1",
    port: 0,
    hostHeader: "127.0.0.1",
    distDir: tempRoot,
    watchdogProgram: WATCHDOG_PROGRAM,
    driverWorkRoot: join(tempRoot, "work"),
  };
  const logger = createLogger({ sink: () => {} });
  const supervisor = createProcessSupervisor({ config, logger });
  supervisors.push(supervisor);
  const deps: DriverDeps = {
    supervisor,
    logger,
    timeouts: { ...BASE_TIMEOUTS, ...(options.timeouts ?? {}) },
    workRoot: join(tempRoot, "work"),
  };
  const driver = createClaudeStreamJsonDriver(deps)(participantId);
  drivers.push(driver);
  await writeFixtureConfig(participantId, options.config ?? {});
  const prewarmResult = await driver.prewarm({
    participantId,
    spec: options.spec ?? makeSpec(participantId),
    installation: makeInstallation(),
  });
  return { driver, supervisor, participantId, prewarmResult };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("claude-stream-json driver protocol", () => {
  it("marks dispatch accepted when the user message is replayed", async () => {
    const rig = await createRig();
    const run = executeCollecting(rig.driver, execInput("exec-1", "Hello."));
    await run.done;
    expect(run.events[0]?.type).toBe("started");
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    expect(terminal.dispatchState).toBe("accepted");
    expect(aggregateStats().counts.userMessages).toBe(1);
  });

  it("fails DISPATCH_TIMEOUT without an in-place retry when the replay never comes", async () => {
    const rig = await createRig({ config: { noReplay: true } });
    const run = executeCollecting(rig.driver, execInput("exec-1", "Hello."));
    await run.done;
    expect(run.events.map((event) => event.type)).toEqual(["started", "failed"]);
    const terminal = terminalOf(run.events);
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("DISPATCH_TIMEOUT");
    expect(terminal.error.phase).toBe("dispatch");
    expect(terminal.dispatchState).toBe("unknown");
    expect(terminal.retryable).toBe(false);
    // Never re-dispatched: exactly one user message reached any fixture process.
    expect(aggregateStats().counts.userMessages).toBe(1);
    // The driver rebuilds the poisoned session in the background: a fresh
    // process handshakes and the driver becomes usable again.
    await waitFor(() => aggregateStats().counts.initializes === 2, 8000);
    await writeFixtureConfig(rig.participantId, {});
    const run2 = executeCollecting(rig.driver, execInput("exec-2", "After timeout."));
    await run2.done;
    expect(terminalOf(run2.events).type).toBe("completed");
    expect(aggregateStats().counts.userMessages).toBe(2);
  });

  it("retries exactly once in place when the process died before dispatch", async () => {
    const rig = await createRig();
    const stats = aggregateStats();
    expect(stats.pids).toHaveLength(1);
    // Kill the fixture externally (host view: driver crash while idle).
    process.kill(stats.pids[0] as number, "SIGKILL");
    await waitFor(() => rig.driver.sessionEpoch === 1, 5000);

    const run = executeCollecting(rig.driver, execInput("exec-1", "Revive."));
    await run.done;
    // The first attempt provably never dispatched, so it was swallowed and
    // retried once on a respawned process: no failed event reaches the caller.
    expect(run.events.some((event) => event.type === "failed")).toBe(false);
    expect(terminalOf(run.events).type).toBe("completed");
    const after = aggregateStats();
    expect(after.pids).toHaveLength(2); // a NEW process was spawned
    expect(after.counts.initializes).toBe(2); // and it handshaked
    expect(after.counts.userMessages).toBe(1); // dispatch happened exactly once
    expect(rig.driver.sessionEpoch).toBe(2); // crash epoch + respawn epoch
  });

  it("fails the first turn INCOMPATIBLE_DRIVER when system/init is not empty", async () => {
    const rig = await createRig({ config: { initNonempty: true } });
    const run = executeCollecting(rig.driver, execInput("exec-1", "Hello."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("INCOMPATIBLE_DRIVER");
    expect(terminal.dispatchState).toBe("accepted"); // replay arrived before init
    expect(aggregateStats().counts.userMessages).toBe(1);
  });

  it("reports usage as per-turn diffs across three turns", async () => {
    const rig = await createRig();
    const prompts = ["Alpha.", "Beta prompt.", "Gamma prompt, longer."];
    for (let index = 0; index < prompts.length; index += 1) {
      const prompt = prompts[index] as string;
      const run = executeCollecting(rig.driver, execInput(`exec-${index + 1}`, prompt));
      await run.done;
      const terminal = terminalOf(run.events);
      expect(terminal.type).toBe("completed");
      const usageEvents = usageEventsOf(run.events);
      expect(usageEvents).toHaveLength(1);
      // Exactly this turn's increment, not the session-cumulative totals the
      // fixture reports in its result frame.
      expect(usageEvents[0]?.usage.inputTokens).toBe(100 + prompt.length);
      expect(usageEvents[0]?.usage.outputTokens).toBe(REPLY.length);
      expect(usageEvents[0]?.usage.costUsd).toBeCloseTo(0.001, 5);
      if (terminal.type !== "completed") throw new Error("unreachable");
      expect(terminal.usage?.inputTokens).toBe(100 + prompt.length);
    }
    // Sanity: the fixture's raw counters really were cumulative (turn 3 input
    // would be the sum of all three increments if the driver did not diff).
    // The stats file write races the result frame's IPC delivery, so wait.
    await waitFor(() => aggregateStats().counts.results === 3, 5000);
  });

  it("escalates a ignored interrupt to SIGKILL and respawns a usable driver", async () => {
    const rig = await createRig({ config: { deltaDelayMs: 200, ignoreInterrupt: true } });
    const run = executeCollecting(rig.driver, execInput("exec-1", "Cancel me."));
    await waitFor(() => run.events.some((event) => event.type === "output.delta"), 5000);
    await rig.driver.cancel("exec-1");
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("interrupted");
    if (terminal.type !== "interrupted") throw new Error("unreachable");
    expect(terminal.reason).toBe("user_cancelled");
    // The interrupt was acknowledged but the turn never ended, so the driver
    // SIGKILLed after the grace window and rebuilt the session.
    await waitFor(() => aggregateStats().counts.initializes === 2, 8000);
    expect(aggregateStats().counts.interrupts).toBe(1);
    await writeFixtureConfig(rig.participantId, {});
    const run2 = executeCollecting(rig.driver, execInput("exec-2", "Still alive?"));
    await run2.done;
    expect(terminalOf(run2.events).type).toBe("completed");
    expect(aggregateStats().pids).toHaveLength(2);
  });

  it("fails STREAM_IDLE_TIMEOUT when the stream goes silent before the result", async () => {
    const rig = await createRig({
      config: { hang: true },
      timeouts: { streamIdleMs: 1000 },
    });
    const run = executeCollecting(rig.driver, execInput("exec-1", "Hello."));
    await run.done;
    // Deltas streamed fine; the missing result trips the idle watchdog.
    expect(run.events.some((event) => event.type === "output.delta")).toBe(true);
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("STREAM_IDLE_TIMEOUT");
    expect(terminal.dispatchState).toBe("accepted");
  });

  it("normalizes the moonshot route canonical to its declared serving model", async () => {
    const rig = await createRig({
      spec: {
        participantId: "p-1",
        profile: {
          driverId: "claude-stream-json",
          installationId: "fake-cld",
          credentialMode: "installation-managed",
          options: { route: "moonshot" },
        },
        modelId: "Kimi-K3[1m]",
      },
      config: {
        // The route serves Kimi-K3[1m] while the catalog default is Opus —
        // mirrors the live moonshot installation (drift-verified 2026-07-18).
        initModel: "Kimi-K3[1m]",
        catalog: [
          { value: "default", resolvedModel: "claude-opus-4-8[1m]" },
          { value: "opus[1m]", resolvedModel: "claude-opus-4-8[1m]" },
          { value: "Kimi-K3[1m]", resolvedModel: "Kimi-K3[1m]" },
        ],
      },
    });
    // Canonical is the route's declared serving model, not the catalog default.
    expect(rig.prewarmResult.canonicalModelId).toBe("Kimi-K3[1m]");
    const run = executeCollecting(rig.driver, {
      executionId: "exec-1",
      prompt: "Hello.",
      modelId: "Kimi-K3[1m]",
      coldStart: true,
    });
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    expect(terminal.effectiveModel).toBe("Kimi-K3[1m]");
    expect(terminal.modelVerdict).toBe("match");
  });

  it("rejects prewarm when the route's declared serving model left the catalog", async () => {
    await expect(
      createRig({
        spec: {
          participantId: "p-1",
          profile: {
            driverId: "claude-stream-json",
            installationId: "fake-cld",
            credentialMode: "installation-managed",
            options: { route: "moonshot" },
          },
          modelId: "Kimi-K3[1m]",
        },
        config: {
          initModel: "claude-opus-4-8[1m]",
          catalog: [{ value: "default", resolvedModel: "claude-opus-4-8[1m]" }],
        },
      }),
    ).rejects.toMatchObject({ runtimeCode: "INCOMPATIBLE_DRIVER" });
  });
});
