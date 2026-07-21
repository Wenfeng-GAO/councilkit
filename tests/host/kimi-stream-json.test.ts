import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "@host/config";
import { createKimiStreamJsonDriver } from "@host/drivers/kimi-stream-json";
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

/**
 * kimi-stream-json driver专项 (plan-a §3.6.20 + D2 fast-exit 竞态). Runs the
 * REAL driver factory against the REAL process supervisor; the supervised
 * process is `node fake-kimi.mjs` (shebang; the driver's argv is appended).
 * Scenario control comes from `fake-driver-config.json` in the Participant cwd.
 *
 * Kimi is PER-TURN (one short-lived process per turn, resumed via -S) and
 * FINAL-ONLY (no streaming deltas; usage is null). These tests MUST NOT be
 * written as a long-lived-process pretense (D2): two turns are two PIDs, and
 * the second turn carries the same -S session id.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const WATCHDOG_PROGRAM = join(repoRoot, "runtime-host/process/watchdog-child.mjs");
const FAKE_KIMI = join(repoRoot, "tests/fixtures/drivers/fake-kimi.mjs");
const FINGERPRINT = "f".repeat(64);
const MODEL = "kimi-code/k3";

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
  tempRoot = await mkdtemp(join(tmpdir(), "councilkit-kimi-"));
});

afterEach(async () => {
  for (const driver of drivers) await driver.close().catch(() => undefined);
  drivers = [];
  for (const supervisor of supervisors) await supervisor.shutdownAll(300).catch(() => undefined);
  supervisors = [];
  await waitFor(
    () => pgrepCount("fake-kimi[.]mjs") === 0 && pgrepCount("watchdog-child[.]mjs") === 0,
    5000,
  ).catch(() => undefined);
  expect(pgrepCount("fake-kimi[.]mjs")).toBe(0);
  expect(pgrepCount("watchdog-child[.]mjs")).toBe(0);
  await rm(tempRoot, { recursive: true, force: true });
});

function pgrepCount(pattern: string): number {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
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
    await new Promise((r) => setTimeout(r, intervalMs));
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

function aggregatePids(): number[] {
  const pids: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(tempRoot);
  } catch {
    return pids;
  }
  for (const name of names) {
    if (!name.startsWith("stats.") || name.endsWith(".tmp")) continue;
    const pid = Number(name.slice("stats.".length));
    if (Number.isInteger(pid)) pids.push(pid);
  }
  return pids;
}

function statsOf(pid: number): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(tempRoot, `stats.${pid}`), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function makeSpec(participantId: string): ParticipantSpec {
  return {
    participantId,
    profile: {
      driverId: "kimi-stream-json",
      installationId: "fake-kimi",
      credentialMode: "installation-managed",
      options: {},
    },
    modelId: MODEL,
  };
}

function makeInstallation(): InstallationRecord {
  return {
    installationId: "fake-kimi",
    driverId: "kimi-stream-json",
    name: "kimi",
    discoveredPath: FAKE_KIMI,
    realpath: FAKE_KIMI,
    fingerprint: FINGERPRINT,
    state: "trusted",
    components: [{ role: "wrapper", path: FAKE_KIMI, fingerprint: FINGERPRINT }],
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
  const driver = createKimiStreamJsonDriver(deps)(participantId);
  drivers.push(driver);
  await writeFixtureConfig(participantId, config);
  await driver.prewarm({
    participantId,
    spec: makeSpec(participantId),
    installation: makeInstallation(),
  });
  return driver;
}

function execInput(executionId: string, prompt: string): ExecuteInput {
  return { executionId, prompt, modelId: MODEL, coldStart: executionId === "exec-1" };
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

describe("kimi-stream-json driver", () => {
  it("prewarm: closed catalog K3, canonical, capability, context window; rejects non-Kimi profiles", async () => {
    const driver = await createDriver();
    // prewarm already ran in createDriver; re-run to assert idempotent shape.
    const prewarm = await driver.prewarm({
      participantId: "p-1",
      spec: makeSpec("p-1"),
      installation: makeInstallation(),
    });
    expect(prewarm.canonicalModelId).toBe(MODEL);
    expect(prewarm.catalog).toEqual([MODEL]);
    expect(prewarm.modelAliases).toEqual([]);
    expect(prewarm.capability.protocol).toBe("kimi-stream-json");
    expect(prewarm.capability.outputMode).toBe("final-only");
    expect(prewarm.capability.sessionResume).toBe(true);
    expect(driver.contextWindowTokens()).toBe(1_048_576);
    expect(driver.capabilityState()).toBe("ready");

    // provider list probe ran once across both prewarms (the first one in
    // createDriver). The stats file records providerLists.
    const pids = aggregatePids();
    expect(pids.length).toBeGreaterThanOrEqual(1);
    const providerLists = pids
      .map(statsOf)
      .filter(Boolean)
      .reduce((sum, s) => sum + Number((s as Record<string, unknown>).providerLists ?? 0), 0);
    expect(providerLists).toBeGreaterThanOrEqual(1);
  });

  it("prewarm rejects a non-kimi profile with PROFILE_INVALID", async () => {
    const driver = await createDriver();
    const wrongSpec: ParticipantSpec = {
      participantId: "p-1",
      profile: {
        driverId: "codex-app-server",
        installationId: "fake-kimi",
        credentialMode: "installation-managed",
        options: {},
      },
      modelId: MODEL,
    };
    await expect(
      driver.prewarm({ participantId: "p-1", spec: wrongSpec, installation: makeInstallation() }),
    ).rejects.toMatchObject({ runtimeCode: "PROFILE_INVALID" });
  });

  it("prewarm rejects an out-of-catalog model with MODEL_UNAVAILABLE + catalog", async () => {
    // Fresh driver; manipulate the spec's modelId to a non-K3 value.
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
      timeouts: BASE_TIMEOUTS,
      workRoot: join(tempRoot, "work"),
    };
    const driver = createKimiStreamJsonDriver(deps)("p-wrong");
    drivers.push(driver);
    await writeFixtureConfig("p-wrong", {});
    const spec: ParticipantSpec = {
      participantId: "p-wrong",
      profile: {
        driverId: "kimi-stream-json",
        installationId: "fake-kimi",
        credentialMode: "installation-managed",
        options: {},
      },
      modelId: "kimi-code/not-a-model",
    };
    await expect(
      driver.prewarm({ participantId: "p-wrong", spec, installation: makeInstallation() }),
    ).rejects.toMatchObject({ runtimeCode: "MODEL_UNAVAILABLE", catalog: [MODEL] });
  });

  it("first turn captures resume hint; second turn resumes via -S and uses a SECOND pid (per-turn, final-only)", async () => {
    const driver = await createDriver({ reply: "Two turns one session." });
    expect(driver.sessionEpoch).toBe(0);

    const run1 = executeCollecting(driver, execInput("exec-1", "First prompt."));
    await run1.done;
    const completed1 = terminalOf(run1.events);
    expect(completed1.type).toBe("completed");
    if (completed1.type !== "completed") throw new Error("unreachable");
    expect(completed1.output).toBe("Two turns one session.");
    // final-only: no fabricated deltas.
    expect(run1.events.filter((e) => e.type === "output.delta")).toHaveLength(0);
    expect(completed1.usage).toBeNull();
    expect(completed1.modelVerdict).toBe("match");
    expect(completed1.effectiveModel).toBe(MODEL);
    expect(completed1.toolState).toBe("unknown");
    expect(completed1.dispatchState).toBe("accepted");

    // Session resumed on turn 2: epoch stays 0 (healthy turn).
    expect(driver.sessionEpoch).toBe(0);
    const run2 = executeCollecting(driver, execInput("exec-2", "Second prompt."));
    await run2.done;
    const completed2 = terminalOf(run2.events);
    expect(completed2.type).toBe("completed");
    if (completed2.type !== "completed") throw new Error("unreachable");
    expect(completed2.output).toBe("Two turns one session.");
    expect(run2.events.filter((e) => e.type === "output.delta")).toHaveLength(0);
    expect(completed2.usage).toBeNull();
    expect(driver.sessionEpoch).toBe(0);

    // Per-turn process model (D2): two turns = TWO distinct pids, not one.
    const pids = aggregatePids();
    const turnPids = pids
      .map(statsOf)
      .filter((s): s is Record<string, unknown> => s !== null && Number(s.turns) > 0);
    expect(turnPids.length).toBe(2);
    expect(new Set(turnPids.map((s) => s.pid)).size).toBe(2);
    // Turn 2 carried the -S resume id captured from turn 1.
    const resumeIds = turnPids.flatMap((s) => (Array.isArray(s.resumeIds) ? s.resumeIds : []));
    expect(resumeIds.length).toBe(1); // only the resume turn carries a -S
    expect(resumeIds[0]).toMatch(/^session-fake-1$/);
    // Both turns pinned -m kimi-code/k3 and used an empty --skills-dir.
    for (const s of turnPids) {
      expect(s.models).toContain(MODEL);
      expect(s.usedSkillsDir).toBe(true);
    }
  });

  it("first turn missing the resume hint -> INCOMPATIBLE_DRIVER + epoch bump", async () => {
    const driver = await createDriver({ noResumeHint: true });
    const run = executeCollecting(driver, execInput("exec-1", "No hint."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("INCOMPATIBLE_DRIVER");
    expect(terminal.dispatchState).toBe("accepted");
    expect(driver.sessionEpoch).toBeGreaterThanOrEqual(1);
  });

  it("empty assistant output -> EMPTY_OUTPUT", async () => {
    const driver = await createDriver({ emptyAssistant: true });
    const run = executeCollecting(driver, execInput("exec-1", "Empty."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("EMPTY_OUTPUT");
  });

  it("non-zero exit (not a resume-miss) -> DRIVER_CRASH + epoch bump", async () => {
    const driver = await createDriver({ crashAfterAssistant: true });
    const run = executeCollecting(driver, execInput("exec-1", "Crash after answer."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("DRIVER_CRASH");
    expect(driver.sessionEpoch).toBeGreaterThanOrEqual(1);
  });

  it("resume-miss (resume turn, Session not found) -> retryable not_dispatched + epoch bump, no in-place retry", async () => {
    const driver = await createDriver({ resumeMiss: true });
    // Turn 1 succeeds and captures a resume hint.
    const run1 = executeCollecting(driver, execInput("exec-1", "Seed turn."));
    await run1.done;
    expect(terminalOf(run1.events).type).toBe("completed");
    // Turn 2 (resume) misses: exactly one failed terminal, not_dispatched, retryable.
    const run2 = executeCollecting(driver, execInput("exec-2", "Resume miss."));
    await run2.done;
    const failures = run2.events.filter((e) => e.type === "failed");
    expect(failures).toHaveLength(1);
    const failed = failures[0];
    if (!failed || failed.type !== "failed") throw new Error("unreachable");
    expect(failed.error.code).toBe("DRIVER_CRASH");
    expect(failed.dispatchState).toBe("not_dispatched");
    expect(failed.retryable).toBe(true);
    expect(driver.sessionEpoch).toBeGreaterThanOrEqual(1);
    // No in-place retry: exactly one turn-2 spawn happened.
    const turn2Pids = aggregatePids()
      .map(statsOf)
      .filter(
        (s): s is Record<string, unknown> => s !== null && Number(s.turns) > 0 && s.hadSid === true,
      );
    expect(turn2Pids.length).toBe(1);
  });

  it("cancel mid-turn ends user_cancelled, clears session + bumps epoch", async () => {
    const driver = await createDriver({ delayMs: 400 });
    const run = executeCollecting(driver, execInput("exec-1", "Cancel me."));
    // Let the spawn start, then cancel before it completes.
    await new Promise((r) => setTimeout(r, 80));
    await driver.cancel("exec-1");
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("interrupted");
    if (terminal.type !== "interrupted") throw new Error("unreachable");
    expect(terminal.reason).toBe("user_cancelled");
    expect(driver.sessionEpoch).toBeGreaterThanOrEqual(1);
  });

  it("idle hang -> STREAM_IDLE_TIMEOUT", async () => {
    const driver = await createDriver({ hang: true });
    const run = executeCollecting(driver, execInput("exec-1", "Hang."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("STREAM_IDLE_TIMEOUT");
  });

  it("malformed JSON line is ignored; the turn still completes via the assistant frame", async () => {
    const driver = await createDriver({ badJson: true });
    const run = executeCollecting(driver, execInput("exec-1", "Bad json line."));
    await run.done;
    expect(terminalOf(run.events).type).toBe("completed");
  });

  it("close() bumps epoch and is closed; a later execute fails not_dispatched without respawn", async () => {
    const driver = await createDriver();
    const epochBefore = driver.sessionEpoch;
    await driver.close();
    expect(driver.sessionEpoch).toBe(epochBefore + 1);
    const run = executeCollecting(driver, execInput("exec-1", "Too late."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.dispatchState).toBe("not_dispatched");
    // No respawn: no turn process was spawned after close.
    const turnPids = aggregatePids()
      .map(statsOf)
      .filter((s): s is Record<string, unknown> => s !== null && Number(s.turns) > 0);
    expect(turnPids).toHaveLength(0);
  });

  it("E2BIG guard: a >200KB prompt fails PROTOCOL_LIMIT not_dispatched before spawn", async () => {
    const driver = await createDriver();
    const huge = "x".repeat(200 * 1024 + 1);
    const run = executeCollecting(driver, execInput("exec-1", huge));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("PROTOCOL_LIMIT");
    expect(terminal.dispatchState).toBe("not_dispatched");
    // No spawn happened for the oversized prompt.
    const turnPids = aggregatePids()
      .map(statsOf)
      .filter((s): s is Record<string, unknown> => s !== null && Number(s.turns) > 0);
    expect(turnPids).toHaveLength(0);
  });

  it("fast-exit race (D2): a sub-second healthy turn is NOT misjudged as a spawn failure", async () => {
    // deltaMs=0: the fixture writes both frames and exits 0 immediately. A
    // per-turn process that exits before/around `supervised` must still settle
    // completed via the exit handler, never as a DRIVER_SPAWN_FAILED.
    const driver = await createDriver({ delayMs: 0, reply: "Fast." });
    const run = executeCollecting(driver, execInput("exec-1", "Fast exit."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    const spawnFailures = run.events.filter(
      (e) => e.type === "failed" && e.error.code === "DRIVER_SPAWN_FAILED",
    );
    expect(spawnFailures).toHaveLength(0);
  });

  it("diagnostics never leak the prompt or session id into error messages", async () => {
    const secret = "SUPER_SECRET_TOKEN_VALUE";
    const driver = await createDriver({ crashAfterAssistant: true });
    const run = executeCollecting(driver, execInput("exec-1", secret));
    await run.done;
    for (const event of run.events) {
      if (event.type === "failed") {
        expect(event.error.message).not.toContain(secret);
      }
    }
  });
});
