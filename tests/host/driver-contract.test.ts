import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "@host/config";
import { createClaudeStreamJsonDriver } from "@host/drivers/claude-stream-json";
import { createCodexAppServerDriver } from "@host/drivers/codex-app-server";
import { createKimiStreamJsonDriver } from "@host/drivers/kimi-stream-json";
import type {
  DriverDeps,
  DriverEvent,
  DriverTimeouts,
  ExecuteInput,
  ParticipantDriver,
  PrewarmResult,
} from "@host/drivers/types";
import type { InstallationRecord } from "@host/installations/registry";
import { type Logger, createLogger } from "@host/logging";
import { type ProcessSupervisor, createProcessSupervisor } from "@host/process/process-supervisor";
import type { ParticipantSpec } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Shared behavioral contract for the two V1 Participant Drivers, run against
 * the REAL driver factories and the REAL process supervisor. The supervised
 * process is `node <fixture>.mjs` (shebang executable; the driver's own argv
 * is appended and ignored by the fixture).
 *
 * Scenario control: the supervisor's environment hygiene makes it impossible
 * to pass FIXTURE_* env vars through the real drivers (envInherit allowlist +
 * fixed envSet), so fixtures read `fake-driver-config.json` from their
 * Participant-dedicated cwd — which is exactly this test's `work` directory.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const WATCHDOG_PROGRAM = join(repoRoot, "runtime-host/process/watchdog-child.mjs");
const FAKE_CLD = join(repoRoot, "tests/fixtures/drivers/fake-cld.mjs");
const FAKE_CODEX = join(repoRoot, "tests/fixtures/drivers/fake-codex-app-server.mjs");
const FAKE_KIMI = join(repoRoot, "tests/fixtures/drivers/fake-kimi.mjs");
const FINGERPRINT = "f".repeat(64);

const BASE_TIMEOUTS: DriverTimeouts = {
  handshakeMs: 8000,
  dispatchAckMs: 1500,
  streamIdleMs: 3000,
  turnMs: 15000,
  interruptGraceMs: 800,
  shutdownGraceMs: 3000,
};

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

let tempRoot = "";
let supervisors: ProcessSupervisor[] = [];
let drivers: ParticipantDriver[] = [];

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "councilkit-driver-contract-"));
});

afterEach(async () => {
  for (const driver of drivers) await driver.close().catch(() => undefined);
  drivers = [];
  for (const supervisor of supervisors) await supervisor.shutdownAll(300).catch(() => undefined);
  supervisors = [];
  // Hard requirement: no fixture or watchdog processes survive the test file.
  await waitFor(
    () =>
      pgrepCount("fake-cld[.]mjs") === 0 &&
      pgrepCount("fake-codex-app-server[.]mjs") === 0 &&
      pgrepCount("fake-kimi[.]mjs") === 0 &&
      pgrepCount("watchdog-child[.]mjs") === 0,
    5000,
  ).catch(() => undefined);
  expect(pgrepCount("fake-cld[.]mjs")).toBe(0);
  expect(pgrepCount("fake-codex-app-server[.]mjs")).toBe(0);
  expect(pgrepCount("fake-kimi[.]mjs")).toBe(0);
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

/** Writes the fixture config into the Participant-dedicated driver cwd. */
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
  decisions: unknown[];
  pids: number[];
}

/** Sums the per-pid stats files (`stats.<pid>`) written by the fixtures. */
function aggregateStats(): AggregatedStats {
  const counts: Record<string, number> = {};
  const decisions: unknown[] = [];
  const pids: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(tempRoot);
  } catch {
    return { counts, decisions, pids };
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
        if (key === "pid") continue;
        if (typeof value === "number") counts[key] = (counts[key] ?? 0) + value;
        if (key === "approvalDecisions" && Array.isArray(value)) decisions.push(...value);
      }
    } catch {
      // A racing rewrite is atomic (tmp+rename); ignore anything else.
    }
  }
  return { counts, decisions, pids };
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

