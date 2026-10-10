/**
 * Driver health-probe orchestration (seat preflight).
 *
 * Default path aims for wall-clock under ~10s:
 *  1. TTL success cache — reuse last SUCCESS for the same
 *     (driverSelection, modelId) within COUNCILKIT_PROBE_CACHE_TTL_MS
 *     (default 90s, clamped to 60–120s unless explicitly set outside).
 *  2. Lightweight connectivity — CLI present + proxy/port sanity (no LLM).
 *  3. Escalate to the full `Reply with exactly: ok` LLM probe when the
 *     lightweight check is suspicious (or COUNCILKIT_PROBE_FORCE_LLM=1).
 *
 * Failures / timeouts are NOT cached (no negative cache). A short-lived
 * success is enough for consecutive review/fix/apply preflights.
 *
 * Grok warm home: probe spawns reuse `/tmp/ck-grok-<uid>/warm-home` (credentials
 * + skills=false only) instead of copying a fresh GROK_HOME under every probe
 * cwd. Per-attempt review workspaces still use per-cwd isolation. See
 * `ensureWarmGrokHome` / `spawnEnvForDriver({ warmGrokHome: true })`.
 */
import { spawnSync } from "node:child_process";
import type { AgentRecord } from "../store/schemas";
import {
  DRIVER_PROBE_PROMPT,
  buildProbeSpec,
  envHasProxy,
  executableForDriver,
  findExecutable,
  probeTimeoutMs,
} from "./driver-commands";
import type { AttemptResult, SpawnImpl } from "./runner";
import { spawnOnce } from "./runner";
import type { DriverProbeRecord } from "./transcript";

/** Default success-cache TTL (middle of the 60–120s product range). */
export const DEFAULT_PROBE_CACHE_TTL_MS = 90_000;
export const MIN_PROBE_CACHE_TTL_MS = 60_000;
export const MAX_PROBE_CACHE_TTL_MS = 120_000;

export type ProbePath = "cache" | "lightweight" | "llm";

export interface ProbeOutcome extends DriverProbeRecord {
  /** How the probe decided — observability only. */
  path: ProbePath;
}

interface CacheEntry {
  record: DriverProbeRecord;
  cachedAt: number;
}

const successCache = new Map<string, CacheEntry>();

/** Stable key matching review.ts: JSON.stringify([driverSelection, modelId]). */
export function probeCacheKey(agent: Pick<AgentRecord, "driverSelection" | "modelId">): string {
  return JSON.stringify([agent.driverSelection, agent.modelId]);
}

/** Read TTL from env. Bare numbers outside 60–120 are accepted when explicitly set
 * (escape hatch); unset / invalid → 90s default. */
export function probeCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COUNCILKIT_PROBE_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROBE_CACHE_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PROBE_CACHE_TTL_MS;
  return Math.floor(n);
}

export function clearProbeCache(): void {
  successCache.clear();
}

export function getProbeCacheEntryForTests(key: string): CacheEntry | undefined {
  return successCache.get(key);
}

function rememberSuccess(key: string, record: DriverProbeRecord, now: number): void {
  successCache.set(key, {
    cachedAt: now,
    record: {
      driverId: record.driverId,
      modelId: record.modelId,
      status: "success",
      durationMs: record.durationMs,
      failure: null,
    },
  });
}

function cachedSuccess(key: string, now: number, ttlMs: number): DriverProbeRecord | null {
  const hit = successCache.get(key);
  if (!hit || hit.record.status !== "success") return null;
  if (now - hit.cachedAt > ttlMs) return null;
  return hit.record;
}

export interface LightweightResult {
  ok: boolean;
  /** Connectivity looks doubtful — caller should escalate to the LLM probe. */
  suspicious: boolean;
  reason: string;
  durationMs: number;
}

