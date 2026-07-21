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
    expect(completed1.toolState).toBe("none");
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

  it("malformed JSON line is off-protocol: turn completes with toolState=unknown (discardable, F6)", async () => {
    const driver = await createDriver({ badJson: true });
    const run = executeCollecting(driver, execInput("exec-1", "Bad json line."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    // No tool activity, but the non-JSON line is off-protocol (E10): the
    // terminal toolState is "unknown" — the commit pipeline discards it, the
    // core reviewer concern (F6/D7). The assistant output was still accepted.
    expect(terminal.toolState).toBe("unknown");
    expect(terminal.output).toBe("Fake kimi answer.");
  });

  it("a clean turn (no tool frames, no off-protocol) reports toolState=none (committable, F1)", async () => {
    const driver = await createDriver({ reply: "Clean discussion answer." });
    const run = executeCollecting(driver, execInput("exec-1", "Clean turn."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    // The protocol proves an assistant content frame with no tool activity and
    // no off-protocol leak → "none", the only value classifyCompleted commits.
    expect(terminal.toolState).toBe("none");
    expect(terminal.output).toBe("Clean discussion answer.");
  });

  it("a tooled turn (tool_calls + role:tool + bare stdout) reports toolState=completed (committable, F1)", async () => {
    const driver = await createDriver({ toolTurn: true });
    const run = executeCollecting(driver, execInput("exec-1", "Tooled turn."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    // tool_calls + role:"tool" frames = provable tool activity that completed
    // normally → "completed". The authoritative output is the LAST assistant
    // content frame (the tool-call-only frame is NOT an output candidate).
    expect(terminal.toolState).toBe("completed");
    expect(terminal.output).toBe("Fake kimi answer.");
    expect(terminal.dispatchState).toBe("accepted");
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

  it("F2: a turn whose exit control frame lands before the stdout tail still settles from the full frames", async () => {
    // delayExitStdoutMs holds stdout open briefly after the frames are written,
    // then exits — the driver must wait for the stdout drain (or its bounded
    // grace) before settling, so the assistant + resume_hint frames are NOT
    // dropped into an EMPTY_OUTPUT misclassification.
    const driver = await createDriver({ reply: "Drained tail.", delayExitStdoutMs: 60 });
    const run = executeCollecting(driver, execInput("exec-1", "Exit before stdout."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    expect(terminal.output).toBe("Drained tail.");
    expect(terminal.toolState).toBe("none");
  });

  it("F3: a successful first turn establishes a sid; a resume turn that hangs idles out and the NEXT turn is a full coldStart with no -S", async () => {
    // Turn 1 succeeds and captures a resume hint (clean, toolState=none).
    // Turn 2 is a resume turn that emits nothing and hangs (idle timeout). It
    // must fail AND the sessionEpoch must bump synchronously so turn 3 is a
    // cold rebase (full prompt, no -S) rather than an incremental resume.
    const driver = await createDriver({ reply: "First cold." });
    const run1 = executeCollecting(driver, execInput("exec-1", "Seed."));
    await run1.done;
    expect(terminalOf(run1.events).type).toBe("completed");
    const epochAfterTurn1 = driver.sessionEpoch;

    // Reconfigure the fixture so the SECOND (resume) turn hangs forever.
    await writeFixtureConfig("p-1", { statsPath: join(tempRoot, "stats"), hang: true });
    const run2 = executeCollecting(driver, execInput("exec-2", "Hang on resume."));
    await run2.done;
    const t2 = terminalOf(run2.events);
    expect(t2.type).toBe("failed");
    if (t2.type !== "failed") throw new Error("unreachable");
    expect(t2.error.code).toBe("STREAM_IDLE_TIMEOUT");
    // F3: the timeout invalidated the session synchronously (before the
    // terminal), bumping the epoch.
    expect(driver.sessionEpoch).toBeGreaterThan(epochAfterTurn1);

    // Wait for the timed-out turn-2 process group to be fully reaped before
    // turn 3 so the supervisor does not reject a second live driver for the
    // same participant (the reap is best-effort async on the timeout path).
    await waitFor(
      () => pgrepCount("fake-kimi[.]mjs") === 0 && pgrepCount("watchdog-child[.]mjs") === 0,
      6000,
    );

    // Restore a working fixture for turn 3.
    await writeFixtureConfig("p-1", {
      statsPath: join(tempRoot, "stats"),
      reply: "Cold rebase reply.",
    });
    const run3 = executeCollecting(driver, execInput("exec-3", "Rebase."));
    await run3.done;
    expect(terminalOf(run3.events).type).toBe("completed");

    // The resume stats prove turn 3 was a cold rebase (no -S): exactly ONE turn
    // ran with an inbound -S (turn 2, the resume that hung), and it used the
    // seed session id; turns 1 and 3 ran cold (hadSid === false). If the F3
    // synchronous invalidation had NOT bumped the epoch, turn 3 would have
    // carried -S too — so asserting hadSid===false count >= 2 is the gate.
    const pids = aggregatePids();
    const turnPids = pids
      .map(statsOf)
      .filter((s): s is Record<string, unknown> => s !== null && Number(s.turns) > 0);
    const withSid = turnPids.filter((s) => s.hadSid === true);
    const withoutSid = turnPids.filter((s) => s.hadSid === false);
    expect(withoutSid.length).toBeGreaterThanOrEqual(2); // turns 1 and 3
    expect(withSid).toHaveLength(1); // turn 2 only
    for (const s of withSid) {
      for (const sid of Array.isArray(s.resumeIds) ? (s.resumeIds as unknown[]) : []) {
        expect(sid).toBe("session-fake-1");
      }
    }
  });

  it("F5: a hung provider probe is bounded by an absolute deadline and surfaces HANDSHAKE_TIMEOUT (never hangs forever)", async () => {
    // providerHang keeps `provider list` alive forever (OAuth-interactive
    // hang). The prewarm probe must hit its deadline, shut the probe down, and
    // surface HANDSHAKE_TIMEOUT — not block the execute promise.
    await expect(createDriver({ providerHang: true })).rejects.toMatchObject({
      runtimeCode: "HANDSHAKE_TIMEOUT",
    });
    // No fake-kimi turn process leaked (only the probe, which was reaped).
    await waitFor(
      () => pgrepCount("fake-kimi[.]mjs") === 0 && pgrepCount("watchdog-child[.]mjs") === 0,
      8000,
    ).catch(() => undefined);
    expect(pgrepCount("fake-kimi[.]mjs")).toBe(0);
    expect(pgrepCount("watchdog-child[.]mjs")).toBe(0);
  });

  it("F4: close() during a pending/hung turn races the spawn safely — driver closes, no turn process leaks", async () => {
    // The spawn resolves before close, but the turn hangs (no frames), so a
    // process group IS live when close() runs. close() must reap it and the
    // (already tracked) pending spawn rather than leave a running kimi behind.
    const driver = await createDriver({ hang: true });
    const run = executeCollecting(driver, execInput("exec-1", "Hang then close."));
    // Let the spawn resolve and the turn start hanging.
    await new Promise((r) => setTimeout(r, 60));
    await driver.close();
    // close() returned without blocking. The in-flight turn's execute promise
    // is intentionally left unsettled by close() (the driver is being torn
    // down); we do NOT await run.done here. The driver is closed; a later
    // execute is not_dispatched (no respawn).
    const run2 = executeCollecting(driver, execInput("exec-2", "After close."));
    await run2.done;
    const t = terminalOf(run2.events);
    expect(t.type).toBe("failed");
    if (t.type !== "failed") throw new Error("unreachable");
    expect(t.dispatchState).toBe("not_dispatched");
    // No turn/spawn process leaked past close.
    await waitFor(
      () => pgrepCount("fake-kimi[.]mjs") === 0 && pgrepCount("watchdog-child[.]mjs") === 0,
      6000,
    ).catch(() => undefined);
    expect(pgrepCount("fake-kimi[.]mjs")).toBe(0);
    expect(pgrepCount("watchdog-child[.]mjs")).toBe(0);
    void run;
  });
});