function deltaTextOf(events: DriverEvent[]): string {
  return events.map((event) => (event.type === "output.delta" ? event.text : "")).join("");
}

function deltaCountOf(events: DriverEvent[]): number {
  return events.filter((event) => event.type === "output.delta").length;
}

// ---------------------------------------------------------------------------
// Per-driver scenario parameterization
// ---------------------------------------------------------------------------

interface DriverScenario {
  label: string;
  driverId: "claude-stream-json" | "codex-app-server" | "kimi-stream-json";
  modelId: string;
  reply: string;
  /** Fixture config that crashes the process mid-turn. */
  crashConfig: Record<string, unknown>;
  /** Fixture config that injects unknown frames/notifications. */
  unknownConfig: Record<string, unknown>;
  /** dispatchStates the driver's crash terminal may legitimately carry. */
  crashDispatchStates: string[];
  expectedPrewarmCounts: Record<string, number>;
  expectedCatalog: string[];
  expectedAliases: string[];
  /** claude emits a standalone usage event per turn; codex rides on completed. */
  emitsStandaloneUsage: boolean;
  /** Streaming model: claude/codex stream deltas (final-only for kimi). */
  preview: "streaming" | "final-only";
  /** Process model: claude/codex are long-lived; kimi is per-turn. */
  processModel: "persistent" | "per-turn";
  /** Usage reporting: standalone / completed / none. */
  usage: "standalone" | "completed" | "none";
  /** Expected per-turn (diffed, never cumulative) input tokens. */
  turnInputTokens(prompt: string, turnIndex: number): number;
  makeDriver(deps: DriverDeps, participantId: string): ParticipantDriver;
  makeSpec(participantId: string): ParticipantSpec;
  makeInstallation(): InstallationRecord;
}

const claudeScenario: DriverScenario = {
  label: "claude-stream-json",
  driverId: "claude-stream-json",
  modelId: "GLM-5.2[1m]",
  reply: "Fake cld answer.",
  crashConfig: { crashAfterReplay: true },
  unknownConfig: { unknownFrames: true },
  // The replay echo usually lands first (accepted); a fast exit may win (unknown).
  crashDispatchStates: ["accepted", "unknown"],
  expectedPrewarmCounts: { initializes: 1 },
  expectedCatalog: ["GLM-5.2[1m]"],
  expectedAliases: ["default"],
  emitsStandaloneUsage: true,
  preview: "streaming",
  processModel: "persistent",
  usage: "standalone",
  turnInputTokens: (prompt) => 100 + prompt.length,
  makeDriver: (deps, participantId) => createClaudeStreamJsonDriver(deps)(participantId),
  makeSpec: (participantId) => ({
    participantId,
    profile: {
      driverId: "claude-stream-json",
      installationId: "fake-cld",
      credentialMode: "installation-managed",
      options: { route: "ant-glm5.2" },
    },
    modelId: "GLM-5.2[1m]",
  }),
  makeInstallation: () => ({
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
  }),
};

const codexScenario: DriverScenario = {
  label: "codex-app-server",
  driverId: "codex-app-server",
  modelId: "gpt-5.6-sol",
  reply: "Fake codex answer.",
  crashConfig: { crashAfterTurnStart: true },
  unknownConfig: { unknownNotifications: true },
  // turn/start is never answered before the crash: bytes left, state unknown.
  crashDispatchStates: ["unknown"],
  expectedPrewarmCounts: { initializes: 1, accountReads: 1, modelLists: 1, threadStarts: 1 },
  expectedCatalog: ["gpt-5.6-sol", "gpt-5.5"],
  expectedAliases: [],
  emitsStandaloneUsage: false,
  preview: "streaming",
  processModel: "persistent",
  usage: "completed",
  turnInputTokens: (_prompt, turnIndex) => 501 + turnIndex,
  makeDriver: (deps, participantId) => createCodexAppServerDriver(deps)(participantId),
  makeSpec: (participantId) => ({
    participantId,
    profile: {
      driverId: "codex-app-server",
      installationId: "fake-codex",
      credentialMode: "installation-managed",
      options: {},
    },
    modelId: "gpt-5.6-sol",
  }),
  makeInstallation: () => ({
    installationId: "fake-codex",
    driverId: "codex-app-server",
    name: "codex",
    discoveredPath: FAKE_CODEX,
    realpath: FAKE_CODEX,
    fingerprint: FINGERPRINT,
    state: "trusted",
    components: [{ role: "wrapper", path: FAKE_CODEX, fingerprint: FINGERPRINT }],
    detail: null,
  }),
};

