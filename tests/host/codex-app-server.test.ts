import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "@host/config";
import { createCodexAppServerDriver } from "@host/drivers/codex-app-server";
import type {
  DriverDeps,
  DriverEvent,
  DriverTimeouts,
  ExecuteInput,
  ParticipantDriver,
} from "@host/drivers/types";
import type { InstallationRecord } from "@host/installations/registry";
import { type Logger, createLogger } from "@host/logging";
import { type ProcessSupervisor, createProcessSupervisor } from "@host/process/process-supervisor";
import type { ParticipantSpec } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * codex-app-server driver protocol tests against the real driver factory,
 * the real process supervisor, and tests/fixtures/drivers/fake-codex-app-server.mjs.
 *
 * Fixture behavior is configured via `fake-driver-config.json` in the
 * Participant-dedicated cwd (the supervisor's env hygiene blocks FIXTURE_*
 * env vars from reaching the supervised process by design).
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const WATCHDOG_PROGRAM = join(repoRoot, "runtime-host/process/watchdog-child.mjs");
const FAKE_CODEX = join(repoRoot, "tests/fixtures/drivers/fake-codex-app-server.mjs");
const FINGERPRINT = "f".repeat(64);
const MODEL_ID = "gpt-5.6-sol";
const REPLY = "Fake codex answer.";

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
  tempRoot = await mkdtemp(join(tmpdir(), "councilkit-codex-driver-"));
});

afterEach(async () => {
  for (const driver of drivers) await driver.close().catch(() => undefined);
  drivers = [];
  for (const supervisor of supervisors) await supervisor.shutdownAll(300).catch(() => undefined);
  supervisors = [];
  await waitFor(
    () =>
      pgrepCount("fake-codex-app-server[.]mjs") === 0 && pgrepCount("watchdog-child[.]mjs") === 0,
    5000,
  ).catch(() => undefined);
  expect(pgrepCount("fake-codex-app-server[.]mjs")).toBe(0);
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
  decisions: unknown[];
  pids: number[];
}

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
      // Atomic tmp+rename writes; ignore anything unexpected.
    }
  }
  return { counts, decisions, pids };
}

type CompletedDriverEvent = Extract<DriverEvent, { type: "completed" }>;
type FailedDriverEvent = Extract<DriverEvent, { type: "failed" }>;
type InterruptedDriverEvent = Extract<DriverEvent, { type: "interrupted" }>;
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

function execInput(executionId: string, prompt: string): ExecuteInput {
  return { executionId, prompt, modelId: MODEL_ID, coldStart: executionId === "exec-1" };
}

function makeSpec(participantId: string): ParticipantSpec {
  return {
    participantId,
    profile: {
      driverId: "codex-app-server",
      installationId: "fake-codex",
      credentialMode: "installation-managed",
      options: {},
    },
    modelId: MODEL_ID,
  };
}

function makeInstallation(): InstallationRecord {
  return {
    installationId: "fake-codex",
    driverId: "codex-app-server",
    name: "codex",
    discoveredPath: FAKE_CODEX,
    realpath: FAKE_CODEX,
    fingerprint: FINGERPRINT,
    state: "trusted",
    components: [{ role: "wrapper", path: FAKE_CODEX, fingerprint: FINGERPRINT }],
    detail: null,
  };
}

interface Rig {
  driver: ParticipantDriver;
  logger: Logger;
  supervisor: ProcessSupervisor;
  participantId: string;
}

