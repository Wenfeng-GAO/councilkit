/**
 * Per-driver CLI state for GET /api/v1/health and Settings.
 *
 * Independent of Execution Profiles and Installation trust: a missing binary
 * is `not_installed` immediately (no handshake, no leftover config file
 * counts as ready). When the binary is on PATH / vendor dirs, a short-lived
 * probe runs with a 15s bound; timeout and ambiguous output become
 * `check_failed`, never `not_installed`. Auth is `not_logged_in` only on a
 * positive AUTH_REQUIRED / "not logged in" signal.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_STATE_PROBE_MS,
  type CliState,
  DRIVER_IDS,
  type DriverCapabilityState,
  type DriverId,
} from "@shared/runtime/contracts";
import type { DriverDescriptor, HealthResponse } from "@shared/runtime/schemas";
import { discoveryDirs } from "./installations/discovery";
import type { HostServices } from "./server";

export { CLI_STATE_PROBE_MS };

export interface DriverCliTool {
  bin: string;
  probeArgv: string[];
  loginCommand: string;
  /** Empty when there is no copyable install command (Claude: mock copy, not npm). */
  installCommand: string;
}

export const DRIVER_CLI_TOOLS: Record<DriverId, DriverCliTool> = {
  "claude-stream-json": {
    bin: "cld",
    probeArgv: ["--version"],
    loginCommand: "cld login",
    installCommand: "",
  },
  "codex-app-server": {
    bin: "codex",
    probeArgv: ["--version"],
    loginCommand: "codex login",
    installCommand: "",
  },
  "kimi-stream-json": {
    bin: "kimi",
    probeArgv: ["provider", "list"],
    loginCommand: "kimi login",
    installCommand: "",
  },
  "grok-stream-json": {
    bin: "grok",
    probeArgv: ["models"],
    loginCommand: "grok login",
    installCommand: "",
  },
  "cursor-stream-json": {
    bin: "cursor-agent",
    probeArgv: ["models"],
    loginCommand: "cursor-agent login",
    installCommand: "curl https://cursor.com/install -fsS | bash",
  },
};

const PROBE_TEXT_CAP = 64 * 1024;
const KILL_GRACE_MS = 200;
const INHERITED_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"] as const;

const AUTH_REQUIRED_RE = /AUTH_REQUIRED|not logged in|please (?:run )?\S* ?login|unauthoriz/i;

export function looksLikeAuthRequired(text: string): boolean {
  return AUTH_REQUIRED_RE.test(text);
}

export interface ProbeOutput {
  code: number | null;
  timedOut: boolean;
  text: string;
}

/** Classify a finished probe. Never returns `not_installed` or `checking`. */
export function classifyProbeOutput(
  result: ProbeOutput,
): Exclude<CliState, "not_installed" | "checking"> {
  if (result.timedOut) return "check_failed";
  if (looksLikeAuthRequired(result.text)) return "not_logged_in";
  if (result.code === 0) return "ready";
  return "check_failed";
}

export function capabilityFromCliState(state: CliState): DriverCapabilityState {
  switch (state) {
    case "ready":
      return "ready";
    case "not_logged_in":
      return "auth_required";
    case "checking":
      return "checking";
    case "not_installed":
    case "check_failed":
      return "incompatible";
  }
}

export function fixCommandFor(driverId: DriverId, state: CliState): string {
  const tool = DRIVER_CLI_TOOLS[driverId];
  switch (state) {
    case "not_installed":
      return tool.installCommand;
    case "not_logged_in":
      return tool.loginCommand;
    case "check_failed":
      return `${tool.bin} --version`;
    case "ready":
    case "checking":
      return "";
  }
}

export function findDriverBinary(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  wellKnownDirs?: string[],
): string | null {
  for (const entry of discoveryDirs({ env, wellKnownDirs })) {
    const candidate = join(entry.dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing / unreadable entries are not an install.
    }
  }
  return null;
}

export function toDriverDescriptor(driverId: DriverId, cliState: CliState): DriverDescriptor {
  return {
    driverId,
    cliState,
    capability: capabilityFromCliState(cliState),
    fixCommand: fixCommandFor(driverId, cliState),
  };
}

export interface SpawnProbeSpec {
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onSpawn?: (kill: () => void) => void;
}

export type SpawnProbe = (spec: SpawnProbeSpec) => Promise<ProbeOutput>;

function probeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS);
}

