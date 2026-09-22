import { fileURLToPath } from "node:url";
import {
  CANONICAL_HOST_HEADER,
  CANONICAL_PORT,
  SUPPORTED_NODE_MAJOR,
} from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";
import { DEFAULT_IDLE_SCOPE_TTL_MS } from "./scopes/scope-manager";

export type HostMode = "development" | "production";

/**
 * Baked into the production bundle by scripts/build-host.mjs (esbuild define).
 * Undefined in dev/typecheck, where the environment decides.
 */
declare const __COUNCILKIT_BUILD_MODE__: string | undefined;

export function resolveHostMode(env: NodeJS.ProcessEnv = process.env): HostMode {
  if (
    typeof __COUNCILKIT_BUILD_MODE__ !== "undefined" &&
    __COUNCILKIT_BUILD_MODE__ === "production"
  ) {
    return "production";
  }
  return env.COUNCILKIT_MODE === "production" ? "production" : "development";
}

export interface HostConfig {
  mode: HostMode;
  hostname: string;
  port: number;
  hostHeader: string;
  /** Absolute path of the built UI directory served in production. */
  distDir: string;
  /** Absolute path of the watchdog child program. */
  watchdogProgram: string;
  /**
   * Absolute path of the directory used for Participant-isolated driver cwds.
   * Created on demand, never shared between Participants.
   */
  driverWorkRoot: string;
  /** Idle scope reaper deadline (ms since the last execution terminal).
   * Optional: the scope manager falls back to its own 30min default, so
   * existing literal HostConfig constructions keep compiling. */
  idleScopeTtlMs?: number;
}

/**
 * E2E/test escape hatch: bind an isolated port instead of the canonical one.
 * The canonical origin (43127) is a product constraint — a `COUNCILKIT_PORT`
 * override is therefore only honored inside E2E runs (COUNCILKIT_E2E=1, set
 * by the Playwright webServer). Anywhere else the override is rejected loudly
 * instead of silently moving the origin, and the value itself must be a
 * strict integer string ("123abc" and friends never parse into a port).
 */
export function resolveHostPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COUNCILKIT_PORT;
  if (raw === undefined || raw === "") return CANONICAL_PORT;
  if (env.COUNCILKIT_E2E !== "1") {
    throw new Error(
      `COUNCILKIT_PORT override is only allowed for E2E hosts (COUNCILKIT_E2E=1); the canonical Host port stays ${CANONICAL_PORT}`,
    );
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`COUNCILKIT_PORT must be a valid TCP port, got "${raw}"`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`COUNCILKIT_PORT must be a valid TCP port, got "${raw}"`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const mode = resolveHostMode(env);
  const port = resolveHostPort(env);
  const watchdogProgram =
    mode === "production"
      ? fileURLToPath(new URL("./watchdog-child.mjs", import.meta.url))
      : fileURLToPath(new URL("./process/watchdog-child.mjs", import.meta.url));
  const distDir = fileURLToPath(new URL("../dist", import.meta.url));
  const driverWorkRoot = fileURLToPath(new URL("../.runtime-host/work", import.meta.url));
  return {
    mode,
    hostname: "127.0.0.1",
    port,
    hostHeader: port === CANONICAL_PORT ? CANONICAL_HOST_HEADER : `127.0.0.1:${String(port)}`,
    distDir,
    watchdogProgram,
    driverWorkRoot,
    idleScopeTtlMs: DEFAULT_IDLE_SCOPE_TTL_MS,
  };
}

export interface NodeCheckResult {
  ok: boolean;
  version: string;
  major: number;
  error?: RuntimeError;
}

/** Node.js 22 is a hard acceptance requirement, not optional hardening. */
export function checkNodeVersion(version: string = process.version): NodeCheckResult {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10);
  if (major === SUPPORTED_NODE_MAJOR) {
    return { ok: true, version, major };
  }
  return {
    ok: false,
    version,
    major,
    error: makeError(
      "UNSUPPORTED_NODE",
      "bootstrap",
      `CouncilKit Runtime Host requires Node.js ${SUPPORTED_NODE_MAJOR}.x (current: ${version}).`,
      { retryable: false },
    ),
  };
}
