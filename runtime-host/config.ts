import { fileURLToPath } from "node:url";
import {
  CANONICAL_HOST_HEADER,
  CANONICAL_PORT,
  SUPPORTED_NODE_MAJOR,
} from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const mode = resolveHostMode(env);
  const watchdogProgram =
    mode === "production"
      ? fileURLToPath(new URL("./watchdog-child.mjs", import.meta.url))
      : fileURLToPath(new URL("./process/watchdog-child.mjs", import.meta.url));
  const distDir = fileURLToPath(new URL("../dist", import.meta.url));
  const driverWorkRoot = fileURLToPath(new URL("../.runtime-host/work", import.meta.url));
  return {
    mode,
    hostname: "127.0.0.1",
    port: CANONICAL_PORT,
    hostHeader: CANONICAL_HOST_HEADER,
    distDir,
    watchdogProgram,
    driverWorkRoot,
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