export const defaultSpawnProbe: SpawnProbe = (spec) =>
  new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let text = "";
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, text });
    };
    const child = spawn(spec.executable, spec.argv, {
      cwd: spec.cwd,
      env: probeEnv(spec.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    spec.onSpawn?.(() => killChild(child));
    const append = (chunk: Buffer) => {
      if (text.length >= PROBE_TEXT_CAP) return;
      text += chunk.toString("utf8").slice(0, PROBE_TEXT_CAP - text.length);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, spec.timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });

export interface CliStateMonitorOptions {
  env?: NodeJS.ProcessEnv;
  wellKnownDirs?: string[];
  timeoutMs?: number;
  checkoutPath?: string;
  cwd?: string;
  spawnProbe?: SpawnProbe;
}

export interface CliStateMonitor {
  readonly checkoutPath: string;
  snapshot(): DriverDescriptor[];
  refresh(): void;
  close(): void;
}

interface InternalRow {
  cliState: CliState;
  fixCommand: string;
}

export function createCliStateMonitor(options: CliStateMonitorOptions = {}): CliStateMonitor {
  const env = options.env ?? process.env;
  const wellKnownDirs = options.wellKnownDirs;
  const timeoutMs = options.timeoutMs ?? CLI_STATE_PROBE_MS;
  const checkoutPath = options.checkoutPath ?? process.cwd();
  const cwd = options.cwd ?? checkoutPath;
  const spawnProbe = options.spawnProbe ?? defaultSpawnProbe;
  const rows = new Map<DriverId, InternalRow>();
  const kills = new Map<DriverId, () => void>();
  let generation = 0;

  function write(driverId: DriverId, cliState: CliState): void {
    rows.set(driverId, { cliState, fixCommand: fixCommandFor(driverId, cliState) });
  }

  function scanAndMark(): DriverId[] {
    const pending: DriverId[] = [];
    for (const driverId of DRIVER_IDS) {
      const found = findDriverBinary(DRIVER_CLI_TOOLS[driverId].bin, env, wellKnownDirs);
      if (!found) {
        write(driverId, "not_installed");
        continue;
      }
      write(driverId, "checking");
      pending.push(driverId);
    }
    return pending;
  }

  async function probeOne(driverId: DriverId, gen: number): Promise<void> {
    const tool = DRIVER_CLI_TOOLS[driverId];
    const executable = findDriverBinary(tool.bin, env, wellKnownDirs);
    if (gen !== generation) return;
    if (!executable) {
      write(driverId, "not_installed");
      return;
    }
    let result: ProbeOutput;
    try {
      result = await new Promise<ProbeOutput>((resolve, reject) => {
        // Backup bound: even if spawnProbe ignores timeoutMs, checking ends.
        const backup = setTimeout(
          () => {
            kills.get(driverId)?.();
            resolve({ code: null, timedOut: true, text: "" });
          },
          timeoutMs + KILL_GRACE_MS + 100,
        );
        spawnProbe({
          executable,
          argv: tool.probeArgv,
          cwd,
          env,
          timeoutMs,
          onSpawn: (kill) => {
            if (gen !== generation) {
              kill();
              return;
            }
            kills.set(driverId, kill);
          },
        })
          .then((out) => {
            clearTimeout(backup);
            resolve(out);
          })
          .catch((error: unknown) => {
            clearTimeout(backup);
            reject(error);
          });
      });
    } catch {
      kills.delete(driverId);
      if (gen !== generation) return;
      write(driverId, "check_failed");
      return;
    }
    kills.delete(driverId);
    if (gen !== generation) return;
    write(driverId, classifyProbeOutput(result));
  }

  function refresh(): void {
    generation += 1;
    const gen = generation;
    for (const kill of kills.values()) kill();
    kills.clear();
    const pending = scanAndMark();
    for (const driverId of pending) void probeOne(driverId, gen);
  }

  refresh();

  return {
    checkoutPath,
    snapshot() {
      return DRIVER_IDS.map((driverId) => {
        const row = rows.get(driverId);
        return toDriverDescriptor(driverId, row?.cliState ?? "checking");
      });
    },
    refresh,
    close() {
      generation += 1;
      for (const kill of kills.values()) kill();
      kills.clear();
    },
  };
}

function nodeInfo(): HealthResponse["node"] {
  return { version: process.version, major: Number.parseInt(process.version.slice(1), 10) };
}

function fallbackDrivers(
  capabilityProvider: (() => { driverId: string; capability: string }[]) | undefined,
): DriverDescriptor[] {
  const listed = capabilityProvider?.();
  const byId = new Map((listed ?? []).map((row) => [row.driverId, row.capability]));
  return DRIVER_IDS.map((driverId) => {
    const capability = (byId.get(driverId) ?? "checking") as DriverCapabilityState;
    const cliState: CliState =
      capability === "ready"
        ? "ready"
        : capability === "auth_required"
          ? "not_logged_in"
          : capability === "incompatible"
            ? "check_failed"
            : "checking";
    return toDriverDescriptor(driverId, cliState);
  });
}

/** Assemble the public health payload. `refresh` restarts in-flight probes. */
export function composeHealthResponse(
  services: HostServices,
  options: { refresh?: boolean } = {},
): HealthResponse {
  const monitor = services.cliStateMonitor as CliStateMonitor | undefined;
  if (options.refresh) monitor?.refresh();
  const drivers = monitor
    ? monitor.snapshot()
    : fallbackDrivers(
        services.driverCapabilities as
          | (() => { driverId: string; capability: string }[])
          | undefined,
      );
  return {
    apiVersion: "v1",
    hostInstanceId: services.hostInstanceId,
    node: nodeInfo(),
    checkoutPath: monitor?.checkoutPath ?? process.cwd(),
    drivers,
  };
}
