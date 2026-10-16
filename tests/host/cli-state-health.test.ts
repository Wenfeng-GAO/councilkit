import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliStateMonitor, createCliStateMonitor } from "@host/cli-state";
import { CANONICAL_HOST_HEADER, CLI_STATES, DRIVER_IDS } from "@shared/runtime/contracts";
import { healthResponseSchema } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, createTestHost } from "./helpers";

const FIVE = [...CLI_STATES].sort();

interface Rig {
  host: TestHost;
  monitor: CliStateMonitor;
  home: string;
  stubDir: string;
}

let rig: Rig | null = null;

afterEach(async () => {
  rig?.monitor.close();
  await rig?.host.cleanup();
  if (rig) await rm(rig.home, { recursive: true, force: true }).catch(() => undefined);
  rig = null;
});

async function writeStub(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, body, { encoding: "utf8" });
  await chmod(path, 0o755);
  return path;
}

async function boot(options: {
  stubs?: Record<string, string>;
  leftover?: boolean;
  timeoutMs?: number;
}): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), "ck-cli-state-"));
  const stubDir = join(home, "bin");
  await mkdir(stubDir, { recursive: true });
  if (options.leftover) {
    await writeFile(join(home, ".claude.json"), "");
    await mkdir(join(home, ".grok"), { recursive: true });
    await writeFile(join(home, ".grok", "config.json"), "{}");
    await mkdir(join(home, ".kimi"), { recursive: true });
    await writeFile(join(home, ".kimi", "config.json"), "{}");
    await mkdir(join(home, ".codex"), { recursive: true });
  }
  for (const [name, body] of Object.entries(options.stubs ?? {})) {
    await writeStub(stubDir, name, body);
  }
  const monitor = createCliStateMonitor({
    env: { PATH: stubDir, HOME: home, TMPDIR: tmpdir() },
    wellKnownDirs: [],
    timeoutMs: options.timeoutMs ?? 2_000,
    checkoutPath: home,
    cwd: home,
  });
  const host = await createTestHost({ extraServices: { cliStateMonitor: monitor } });
  const next: Rig = { host, monitor, home, stubDir };
  rig = next;
  return next;
}

