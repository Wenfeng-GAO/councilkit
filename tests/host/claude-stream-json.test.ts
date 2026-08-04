import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
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
import {
  type DriverProcess,
  type ProcessSupervisor,
  createProcessSupervisor,
} from "@host/process/process-supervisor";
import { buildBinding } from "@host/profiles/resolver";
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

/** Reads the first stats file verbatim (includes the route/env scent the
 * aggregate drops: routeArgv string + hasCldClaudeBin/hasCldCfuseBin booleans). */
function firstStats(): Record<string, unknown> | null {
  let names: string[] = [];
  try {
    names = readdirSync(tempRoot);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith("stats.") || name.endsWith(".tmp")) continue;
    if (!Number.isInteger(Number(name.slice("stats.".length)))) continue;
    try {
      return JSON.parse(readFileSync(join(tempRoot, name), "utf8")) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  return null;
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

/** cfuse-route installation: wrapper + cfuse-binary only (no claude-binary),
 * mirroring a cfuse-only environment. The cfuse route must spawn via
 * CLD_CFUSE_BIN and never depend on CLD_CLAUDE_BIN. */
function makeCfuseInstallation(): InstallationRecord {
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
      { role: "cfuse-binary", path: FAKE_CLD, fingerprint: FINGERPRINT },
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
    installation?: InstallationRecord;
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
    installation: options.installation ?? makeInstallation(),
  });
  return { driver, supervisor, participantId, prewarmResult };
}

/** In-memory DriverProcess seam driver builder (extracted from the H4 block so
 * the CK-ROT-001 respawn test can reuse it). `onSpawn` fires synchronously when
 * the supervisor's spawnDriver is called (before the returned promise settles),
 * giving tests a deterministic "spawn initiated" signal. `spawnImpl`, when
 * provided, overrides the resolved DriverProcess (e.g. a gated promise). */
async function buildSeamDriver(
  fakeProcess: DriverProcess,
  onSpawn: () => void,
  spawnImpl?: () => Promise<DriverProcess>,
): Promise<{ participantId: string; driver: ParticipantDriver }> {
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
  const realSupervisor = createProcessSupervisor({ config, logger });
  supervisors.push(realSupervisor);
  const seamSupervisor: ProcessSupervisor = {
    ...realSupervisor,
    spawnDriver: () => {
      onSpawn();
      return spawnImpl ? spawnImpl() : Promise.resolve(fakeProcess);
    },
  };
  const deps: DriverDeps = {
    supervisor: seamSupervisor,
    logger,
    timeouts: BASE_TIMEOUTS,
    workRoot: join(tempRoot, "work"),
  };
  const driver = createClaudeStreamJsonDriver(deps)(participantId);
  drivers.push(driver);
  await writeFixtureConfig(participantId, {});
  return { participantId, driver };
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
        modelId: "k3",
      },
      config: {
        // The route serves k3 while the catalog default is Opus —
        // mirrors the live moonshot installation (drift-verified 2026-07-19).
        initModel: "k3",
        catalog: [
          { value: "default", resolvedModel: "claude-opus-4-8[1m]" },
          { value: "opus[1m]", resolvedModel: "claude-opus-4-8[1m]" },
          { value: "k3", resolvedModel: "k3" },
        ],
      },
    });
    // Canonical is the route's declared serving model, not the catalog default.
    expect(rig.prewarmResult.canonicalModelId).toBe("k3");
    // The route declares its provider window class (no 64k false-throttle).
    expect(rig.driver.contextWindowTokens()).toBe(1_000_000);
    const run = executeCollecting(rig.driver, {
      executionId: "exec-1",
      prompt: "Hello.",
      modelId: "k3",
      coldStart: true,
    });
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    expect(terminal.effectiveModel).toBe("k3");
    expect(terminal.modelVerdict).toBe("match");
  });

  it("keeps existing Moonshot K3 agents ready after the provider model-id drift", async () => {
    const legacyModelIds = ["k3[1m]", "Kimi-K3[1m]", "Kimi-K3"];
    for (const modelId of legacyModelIds) {
      const spec: ParticipantSpec = {
        participantId: "p-1",
        profile: {
          driverId: "claude-stream-json",
          installationId: "fake-cld",
          credentialMode: "installation-managed",
          options: { route: "moonshot" },
        },
        modelId,
      };
      const rig = await createRig({
        spec,
        config: {
          initModel: "k3",
          catalog: [
            { value: "default", resolvedModel: "k3" },
            { value: "opus[1m]", resolvedModel: "k3[1m]" },
            { value: "k3", resolvedModel: "k3" },
          ],
        },
      });

      const binding = buildBinding(spec, makeInstallation(), rig.prewarmResult);
      expect(binding.readiness).toEqual({ state: "ready", detail: null });
      expect(binding.binding?.requestedModel).toBe(modelId);
      expect(binding.binding?.canonicalModelId).toBe("k3");
    }
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
          modelId: "k3",
        },
        config: {
          initModel: "claude-opus-4-8[1m]",
          catalog: [{ value: "default", resolvedModel: "claude-opus-4-8[1m]" }],
        },
      }),
    ).rejects.toMatchObject({ runtimeCode: "INCOMPATIBLE_DRIVER" });
  });
});

