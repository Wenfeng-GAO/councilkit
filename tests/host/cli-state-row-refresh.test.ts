/**
 * #321: a Settings row's 「重新检查」 re-probes only that CLI. The other rows
 * keep their state (no flash back to 「检查中」) and their in-flight probes are
 * neither cancelled nor discarded. `?refresh=1` without `driver` still
 * re-probes every row (「全部重新检查」).
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliStateMonitor, type SpawnProbe, createCliStateMonitor } from "@host/cli-state";
import { CANONICAL_HOST_HEADER, DRIVER_IDS } from "@shared/runtime/contracts";
import { healthResponseSchema } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, createTestHost } from "./helpers";

// Real probe output shapes, so the rows are ready under any readiness rule.
const REAL_OUTPUT: Record<string, string> = {
  cld: "2.1.0 (Claude Code)\n",
  codex: "codex-cli 0.162.1\n",
  kimi: "Default model: kimi-code/k3\n",
  grok: "Available models:\n  * grok-4.7 (default)\n",
  "cursor-agent": "auto - Auto  (default)\n",
};
const BINS = Object.keys(REAL_OUTPUT);

interface Rig {
  monitor: CliStateMonitor;
  host: TestHost | null;
  home: string;
  probes: string[];
  release: (bin: string) => void;
}

let rig: Rig | null = null;

afterEach(async () => {
  rig?.monitor.close();
  await rig?.host?.cleanup();
  if (rig) await rm(rig.home, { recursive: true, force: true }).catch(() => undefined);
  rig = null;
});

/** Monitor whose probes for bins in `hold` wait until `release(bin)`. */
async function boot(options: { hold?: string[]; withHost?: boolean } = {}): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), "ck-cli-row-"));
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of BINS) {
    await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, name), 0o755);
  }
  const probes: string[] = [];
  const held = new Map<string, Array<() => void>>();
  const hold = new Set(options.hold ?? []);
  const spawnProbe: SpawnProbe = (spec) => {
    const name = spec.executable.split("/").pop() ?? "";
    probes.push(name);
    const out = { code: 0, timedOut: false, text: REAL_OUTPUT[name] ?? "" };
    if (!hold.has(name)) return Promise.resolve(out);
    return new Promise((resolve) => {
      const list = held.get(name) ?? [];
      list.push(() => resolve(out));
      held.set(name, list);
    });
  };
  const monitor = createCliStateMonitor({
    env: { PATH: bin, HOME: home, TMPDIR: tmpdir() },
    wellKnownDirs: [],
    timeoutMs: 5_000,
    checkoutPath: home,
    cwd: home,
    spawnProbe,
  });
  const host = options.withHost
    ? await createTestHost({ extraServices: { cliStateMonitor: monitor } })
    : null;
  const release = (name: string) => {
    hold.delete(name);
    for (const fn of held.get(name) ?? []) fn();
    held.delete(name);
  };
  rig = { monitor, host, home, probes, release };
  return rig;
}

const states = (monitor: CliStateMonitor) =>
  Object.fromEntries(monitor.snapshot().map((row) => [row.driverId, row.cliState]));

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function health(host: TestHost, query: string) {
  const res = await fetch(`${host.baseUrl}/api/v1/health${query}`, {
    headers: { Host: CANONICAL_HOST_HEADER },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown };
  return healthResponseSchema.parse(body.data);
}

describe("#321 row 「重新检查」 re-probes only that row", () => {
  it("#321 refresh(driverId) leaves every other row's state untouched", async () => {
    const { monitor, probes } = await boot();
    await until(() => Object.values(states(monitor)).every((s) => s === "ready"));
    probes.length = 0;

    monitor.refresh("grok-stream-json");
    const after = states(monitor);
    expect(after["grok-stream-json"]).toBe("checking");
    for (const id of DRIVER_IDS) {
      if (id !== "grok-stream-json") expect(after[id], id).toBe("ready");
    }
    expect(probes).toEqual(["grok"]);
    await until(() => states(monitor)["grok-stream-json"] === "ready");
  });

  it("#321 refreshing one row does not cancel or discard another row's in-flight probe", async () => {
    const { monitor, release } = await boot({ hold: ["kimi"] });
    await until(() => states(monitor)["grok-stream-json"] === "ready");
    expect(states(monitor)["kimi-stream-json"]).toBe("checking");

    monitor.refresh("grok-stream-json");
    release("kimi");
    await until(() => states(monitor)["kimi-stream-json"] === "ready");
    await until(() => states(monitor)["grok-stream-json"] === "ready");
  });

  it("#321 refresh() with no driver still re-probes every installed row", async () => {
    const { monitor, probes } = await boot();
    await until(() => Object.values(states(monitor)).every((s) => s === "ready"));
    probes.length = 0;
    monitor.refresh();
    expect(Object.values(states(monitor)).every((s) => s === "checking")).toBe(true);
    expect([...probes].sort()).toEqual([...BINS].sort());
  });

  it("#321 GET /health?refresh=1&driver=<id> refreshes only that row; unknown driver refreshes none", async () => {
    const { host, monitor, probes } = await boot({ withHost: true });
    if (!host) throw new Error("no host");
    await until(() => Object.values(states(monitor)).every((s) => s === "ready"));
    probes.length = 0;

    const one = await health(host, "?refresh=1&driver=codex-app-server");
    const byId = Object.fromEntries(one.drivers.map((row) => [row.driverId, row.cliState]));
    expect(byId["codex-app-server"]).toBe("checking");
    for (const id of DRIVER_IDS) {
      if (id !== "codex-app-server") expect(byId[id], id).toBe("ready");
    }
    expect(probes).toEqual(["codex"]);
    await until(() => states(monitor)["codex-app-server"] === "ready");

    probes.length = 0;
    const none = await health(host, "?refresh=1&driver=nope");
    expect(none.drivers.every((row) => row.cliState === "ready")).toBe(true);
    expect(probes).toEqual([]);
  });
});