async function getHealth(host: TestHost, refresh = false) {
  const url = `${host.baseUrl}/api/v1/health${refresh ? "?refresh=1" : ""}`;
  const res = await fetch(url, { headers: { Host: CANONICAL_HOST_HEADER } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: true; data: unknown };
  const parsed = healthResponseSchema.parse(body.data);
  return parsed;
}

async function waitForStates(
  host: TestHost,
  predicate: (states: Record<string, string>) => boolean,
  timeoutMs = 5_000,
) {
  const start = Date.now();
  let last = await getHealth(host);
  while (Date.now() - start < timeoutMs) {
    const states = Object.fromEntries(last.drivers.map((row) => [row.driverId, row.cliState]));
    if (predicate(states)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
    last = await getHealth(host);
  }
  throw new Error(
    `timed out waiting for cli states: ${JSON.stringify(last.drivers.map((row) => [row.driverId, row.cliState]))}`,
  );
}

const READY = "#!/bin/sh\necho ok\nexit 0\n";
const AUTH = '#!/bin/sh\necho "not logged in" >&2\nexit 1\n';
const AUTH_CODE = "#!/bin/sh\necho AUTH_REQUIRED >&2\nexit 1\n";
const AMBIGUOUS = '#!/bin/sh\necho "boom: unexpected error" >&2\nexit 1\n';
const HANG = "#!/bin/sh\nexec /bin/sleep 30\n";

describe("CLI state health (#274 / #276)", () => {
  it("CLI-02 BUG-02 clean HOME: every driver reaches not_installed within one refresh", async () => {
    const { host } = await boot({});
    await getHealth(host, true);
    const health = await waitForStates(
      host,
      (states) => Object.values(states).every((state) => state === "not_installed"),
      15_000,
    );
    expect(health.drivers).toHaveLength(DRIVER_IDS.length);
    expect(health.drivers.every((row) => row.cliState === "not_installed")).toBe(true);
  });

  it("CLI-06 probe timeout -> check_failed, never not_installed", async () => {
    const { host } = await boot({
      stubs: { grok: HANG },
      timeoutMs: 250,
    });
    const health = await waitForStates(
      host,
      (states) => states["grok-stream-json"] !== "checking",
      4_000,
    );
    const grok = health.drivers.find((row) => row.driverId === "grok-stream-json");
    expect(grok?.cliState).toBe("check_failed");
    expect(grok?.cliState).not.toBe("not_installed");
    expect(grok?.fixCommand).toBe("grok --version");
    expect(grok?.capability).toBe("incompatible");
  });

  it("CLI-06 retry after timeout recovers to ready", async () => {
    const { host, stubDir, monitor } = await boot({
      stubs: { grok: HANG },
      timeoutMs: 250,
    });
    await waitForStates(host, (states) => states["grok-stream-json"] === "check_failed", 4_000);
    await writeStub(stubDir, "grok", READY);
    monitor.refresh();
    const health = await waitForStates(
      host,
      (states) => states["grok-stream-json"] === "ready",
      4_000,
    );
    expect(health.drivers.find((row) => row.driverId === "grok-stream-json")?.cliState).toBe(
      "ready",
    );
  });

  it("CLI-07 ambiguous probe output -> check_failed", async () => {
    const { host } = await boot({ stubs: { kimi: AMBIGUOUS } });
    const health = await waitForStates(
      host,
      (states) => states["kimi-stream-json"] !== "checking",
      4_000,
    );
    const kimi = health.drivers.find((row) => row.driverId === "kimi-stream-json");
    expect(kimi?.cliState).toBe("check_failed");
    expect(kimi?.cliState).not.toBe("not_installed");
    expect(kimi?.cliState).not.toBe("not_logged_in");
    expect(kimi?.fixCommand).toBe("kimi --version");
  });

  it('CLI-03 positive auth-required -> not_logged_in with "<cli> login"', async () => {
    const { host } = await boot({
      stubs: { grok: AUTH, kimi: AUTH_CODE, "cursor-agent": AUTH },
    });
    const health = await waitForStates(
      host,
      (states) =>
        states["grok-stream-json"] !== "checking" &&
        states["kimi-stream-json"] !== "checking" &&
        states["cursor-stream-json"] !== "checking",
      4_000,
    );
    const grok = health.drivers.find((row) => row.driverId === "grok-stream-json");
    const kimi = health.drivers.find((row) => row.driverId === "kimi-stream-json");
    const cursor = health.drivers.find((row) => row.driverId === "cursor-stream-json");
    expect(grok).toMatchObject({ cliState: "not_logged_in", fixCommand: "grok login" });
    expect(kimi).toMatchObject({ cliState: "not_logged_in", fixCommand: "kimi login" });
    expect(cursor).toMatchObject({
      cliState: "not_logged_in",
      fixCommand: "cursor-agent login",
    });
  });

  it("CLI-09 leftover config file without a successful probe is not ready", async () => {
    const { host } = await boot({ leftover: true });
    const health = await waitForStates(
      host,
      (states) => Object.values(states).every((state) => state !== "checking"),
      4_000,
    );
    expect(health.drivers.every((row) => row.cliState === "not_installed")).toBe(true);
    expect(health.drivers.some((row) => row.cliState === "ready")).toBe(false);
  });

  it("CLI-08 health has checkoutPath and only the five values", async () => {
    const { host, home } = await boot({
      stubs: { grok: READY, kimi: AUTH, codex: AMBIGUOUS },
      leftover: true,
    });
    const health = await waitForStates(
      host,
      (states) => Object.values(states).every((state) => state !== "checking"),
      4_000,
    );
    expect(health.checkoutPath).toBe(home);
    const values = [...new Set(health.drivers.map((row) => row.cliState))].sort();
    for (const value of values) {
      expect(FIVE).toContain(value);
    }
    expect(health.drivers.map((row) => row.driverId).sort()).toEqual([...DRIVER_IDS].sort());
    for (const row of health.drivers) {
      expect(CLI_STATES).toContain(row.cliState);
    }
  });

  it("CLI-04 successful probe -> ready", async () => {
    const { host } = await boot({ stubs: { grok: READY } });
    const health = await waitForStates(
      host,
      (states) => states["grok-stream-json"] !== "checking",
      4_000,
    );
    const grok = health.drivers.find((row) => row.driverId === "grok-stream-json");
    expect(grok).toMatchObject({ cliState: "ready", capability: "ready", fixCommand: "" });
  });
});