describe("claude-stream-json driver cfuse route", () => {
  it("prewarms a cfuse-only installation (no claude-binary) and declares its window", async () => {
    const rig = await createRig({
      spec: {
        participantId: "p-1",
        profile: {
          driverId: "claude-stream-json",
          installationId: "fake-cld",
          credentialMode: "installation-managed",
          options: { route: "cfuse" },
        },
        modelId: MODEL_ID,
      },
      installation: makeCfuseInstallation(),
    });
    // cfuse route serves the catalog default (no servesModel divergence yet).
    expect(rig.prewarmResult.canonicalModelId).toBe(MODEL_ID);
    // The live cfuse handshake catalog is antchat/-prefixed
    // (antchat/GLM-5.2[1m]); modelAliases admits the legacy un-prefixed
    // GLM agent modelId GLM-5.2[1m] as a binding-time compat name.
    expect(rig.prewarmResult.modelAliases).toContain("GLM-5.2[1m]");
    expect(rig.driver.contextWindowTokens()).toBe(1_000_000);
    // cfuse spawn scent: leading argv "cfuse", CLD_CFUSE_BIN set, CLD_CLAUDE_BIN absent.
    await waitFor(() => firstStats() !== null, 3000);
    const scent = firstStats();
    expect(scent?.routeArgv).toBe("cfuse");
    expect(scent?.hasCldCfuseBin).toBe(true);
    expect(scent?.hasCldClaudeBin).toBe(false);
  });

  it("completes a real cfuse turn over the cfuse-binary pin", async () => {
    const rig = await createRig({
      spec: {
        participantId: "p-1",
        profile: {
          driverId: "claude-stream-json",
          installationId: "fake-cld",
          credentialMode: "installation-managed",
          options: { route: "cfuse" },
        },
        modelId: MODEL_ID,
      },
      installation: makeCfuseInstallation(),
    });
    const run = executeCollecting(rig.driver, execInput("exec-1", "Hello."));
    await run.done;
    expect(run.events[0]?.type).toBe("started");
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    expect(terminal.dispatchState).toBe("accepted");
    expect(aggregateStats().counts.userMessages).toBe(1);
  });

  it("fails INSTALLATION_INVALID prewarm on the cfuse route when cfuse-binary is missing", async () => {
    // A full (claude+cfuse) installation does NOT satisfy the cfuse route —
    // cfuse execs the cfuse-binary, not the claude-binary.
    await expect(
      createRig({
        spec: {
          participantId: "p-1",
          profile: {
            driverId: "claude-stream-json",
            installationId: "fake-cld",
            credentialMode: "installation-managed",
            options: { route: "cfuse" },
          },
          modelId: MODEL_ID,
        },
        installation: makeInstallation(), // has claude-binary, no cfuse-binary
      }),
    ).rejects.toMatchObject({ runtimeCode: "INSTALLATION_INVALID" });
  });

  it("non-cfuse routes still REQUIRE claude-binary (a cfuse-only install is INSTALLATION_INVALID)", async () => {
    await expect(
      createRig({
        spec: {
          participantId: "p-1",
          profile: {
            driverId: "claude-stream-json",
            installationId: "fake-cld",
            credentialMode: "installation-managed",
            options: { route: "ant-glm5.2" },
          },
          modelId: MODEL_ID,
        },
        installation: makeCfuseInstallation(), // cfuse-binary only, no claude-binary
      }),
    ).rejects.toMatchObject({ runtimeCode: "INSTALLATION_INVALID" });
  });
});