export interface LightweightDeps {
  findExecutable?: typeof findExecutable;
  /** Returns a listening local HTTP proxy port, or null. */
  detectLocalProxyPort?: () => number | null;
  /** Platform override for tests (`darwin` → expect Clash when no proxy). */
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** Clash/mihomo mixed-port defaults — keep in sync with driver-commands. */
const LOCAL_HTTP_PROXY_PORTS = [7897, 7890];

function detectListeningLocalProxy(): number | null {
  for (const port of LOCAL_HTTP_PROXY_PORTS) {
    const probe = spawnSync("nc", ["-z", "127.0.0.1", String(port)], {
      stdio: "ignore",
      timeout: 400,
    });
    if (probe.status === 0) return port;
  }
  return null;
}

/** True when env points at 127.0.0.1/localhost:port that is not accepting connections. */
export function localProxyConfigBroken(
  env: NodeJS.ProcessEnv,
  detectPort: () => number | null = detectListeningLocalProxy,
): boolean {
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const) {
    const raw = env[key];
    if (!raw) continue;
    const m = /^(?:https?|socks5?h?):\/\/(?:127\.0\.0\.1|localhost):(\d+)/i.exec(raw.trim());
    if (!m) continue;
    const want = Number(m[1]);
    const listening = detectPort();
    if (listening === want) return false;
    // Direct nc for the configured port (detectPort only checks the known list).
    const probe = spawnSync("nc", ["-z", "127.0.0.1", String(want)], {
      stdio: "ignore",
      timeout: 400,
    });
    if (probe.status !== 0) return true;
  }
  return false;
}

/**
 * Fast connectivity preflight: CLI on PATH/vendor home, plus proxy sanity for
 * grok/codex. Does not call the LLM. kimi is checked unproxied (no proxy probe).
 */
export function lightweightConnectivityCheck(
  agent: Pick<AgentRecord, "driverSelection" | "modelId">,
  env: NodeJS.ProcessEnv = process.env,
  deps: LightweightDeps = {},
): LightweightResult {
  const started = (deps.now ?? Date.now)();
  const driverId = agent.driverSelection.driverId;
  const exeName = executableForDriver(driverId);
  if (exeName === undefined) {
    return {
      ok: false,
      suspicious: false,
      reason: `unsupported driver "${driverId}"`,
      durationMs: Math.max(0, (deps.now ?? Date.now)() - started),
    };
  }
  const find = deps.findExecutable ?? findExecutable;
  const exe = find(exeName, env);
  if (exe === null) {
    return {
      ok: false,
      suspicious: false,
      reason: `executable "${exeName}" not found`,
      durationMs: Math.max(0, (deps.now ?? Date.now)() - started),
    };
  }

  const detect = deps.detectLocalProxyPort ?? detectListeningLocalProxy;
  const platform = deps.platform ?? process.platform;

  if (driverId === "kimi-stream-json") {
    // kimi stays unproxied (#176); CLI present is enough.
    return {
      ok: true,
      suspicious: false,
      reason: "kimi cli present (unproxied)",
      durationMs: Math.max(0, (deps.now ?? Date.now)() - started),
    };
  }

  if (driverId === "grok-stream-json" || driverId === "codex-app-server") {
    if (localProxyConfigBroken(env, detect)) {
      return {
        ok: true,
        suspicious: true,
        reason: "local proxy env points at a closed port",
        durationMs: Math.max(0, (deps.now ?? Date.now)() - started),
      };
    }
    // macOS Host LaunchAgent typically has no shell proxy and relies on #176
    // Clash injection. If nothing is listening and no proxy is set, escalate.
    // Linux/cloud boxes use direct egress — CLI present is enough (do not
    // force-inject a proxy when measuring there).
    if (platform === "darwin" && !envHasProxy(env) && detect() === null) {
      return {
        ok: true,
        suspicious: true,
        reason: "darwin: no proxy env and no local Clash/mihomo port",
        durationMs: Math.max(0, (deps.now ?? Date.now)() - started),
      };
    }
    return {
      ok: true,
      suspicious: false,
      reason:
        envHasProxy(env) || detect() !== null
          ? "cli present; proxy available or configured"
          : "cli present; direct egress",
      durationMs: Math.max(0, (deps.now ?? Date.now)() - started),
    };
  }

  // claude / cursor: CLI present is the lightweight bar.
  return {
    ok: true,
    suspicious: false,
    reason: "cli present",
    durationMs: Math.max(0, (deps.now ?? Date.now)() - started),
  };
}