async function createRig(
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
  const driver = createCodexAppServerDriver(deps)(participantId);
  drivers.push(driver);
  await writeFixtureConfig(participantId, options.config ?? {});
  await driver.prewarm({
    participantId,
    spec: makeSpec(participantId),
    installation: makeInstallation(),
  });
  return { driver, logger, supervisor, participantId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("codex-app-server driver protocol", () => {
  it("answers approval server requests with exactly {decision: denied} and completes the turn", async () => {
    const rig = await createRig({ config: { approval: true } });
    const run = executeCollecting(rig.driver, execInput("exec-1", "Approve me."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    expect(terminal.output).toBe(REPLY);

    // No approval UI exists: every server request is declined verbatim.
    await waitFor(() => aggregateStats().counts.approvalsReceived === 1, 5000);
    expect(aggregateStats().decisions).toEqual([{ decision: "denied" }]);
    expect(
      rig.logger.diagnostics().some((entry) => entry.kind === "codex.server_request_declined"),
    ).toBe(true);
  });

  it("reports a mid-turn reroute as a completed turn with modelVerdict mismatch", async () => {
    const rig = await createRig({ config: { reroute: true } });
    const run = executeCollecting(rig.driver, execInput("exec-1", "Reroute me."));
    await run.done;
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("unreachable");
    expect(terminal.output).toBe(REPLY);
    expect(terminal.requestedModel).toBe(MODEL_ID);
    expect(terminal.effectiveModel).toBe("gpt-5.5");
    expect(terminal.modelVerdict).toBe("mismatch");
    expect(rig.logger.diagnostics().some((entry) => entry.kind === "codex.rerouted")).toBe(true);
  });

  it("never retries in place when the process died before dispatch", async () => {
    const rig = await createRig();
    const stats = aggregateStats();
    expect(stats.pids).toHaveLength(1);
    // Kill the fixture externally (host view: driver crash while idle).
    process.kill(stats.pids[0] as number, "SIGKILL");
    await waitFor(() => rig.driver.sessionEpoch === 1, 5000);

    const run = executeCollecting(rig.driver, execInput("exec-1", "Revive?"));
    await run.done;
    // codex policy: no in-place retry — the retryable terminal reaches the
    // caller untouched, and the driver does not respawn on its own.
    expect(run.events.map((event) => event.type)).toEqual(["failed"]);
    const terminal = terminalOf(run.events);
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("DRIVER_CRASH");
    expect(terminal.error.phase).toBe("dispatch");
    expect(terminal.dispatchState).toBe("not_dispatched");
    expect(terminal.retryable).toBe(true);
    expect(aggregateStats().counts.turnStarts).toBe(0);
    expect(aggregateStats().pids).toHaveLength(1);

    // The caller decides: an explicit prewarm rebuilds the session, then the
    // driver is usable again.
    await rig.driver.prewarm({
      participantId: rig.participantId,
      spec: makeSpec(rig.participantId),
      installation: makeInstallation(),
    });
    const run2 = executeCollecting(rig.driver, execInput("exec-2", "After prewarm."));
    await run2.done;
    expect(terminalOf(run2.events).type).toBe("completed");
    expect(aggregateStats().pids).toHaveLength(2);
    expect(aggregateStats().counts.threadStarts).toBe(2);
    expect(aggregateStats().counts.turnStarts).toBe(1);
  });

  it("surfaces the runtime-reported context window only after it is reported", async () => {
    const rig = await createRig();
    expect(rig.driver.contextWindowTokens()).toBeNull();
    const run = executeCollecting(rig.driver, execInput("exec-1", "Window?"));
    await run.done;
    expect(terminalOf(run.events).type).toBe("completed");
    expect(rig.driver.contextWindowTokens()).toBe(258400);
  });

  it("fails NEEDS_REBASE when the runtime compacts the thread mid-turn", async () => {
    const rig = await createRig({ config: { compacted: true } });
    const run = executeCollecting(rig.driver, execInput("exec-1", "Compact me."));
    await run.done;
    // The first delta streamed before the runtime compacted the thread.
    expect(run.events.some((event) => event.type === "output.delta")).toBe(true);
    const terminal = terminalOf(run.events);
    expect(terminal.type).toBe("failed");
    if (terminal.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("NEEDS_REBASE");
    expect(terminal.error.phase).toBe("stream");
    expect(terminal.dispatchState).toBe("accepted");
    expect(terminal.retryable).toBe(false);
    // Compaction invalidates the session epoch and drops the thread.
    expect(rig.driver.sessionEpoch).toBe(1);

    // The thread is gone: a follow-up execute cannot dispatch at all.
    const run2 = executeCollecting(rig.driver, execInput("exec-2", "Anyone there?"));
    await run2.done;
    const terminal2 = terminalOf(run2.events);
    expect(terminal2.type).toBe("failed");
    if (terminal2.type !== "failed") throw new Error("unreachable");
    expect(terminal2.error.code).toBe("DRIVER_CRASH");
    expect(terminal2.dispatchState).toBe("not_dispatched");
    expect(terminal2.retryable).toBe(true);
    expect(aggregateStats().counts.turnStarts).toBe(1);
    expect(aggregateStats().pids).toHaveLength(1);
  });
});