interface Rig {
  driver: ParticipantDriver;
  logger: Logger;
  supervisor: ProcessSupervisor;
  participantId: string;
  prewarmResult: PrewarmResult;
}

async function createRig(
  scenario: DriverScenario,
  options: { config?: Record<string, unknown>; timeouts?: Partial<DriverTimeouts> } = {},
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
  const driver = scenario.makeDriver(deps, participantId);
  drivers.push(driver);
  await writeFixtureConfig(participantId, options.config ?? {});
  const prewarmResult = await driver.prewarm({
    participantId,
    spec: scenario.makeSpec(participantId),
    installation: scenario.makeInstallation(),
  });
  return { driver, logger, supervisor, participantId, prewarmResult };
}

function execInput(scenario: DriverScenario, executionId: string, prompt: string): ExecuteInput {
  return { executionId, prompt, modelId: scenario.modelId, coldStart: executionId === "exec-1" };
}

// ---------------------------------------------------------------------------
// The contract, once per driver
// ---------------------------------------------------------------------------

for (const scenario of [claudeScenario, codexScenario]) {
  describe(`driver contract: ${scenario.label}`, () => {
    it("prewarm handshakes the live process once and is idempotent", async () => {
      const rig = await createRig(scenario);
      expect(rig.driver.sessionEpoch).toBe(0);
      expect(rig.prewarmResult.canonicalModelId).toBe(scenario.modelId);
      expect(rig.prewarmResult.modelAliases).toEqual(scenario.expectedAliases);
      expect(rig.prewarmResult.catalog).toEqual(scenario.expectedCatalog);
      expect(rig.prewarmResult.capability.protocol).toBe(scenario.driverId);

      const stats = aggregateStats();
      for (const [key, value] of Object.entries(scenario.expectedPrewarmCounts)) {
        expect(stats.counts[key], `stats.${key}`).toBe(value);
      }
      expect(stats.pids).toHaveLength(1);
      expect(rig.supervisor.liveCount()).toBe(1);

      // Idempotent: a second prewarm reuses the live process, no re-handshake.
      const again = await rig.driver.prewarm({
        participantId: rig.participantId,
        spec: scenario.makeSpec(rig.participantId),
        installation: scenario.makeInstallation(),
      });
      expect(again.canonicalModelId).toBe(scenario.modelId);
      const after = aggregateStats();
      expect(after.pids).toHaveLength(1);
      for (const [key, value] of Object.entries(scenario.expectedPrewarmCounts)) {
        expect(after.counts[key], `stats.${key} after re-prewarm`).toBe(value);
      }
      expect(rig.supervisor.liveCount()).toBe(1);
      expect(rig.driver.sessionEpoch).toBe(0);
    });

    it("runs two sequential turns on one session with streaming deltas and per-turn usage", async () => {
      const rig = await createRig(scenario);
      const prompt1 = "First prompt.";
      const prompt2 = "Second prompt here.";

      const run1 = executeCollecting(rig.driver, execInput(scenario, "exec-1", prompt1));
      await run1.done;
      const completed1 = terminalOf(run1.events);
      expect(completed1.type).toBe("completed");
      if (completed1.type !== "completed") throw new Error("unreachable");
      expect(completed1.output).toBe(scenario.reply);
      expect(completed1.dispatchState).toBe("accepted");
      expect(completed1.modelVerdict).toBe("match");
      expect(completed1.requestedModel).toBe(scenario.modelId);
      expect(completed1.effectiveModel).toBe(scenario.modelId);
      expect(typeof completed1.finalSeq).toBe("number"); // registry re-stamps
      expect(deltaCountOf(run1.events)).toBeGreaterThanOrEqual(2);
      expect(deltaTextOf(run1.events)).toBe(scenario.reply);
      expect(completed1.usage?.inputTokens).toBe(scenario.turnInputTokens(prompt1, 0));
      expect(completed1.usage?.outputTokens).toBe(scenario.reply.length);

      const run2 = executeCollecting(rig.driver, execInput(scenario, "exec-2", prompt2));
      await run2.done;
      const completed2 = terminalOf(run2.events);
      expect(completed2.type).toBe("completed");
      if (completed2.type !== "completed") throw new Error("unreachable");
      expect(completed2.output).toBe(scenario.reply);
      expect(deltaCountOf(run2.events)).toBeGreaterThanOrEqual(2);
      expect(deltaTextOf(run2.events)).toBe(scenario.reply);

      // Per-turn DIFF usage, never cumulative across the session.
      const expected2 = scenario.turnInputTokens(prompt2, 1);
      expect(completed2.usage?.inputTokens).toBe(expected2);
      expect(completed2.usage?.outputTokens).toBe(scenario.reply.length);
      expect(completed2.usage?.inputTokens).not.toBe(
        scenario.turnInputTokens(prompt1, 0) + expected2,
      );
      const usageEvents2 = usageEventsOf(run2.events);
      if (scenario.emitsStandaloneUsage) {
        expect(usageEvents2).toHaveLength(1);
        expect(usageEvents2[0]?.usage.inputTokens).toBe(expected2);
        expect(usageEvents2[0]?.usage.outputTokens).toBe(scenario.reply.length);
      } else {
        expect(usageEvents2).toHaveLength(0);
      }

      // Session reuse: still one process, no second handshake.
      const stats = aggregateStats();
      expect(stats.pids).toHaveLength(1);
      for (const [key, value] of Object.entries(scenario.expectedPrewarmCounts)) {
        expect(stats.counts[key], `stats.${key} after two turns`).toBe(value);
      }
      expect(
        stats.counts[scenario.driverId === "claude-stream-json" ? "userMessages" : "turnStarts"],
      ).toBe(2);
      expect(rig.driver.sessionEpoch).toBe(0);
    });

    it("cancel mid-stream ends the turn user_cancelled and the driver stays usable", async () => {
      const rig = await createRig(scenario, { config: { deltaDelayMs: 200 } });
      const run = executeCollecting(rig.driver, execInput(scenario, "exec-1", "Cancel me."));
      await waitFor(() => run.events.some((event) => event.type === "output.delta"), 5000);
      await rig.driver.cancel("exec-1");
      await run.done;
      const terminal = terminalOf(run.events);
      expect(terminal.type).toBe("interrupted");
      if (terminal.type !== "interrupted") throw new Error("unreachable");
      expect(terminal.reason).toBe("user_cancelled");

      // Graceful interrupt: the same process and session survive.
      const stats = aggregateStats();
      expect(stats.counts.interrupts).toBe(1);
      expect(stats.pids).toHaveLength(1);
      expect(rig.driver.sessionEpoch).toBe(0);

      await writeFixtureConfig(rig.participantId, {});
      const run2 = executeCollecting(rig.driver, execInput(scenario, "exec-2", "Again."));
      await run2.done;
      expect(terminalOf(run2.events).type).toBe("completed");
    });

    it("close() tears the session down; a later execute fails not_dispatched without a respawn", async () => {
      const rig = await createRig(scenario);
      const epochBefore = rig.driver.sessionEpoch;
      await rig.driver.close();
      expect(rig.driver.sessionEpoch).toBe(epochBefore + 1);

      const run = executeCollecting(rig.driver, execInput(scenario, "exec-1", "Too late."));
      await run.done;
      const terminal = terminalOf(run.events);
      expect(terminal.type).toBe("failed");
      if (terminal.type !== "failed") throw new Error("unreachable");
      expect(terminal.error.code).toBe("DRIVER_CRASH");
      expect(terminal.dispatchState).toBe("not_dispatched");
      // Exactly one visible terminal: claude's swallowed safe-retry attempt
      // cannot respawn a closed driver; codex never retries in place.
      expect(run.events.filter((event) => event.type === "failed")).toHaveLength(1);
      const stats = aggregateStats();
      expect(stats.pids).toHaveLength(1); // no respawn happened
      expect(stats.counts.initializes).toBe(1);
    });

    it("a process crash mid-turn terminates the execution and bumps sessionEpoch", async () => {
      const rig = await createRig(scenario, { config: scenario.crashConfig });
      const run = executeCollecting(rig.driver, execInput(scenario, "exec-1", "Crash soon."));
      await run.done;
      const terminal = terminalOf(run.events);
      expect(terminal.type).toBe("failed");
      if (terminal.type !== "failed") throw new Error("unreachable");
      expect(terminal.error.code).toBe("DRIVER_CRASH");
      expect(scenario.crashDispatchStates).toContain(terminal.dispatchState);
      expect(terminal.retryable).toBe(false);
      expect(rig.driver.sessionEpoch).toBeGreaterThanOrEqual(1);
      // No self-initiated respawn after a mid-turn crash.
      expect(aggregateStats().pids).toHaveLength(1);
    });

    it("ignores unknown protocol frames and completes the turn", async () => {
      const rig = await createRig(scenario, { config: scenario.unknownConfig });
      const run = executeCollecting(rig.driver, execInput(scenario, "exec-1", "Weird frames."));
      await run.done;
      expect(terminalOf(run.events).type).toBe("completed");
      expect(deltaTextOf(run.events)).toBe(scenario.reply);
      if (scenario.driverId === "claude-stream-json") {
        // Unknown claude frames are ignored but MUST leave a diagnostic trace.
        expect(
          rig.logger.diagnostics().some((entry) => entry.kind === "claude.unknown_frame"),
        ).toBe(true);
      }
    });

    it("keeps sessionEpoch constant across healthy turns", async () => {
      const rig = await createRig(scenario);
      expect(rig.driver.sessionEpoch).toBe(0);
      const run1 = executeCollecting(rig.driver, execInput(scenario, "exec-1", "One."));
      await run1.done;
      expect(terminalOf(run1.events).type).toBe("completed");
      expect(rig.driver.sessionEpoch).toBe(0);
      const run2 = executeCollecting(rig.driver, execInput(scenario, "exec-2", "Two."));
      await run2.done;
      expect(terminalOf(run2.events).type).toBe("completed");
      expect(rig.driver.sessionEpoch).toBe(0);
    });
  });
}