export interface RunDriverProbeOpts {
  agent: AgentRecord;
  probeId: string;
  cwd: string;
  signal?: AbortSignal;
  spawnImpl?: SpawnImpl;
  env?: NodeJS.ProcessEnv;
  /** Injected clock for cache expiry tests. */
  now?: () => number;
  /** Override TTL (tests). */
  ttlMs?: number;
  lightweightDeps?: LightweightDeps;
  /** Skip lightweight/cache and always run the LLM probe. */
  forceLlm?: boolean;
  /** Disable lightweight success path (cache still applies). */
  disableLightweight?: boolean;
  /** Custom LLM probe runner (defaults to spawnOnce + buildProbeSpec). */
  runLlmProbe?: () => Promise<AttemptResult>;
}

function envFlagTrue(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes" || t === "on";
}

function envFlagFalse(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === "0" || t === "false" || t === "no" || t === "off";
}

/**
 * Probe one driver/model for preflight. Prefers TTL cache + lightweight
 * connectivity; escalates to the existing LLM probe when needed.
 */
export async function runDriverProbe(opts: RunDriverProbeOpts): Promise<ProbeOutcome> {
  const env = opts.env ?? process.env;
  const now = (opts.now ?? Date.now)();
  const ttlMs = opts.ttlMs ?? probeCacheTtlMs(env);
  const key = probeCacheKey(opts.agent);
  const driverId = opts.agent.driverSelection.driverId;
  const modelId = opts.agent.modelId;
  const forceLlm = opts.forceLlm === true || envFlagTrue(env, "COUNCILKIT_PROBE_FORCE_LLM");
  const disableLightweight =
    opts.disableLightweight === true || envFlagFalse(env, "COUNCILKIT_PROBE_LIGHTWEIGHT");

  const lw = (): LightweightResult =>
    lightweightConnectivityCheck(opts.agent, env, opts.lightweightDeps);

  if (!forceLlm) {
    const cached = cachedSuccess(key, now, ttlMs);
    if (cached) {
      if (disableLightweight) {
        return { ...cached, durationMs: 0, path: "cache" };
      }
      const check = lw();
      if (check.ok && !check.suspicious) {
        return {
          driverId,
          modelId,
          status: "success",
          durationMs: check.durationMs,
          failure: null,
          path: "cache",
        };
      }
      // Suspicious or hard-fail with a stale success → fall through.
    }
  }

  if (!forceLlm && !disableLightweight) {
    const check = lw();
    if (!check.ok) {
      const record: ProbeOutcome = {
        driverId,
        modelId,
        status: "failure",
        durationMs: check.durationMs,
        failure: { code: "DRIVER_UNREACHABLE", message: check.reason },
        path: "lightweight",
      };
      // Do not cache failures.
      return record;
    }
    if (!check.suspicious) {
      const record: ProbeOutcome = {
        driverId,
        modelId,
        status: "success",
        durationMs: check.durationMs,
        failure: null,
        path: "lightweight",
      };
      rememberSuccess(key, record, now);
      return record;
    }
    // Suspicious → escalate to LLM below.
  }

  const llm =
    opts.runLlmProbe ??
    (() =>
      spawnOnce(
        buildProbeSpec(opts.agent, {
          probeId: opts.probeId,
          cwd: opts.cwd,
          prompt: DRIVER_PROBE_PROMPT,
          env,
        }),
        {
          timeoutMs: probeTimeoutMs(driverId),
          signal: opts.signal,
          spawnImpl: opts.spawnImpl,
        },
      ));

  const result = await llm();
  const record: ProbeOutcome = {
    driverId,
    modelId,
    status: result.status,
    durationMs: result.durationMs,
    failure: result.failure ? { code: result.failure.code, message: result.failure.message } : null,
    path: "llm",
  };
  if (record.status === "success") {
    rememberSuccess(key, record, (opts.now ?? Date.now)());
  }
  return record;
}