/**
 * H4 (CK-RS-001 port) — close()-caught prewarm handshake shutdowns must carry
 * runtimeCode CANCELLED. These tests exercise the driver layer directly with an
 * in-memory DriverProcess seam: the `initialize` control is held in flight (no
 * control_response is ever emitted, so withDeadline stays suspended — no timer
 * race), then close() (or a bare exit) drives onProcessExit. The scope-manager
 * CANCELLED branch itself is already covered by the CK-RS-001 integration suite
 * (tests/integration/runtime-host.test.ts:1291), so proving the driver emits
 * runtimeCode CANCELLED here is sufficient.
 */
describe("claude-stream-json driver H4 close()-caught handshake", () => {
  function makeFakeProcess(
    participantId: string,
    events: EventEmitter,
    onShutdown?: () => void,
    stdinLines?: string[],
    waitSupervisedImpl?: () => Promise<void>,
  ): DriverProcess {
    return {
      participantId,
      pid: -1,
      pgid: -1,
      watchdogPid: -1,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          if (stdinLines) {
            for (const line of chunk.toString("utf8").split("\n")) {
              if (line.length > 0) stdinLines.push(line);
            }
          }
          callback();
        },
      }),
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      events,
      waitSupervised: waitSupervisedImpl ?? (() => Promise.resolve()),
      kill: () => {},
      closeStdin: () => {},
      // F3 (fix-2): shutdown is async (deferred to the next tick) to reflect
      // production teardown — a real SIGTERM/shutdown resolves across event-loop
      // turns, not synchronously. close() awaits this, so the exit it emits
      // lands deterministically before close returns.
      shutdown: () =>
        new Promise<void>((resolveShutdown) => {
          setTimeout(() => {
            onShutdown?.();
            resolveShutdown();
          }, 0);
        }),
      __testInjectControlLine: () => {},
    };
  }

  it("AC1: close() during an in-flight initialize rejects CANCELLED, not the plain crash label", async () => {
    // closeScopeInternal (controller-close / host closeAll / 30s creating-TTL
    // sweeper) → driver.close() SIGTERMs the process while the `initialize`
    // control is in flight. onProcessExit runs with state='closing', so the
    // isClosingOrClosed() guard must label the close-caught rejection CANCELLED
    // (H4), never the plain 'driver process exited'. In-memory seam: no exit is
    // emitted until shutdown, so withDeadline is suspended — deterministically
    // no timer race.
    let shutdownCalls = 0;
    const events = new EventEmitter();
    const stdinLines: string[] = [];
    const fakeProcess = makeFakeProcess(
      "p-1",
      events,
      () => {
        shutdownCalls += 1;
        // The first (and only) shutdown comes from close() and drives the
        // SIGTERM exit the in-flight initialize is parked behind; idempotent —
        // afterEach's close() finds process=null and reaps nothing.
        if (shutdownCalls === 1) {
          events.emit("exit", { code: null, signal: "SIGTERM" });
        }
      },
      stdinLines,
    );
    let spawnCount = 0;
    const { participantId, driver } = await buildSeamDriver(fakeProcess, () => {
      spawnCount += 1;
    });

    // prewarm parks at sendControl({subtype:'initialize'}); no control_response
    // is ever emitted, so withDeadline stays suspended — no timer race.
    const prewarmOutcome = driver
      .prewarm({
        participantId,
        spec: makeSpec(participantId),
        installation: makeInstallation(),
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await waitFor(() => spawnCount === 1, 2000);
    // Deterministic sync: wait until the `initialize` control frame is written
    // to stdin, which is exactly when the in-flight control is registered and
    // parked (no fixed sleep).
    await waitFor(() => stdinLines.some((line) => line.includes('"subtype":"initialize"')), 2000);

    // close() while initialize is in flight.
    await driver.close();
    const outcome = await prewarmOutcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.error as { runtimeCode?: string }).runtimeCode).toBe("CANCELLED");
      // NOT the plain crash label that the unguarded path emits.
      expect((outcome.error as Error).message).not.toBe("driver process exited");
    }
    expect(driver.capabilityState()).toBe("checking"); // closed — never ready
    expect(shutdownCalls).toBeGreaterThanOrEqual(1);
    expect(pgrepCount("fake-cld[.]mjs")).toBe(0);
  });

  it("AC1c: close() during a pending spawn shuts the late process down and rejects CANCELLED without adopting (P1)", async () => {
    // P1: close() during the spawn await (process===null, nothing pending to
    // fail) previously closed the driver outright; the late spawn then resolved
    // and was adopted into the closed driver — a leak the catch fallback
    // masked. The pendingSpawn track + post-spawn guard must shut the late
    // process down, reject CANCELLED, and never adopt it (capabilityState stays
    // checking, never ready). Gated in-memory seam: the spawn resolves only
    // when close() has already set state='closing' and parked on pendingSpawn.
    let shutdownCalls = 0;
    const events = new EventEmitter();
    const fakeProcess = makeFakeProcess("p-1", events, () => {
      shutdownCalls += 1;
    });
    let releaseSpawn: () => void = () => {};
    const spawnGate = new Promise<DriverProcess>((resolveSpawn) => {
      releaseSpawn = () => resolveSpawn(fakeProcess);
    });
    let spawnCount = 0;
    const { participantId, driver } = await buildSeamDriver(
      fakeProcess,
      () => {
        spawnCount += 1;
      },
      () => spawnGate,
    );

    const prewarmOutcome = driver
      .prewarm({
        participantId,
        spec: makeSpec(participantId),
        installation: makeInstallation(),
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    // prewarm parks inside the gated spawn await (pendingSpawn registered).
    await waitFor(() => spawnCount === 1, 2000);

    // close() while the spawn is pending (process===null). close() sets
    // state='closing' synchronously, then awaits pendingSpawn.
    const closePromise = driver.close();
    // Release the gate: the spawn resolves, the post-spawn guard sees closing,
    // shuts the late process down and rejects CANCELLED, and close() completes.
    releaseSpawn();
    await closePromise;

    const outcome = await prewarmOutcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.error as { runtimeCode?: string }).runtimeCode).toBe("CANCELLED");
    }
    // The late process was reaped by the guard, never adopted (the driver never
    // reached ready — process was never assigned).
    expect(shutdownCalls).toBeGreaterThanOrEqual(1);
    expect(driver.capabilityState()).toBe("checking");
    expect(pgrepCount("fake-cld[.]mjs")).toBe(0);
  });

  it("AC2: a process exit without close() rejects with the plain 'driver process exited' (no CANCELLED regression)", async () => {
    // A genuine crash during the handshake (no concurrent close) keeps the
    // existing non-CANCELLED path: onProcessExit runs with state='starting', so
    // the isClosingOrClosed() guard is false, failAllPendingControls keeps the
    // plain crash label, and prewarm writes back cold. (The genuine
    // INCOMPATIBLE_DRIVER handshake failure is already covered above at L513;
    // this seam covers the crash-exit axis directly.)
    const events = new EventEmitter();
    const stdinLines: string[] = [];
    const fakeProcess = makeFakeProcess("p-1", events, undefined, stdinLines);
    let spawnCount = 0;
    const { participantId, driver } = await buildSeamDriver(fakeProcess, () => {
      spawnCount += 1;
    });

    const prewarmOutcome = driver
      .prewarm({
        participantId,
        spec: makeSpec(participantId),
        installation: makeInstallation(),
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await waitFor(() => spawnCount === 1, 2000);
    // F3 (fix-2): deterministic frame sync (no fixed sleep) — wait until the
    // `initialize` control frame is written to stdin, which is exactly when the
    // in-flight control is registered and parked. The exit below then rejects
    // that pending control via onProcessExit.
    await waitFor(() => stdinLines.some((line) => line.includes('"subtype":"initialize"')), 2000);

    // A genuine exit with no concurrent close(): the process dies on its own.
    events.emit("exit", { code: 1, signal: null });

    const outcome = await prewarmOutcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.error as { runtimeCode?: string }).runtimeCode).toBeUndefined();
      expect((outcome.error as Error).message).toBe("driver process exited");
    }
    expect(pgrepCount("fake-cld[.]mjs")).toBe(0);
  });

  it("AC3: close() during waitSupervised rejects CANCELLED (F1 — no pending control covers that window)", async () => {
    // F1: waitSupervised sits between the adopt and the initialize control —
    // `process` is set and the exit handler is registered, BUT nothing is
    // pending. close() SIGTERMs the process here; onProcessExit's
    // failAllPendingControls(CANCELLED) has nothing to reject, so without the
    // waitSupervised close-guard the plain supervised-spawn error would poison
    // the closing scope with runtime_unavailable + prewarm_failed. The guard
    // must relabel it CANCELLED (H4).
    let shutdownCalls = 0;
    let waitSupervisedCalled = false;
    const events = new EventEmitter();
    const fakeProcess = makeFakeProcess(
      "p-1",
      events,
      () => {
        shutdownCalls += 1;
        // close()'s shutdown drives the SIGTERM exit the parked waitSupervised
        // is behind (idempotent — afterEach's close() finds process=null).
        if (shutdownCalls === 1) {
          events.emit("exit", { code: null, signal: "SIGTERM" });
        }
      },
      undefined,
      () => {
        waitSupervisedCalled = true;
        // Park until the exit event — a real supervised spawn rejects on exit.
        return new Promise<void>((_resolve, reject) => {
          events.once("exit", () => reject(new Error("supervised spawn failed")));
        });
      },
    );
    let spawnCount = 0;
    const { participantId, driver } = await buildSeamDriver(fakeProcess, () => {
      spawnCount += 1;
    });

    const prewarmOutcome = driver
      .prewarm({
        participantId,
        spec: makeSpec(participantId),
        installation: makeInstallation(),
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await waitFor(() => spawnCount === 1, 2000);
    // Deterministic sync: wait until waitSupervised has actually been entered
    // — the adopt→initialize window F1 targets (no fixed sleep).
    await waitFor(() => waitSupervisedCalled, 2000);

    await driver.close();
    const outcome = await prewarmOutcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.error as { runtimeCode?: string }).runtimeCode).toBe("CANCELLED");
    }
    expect(shutdownCalls).toBeGreaterThanOrEqual(1);
    expect(driver.capabilityState()).toBe("checking");
    expect(pgrepCount("fake-cld[.]mjs")).toBe(0);
  });

  it("AC4: close() during the pre-spawn (mkdir) window rejects CANCELLED and never spawns (F2a)", async () => {
    // F2a: pre-spawn had no closing guard — close() completing during the mkdir
    // await left the driver to spawn on a closed driver (late process adopted).
    // The post-mkdir guard must reject CANCELLED before spawnDriver is ever
    // called. Deterministic: prewarm's first suspension is the mkdir await, and
    // close() has no await when process===null && pendingSpawn===null, so the
    // close() CALL expression itself flips state to "closed" before mkdir's
    // microtask resolves.
    const events = new EventEmitter();
    const fakeProcess = makeFakeProcess("p-1", events);
    let spawnCount = 0;
    const { participantId, driver } = await buildSeamDriver(fakeProcess, () => {
      spawnCount += 1;
    });

    const prewarmOutcome = driver
      .prewarm({
        participantId,
        spec: makeSpec(participantId),
        installation: makeInstallation(),
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    // prewarm is parked at the mkdir await; spawnDriver has NOT been called yet.
    expect(spawnCount).toBe(0);
    // Synchronously flip state to "closed" (no process, no pendingSpawn → no
    // await in close). The returned promise is awaited after prewarm settles.
    const closePromise = driver.close();
    const outcome = await prewarmOutcome;
    await closePromise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.error as { runtimeCode?: string }).runtimeCode).toBe("CANCELLED");
    }
    // The spawn was never reached — no process adopted, no leak (P1/F2a).
    expect(spawnCount).toBe(0);
    expect(driver.capabilityState()).toBe("checking");
    expect(pgrepCount("fake-cld[.]mjs")).toBe(0);
  });
});