// ---------------------------------------------------------------------------
// kimi-stream-json: per-turn process model (D2 constraint — NOT a long-lived
// pretense). The shared claude/codex loop assumes streaming + a single PID,
// so Kimi gets its own scenario + contract asserting the FINAL-ONLY, per-turn,
// usage=null shape: two turns are TWO pids with the same -S session id, epoch
// stays stable across healthy turns, and cancel clears the session.
// ---------------------------------------------------------------------------

const KIMI_MODEL = "kimi-code/k3";
const kimiScenario: DriverScenario = {
  label: "kimi-stream-json",
  driverId: "kimi-stream-json",
  modelId: KIMI_MODEL,
  reply: "Fake kimi answer.",
  crashConfig: { crashAfterAssistant: true },
  unknownConfig: { badJson: true },
  crashDispatchStates: ["accepted"],
  expectedPrewarmCounts: { providerLists: 1 },
  expectedCatalog: [KIMI_MODEL],
  expectedAliases: [],
  emitsStandaloneUsage: false,
  preview: "final-only",
  processModel: "per-turn",
  usage: "none",
  turnInputTokens: () => 0,
  makeDriver: (deps, participantId) => createKimiStreamJsonDriver(deps)(participantId),
  makeSpec: (participantId) => ({
    participantId,
    profile: {
      driverId: "kimi-stream-json",
      installationId: "fake-kimi",
      credentialMode: "installation-managed",
      options: {},
    },
    modelId: KIMI_MODEL,
  }),
  makeInstallation: () => ({
    installationId: "fake-kimi",
    driverId: "kimi-stream-json",
    name: "kimi",
    discoveredPath: FAKE_KIMI,
    realpath: FAKE_KIMI,
    fingerprint: FINGERPRINT,
    state: "trusted",
    components: [{ role: "wrapper", path: FAKE_KIMI, fingerprint: FINGERPRINT }],
    detail: null,
  }),
};