/**
 * CK-ROT-001 — a cancel the Host accepts (POST .../cancel returns
 * state=cancelling) during the claude-stream-json safe-retry respawn window
 * must abort the execution: attempt 2 must not dispatch the user frame, and the
 * execution must terminate as interrupted(user_cancelled). In-memory seam: the
 * respawn spawn is gated so cancel is provably called while the spawn is
 * pending (activeTurn null, cancellingExecutions latched), then the gate is
 * released — deterministic, no timing race.
 */
describe("claude-stream-json driver CK-ROT-001 cancel during respawn", () => {
  /** A DriverProcess variant that handshakes: responds to a control_request
   * initialize on stdin by pushing a control_response success frame (with a
   * default-bearing model catalog) to its stdout Readable. Mirrors makeFakeProcess
   * but adds the stdout handshake response. stdin lines are collected for the
   * "no user frame" assertion. */
  function makeHandshakingProcess(
    participantId: string,
    events: EventEmitter,
    stdinLines: string[],
    onShutdown?: () => void,
  ): DriverProcess {
    const stdout = new Readable({ read() {} });
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.length === 0) continue;
          stdinLines.push(line);
          try {
            const frame = JSON.parse(line) as Record<string, unknown>;
            if (frame.type === "control_request") {
              const request = frame.request as Record<string, unknown> | undefined;
              if (request?.subtype === "initialize") {
                const responseFrame = JSON.stringify({
                  type: "control_response",
                  response: {
                    request_id: frame.request_id,
                    subtype: "success",
                    response: {
                      models: [{ value: "default", resolvedModel: MODEL_ID }],
                    },
                  },
                });
                stdout.push(`${responseFrame}\n`);
              }
            }
          } catch {
            // non-JSON line — ignore
          }
        }
        callback();
      },
    });
    return {
      participantId,
      pid: -1,
      pgid: -1,
      watchdogPid: -1,
      stdin,
      stdout,
      stderr: new Readable({ read() {} }),
      events,
      waitSupervised: () => Promise.resolve(),
      kill: () => {},
      closeStdin: () => {},
      shutdown: () =>
        new Promise<void>((resolveShutdown) => {
          setTimeout(() => {
            onShutdown?.();
            resolveShutdown();
          }, 0);
        }),
      __testInjectControlLine: () => {},
    };
  }

  it("CK-ROT-001: cancel during safe-retry respawn window aborts before attempt 2 dispatches", async () => {
    const participantId = "p-1";

    // First process: handshakes, then is killed (host view: crash while idle).
    const firstEvents = new EventEmitter();
    const firstStdin: string[] = [];
    const firstProcess = makeHandshakingProcess(participantId, firstEvents, firstStdin);

    // Second process: handshakes; reached only when the respawn gate is released.
    const secondEvents = new EventEmitter();
    const secondStdin: string[] = [];
    const secondProcess = makeHandshakingProcess(participantId, secondEvents, secondStdin);

    let spawnCount = 0;
    let spawnImplCalls = 0;
    let releaseRespawn: () => void = () => {};
    const spawnImpl = (): Promise<DriverProcess> => {
      spawnImplCalls += 1;
      if (spawnImplCalls === 1) {
        return Promise.resolve(firstProcess);
      }
      // Call 2+ (respawn): gated — resolves only when releaseRespawn() fires.
      return new Promise<DriverProcess>((resolveSpawn) => {
        releaseRespawn = () => resolveSpawn(secondProcess);
      });
    };
    const { driver } = await buildSeamDriver(
      firstProcess,
      () => {
        spawnCount += 1;
      },
      spawnImpl,
    );

    // prewarm: first process handshakes (responds to initialize). spawnCount===1.
    await driver.prewarm({
      participantId,
      spec: makeSpec(participantId),
      installation: makeInstallation(),
    });
    expect(spawnCount).toBe(1);

    // Kill the first process externally (host view: driver crash while idle).
    firstEvents.emit("exit", { code: null, signal: "SIGKILL" });
    await waitFor(() => driver.sessionEpoch === 1, 5000);

    // Start execute: attempt 1 fires the pre-dispatch guard synchronously
    // (process null), emitWrapper swallows the failed event, respawn begins.
    const run = executeCollecting(driver, execInput("exec-1", "Cancel during respawn."));

    // Wait for the respawn spawn to be initiated. The gated Promise is pending
    // — respawn is stuck at the spawn await, activeTurn is null.
    await waitFor(() => spawnCount === 2, 5000);

    // Cancel during respawn: cancellingExecutions latches the executionId;
    // activeTurn is null so cancel returns immediately (no hang).
    await driver.cancel("exec-1");

    // Release the gate: the second process resolves, handshakes, state="ready".
    // The retry loop iterates to attempt 2, the gate fires, emits
    // interrupted(user_cancelled) to the outer emit, and returns.
    releaseRespawn();
    await run.done;

    // Terminal: interrupted(user_cancelled, not_dispatched).
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("interrupted");
    if (terminal.type !== "interrupted") throw new Error("unreachable");
    expect(terminal.reason).toBe("user_cancelled");
    expect(terminal.dispatchState).toBe("not_dispatched");

    // The respawned (second) process's stdin NEVER received a user frame —
    // only the control_request initialize for the handshake.
    expect(secondStdin.some((line) => line.includes('"type":"user"'))).toBe(false);
    expect(secondStdin.some((line) => line.includes('"subtype":"initialize"'))).toBe(true);

    // The latched cancel flag is cleaned up by execute().finally.
    expect(pgrepCount("fake-cld[.]mjs")).toBe(0);
  });
});