describe("driver contract: kimi-stream-json (per-turn, final-only)", () => {
  it("prewarm handshakes provider list once, returns the K3 closed catalog", async () => {
    const rig = await createRig(kimiScenario);
    expect(rig.driver.sessionEpoch).toBe(0);
    expect(rig.prewarmResult.canonicalModelId).toBe(KIMI_MODEL);
    expect(rig.prewarmResult.catalog).toEqual([KIMI_MODEL]);
    expect(rig.prewarmResult.modelAliases).toEqual([]);
    expect(rig.prewarmResult.capability.protocol).toBe("kimi-stream-json");
    expect(rig.driver.contextWindowTokens()).toBe(1_048_576);
    const stats = aggregateStats();
    expect(stats.counts.providerLists).toBeGreaterThanOrEqual(1);
  });

  it("two turns are TWO pids resuming the same -S session; final-only, usage null, epoch stable", async () => {
    const rig = await createRig(kimiScenario, { config: { reply: "Per-turn resume." } });
    const run1 = executeCollecting(rig.driver, execInput(kimiScenario, "exec-1", "One."));
    await run1.done;
    const completed1 = terminalOf(run1.events);
    expect(completed1.type).toBe("completed");
    if (completed1.type !== "completed") throw new Error("unreachable");
    expect(completed1.output).toBe("Per-turn resume.");
    expect(run1.events.filter((e) => e.type === "output.delta")).toHaveLength(0);
    expect(completed1.usage).toBeNull();
    expect(completed1.modelVerdict).toBe("match");
    expect(completed1.toolState).toBe("none");
    expect(rig.driver.sessionEpoch).toBe(0);

    const run2 = executeCollecting(rig.driver, execInput(kimiScenario, "exec-2", "Two."));
    await run2.done;
    const completed2 = terminalOf(run2.events);
    expect(completed2.type).toBe("completed");
    if (completed2.type !== "completed") throw new Error("unreachable");
    expect(run2.events.filter((e) => e.type === "output.delta")).toHaveLength(0);
    expect(completed2.usage).toBeNull();
    expect(rig.driver.sessionEpoch).toBe(0);

    // Per-turn: two distinct pids; the second carried the -S resume id.
    const turnPids = aggregateStats()
      .pids.map((pid) => {
        const raw = readdirSync(tempRoot).includes(`stats.${pid}`)
          ? (JSON.parse(readFileSync(join(tempRoot, `stats.${pid}`), "utf8")) as Record<
              string,
              unknown
            >)
          : null;
        return raw && Number(raw.turns) > 0 ? raw : null;
      })
      .filter((s): s is Record<string, unknown> => s !== null);
    expect(turnPids.length).toBe(2);
    expect(new Set(turnPids.map((s) => s.pid)).size).toBe(2);
    const resumeIds = turnPids.flatMap((s) =>
      Array.isArray(s.resumeIds) ? (s.resumeIds as unknown[]) : [],
    );
    expect(resumeIds).toHaveLength(1);
  });

  it("cancel clears the session and bumps epoch (no long-lived process to keep)", async () => {
    const rig = await createRig(kimiScenario, { config: { delayMs: 400 } });
    const run = executeCollecting(rig.driver, execInput(kimiScenario, "exec-1", "Cancel."));
    await new Promise((r) => setTimeout(r, 80));
    await rig.driver.cancel("exec-1");
    await run.done;
    expect(terminalOf(run.events).type).toBe("interrupted");
    expect(rig.driver.sessionEpoch).toBeGreaterThanOrEqual(1);
  });
});
