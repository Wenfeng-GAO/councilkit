import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { DriverId } from "@shared/runtime/contracts";
import { defaultDriverWellKnownBinDirs } from "@shared/runtime/driver-bins";

/**
 * PATH/well-known discovery of `cld`, `codex` and — for the `cld` composite
 * installation — the underlying `claude` executable and the cfuse backend.
 *
 * `cfuse` names are not interchangeable (#371):
 * - `cld` is the wrapper. Routes `ant` / `moonshot` / `deepseek` / `cfuse` are
 *   subcommands, not binaries.
 * - `cfuse-claude-code` is the backend `cld cfuse` execs via `CLD_CFUSE_BIN`.
 *   `cfuse-claude` is the same role when the documented name is absent.
 * - `cfuse` is the standalone CodeFuse CLI. It is not a cld installation.
 *   The CLI autonomous path can run it as the review-security seat; the Host
 *   driver still speaks `cld`'s stream-json session.
 *
 * Discovery is metadata-only: candidates are located, never executed (no
 * `--version`, no handshake). First found wins; ordering is the scan order of
 * the inherited PATH followed by the built-in macOS well-known directories.
 */

export type InstallationName = "cld" | "codex" | "kimi" | "grok" | "cursor-agent";
export type BinaryName =
  | InstallationName
  | "claude"
  | "cfuse-claude-code"
  | "cfuse-claude"
  | "cfuse";

export interface DiscoveredCandidate {
  name: BinaryName;
  /** Path exactly as found (may traverse symlinks; validation pins realpath). */
  path: string;
  source: "path" | "well-known";
  /** Index in the combined scan list; lower wins for same-name duplicates. */
  pathIndex: number;
}

export interface DiscoveredInstallation {
  name: InstallationName;
  driverId: DriverId;
  wrapper: DiscoveredCandidate;
  /** `cld` composite only: the underlying Claude executable (null = absent). */
  claude: DiscoveredCandidate | null;
  /** `cld` composite only: the `cfuse-claude-code` (or `cfuse-claude`) backend
   * the `cfuse` route execs via `CLD_CFUSE_BIN` (null = absent). */
  cfuse: DiscoveredCandidate | null;
}

/** How the cfuse-related binaries on disk relate to a review seat. */
export interface CfuseLayout {
  /** `cld` wrapper, when present. */
  cld: DiscoveredCandidate | null;
  /** Standalone CodeFuse CLI named `cfuse`. */
  standalone: DiscoveredCandidate | null;
  /** Backend for `CLD_CFUSE_BIN`: `cfuse-claude-code`, else `cfuse-claude`. */
  backend: DiscoveredCandidate | null;
  /**
   * `cld` — wrapper seat (backend optional).
   * `standalone` — `cfuse` CLI seat and no `cld`.
   * `backend-only` — `cfuse-claude` or `cfuse-claude-code` without `cld` or standalone `cfuse`.
   * `absent` — none of those binaries.
   */
  seat: "cld" | "standalone" | "backend-only" | "absent";
}

export interface DiscoveryOutcome {
  installations: DiscoveredInstallation[];
  cfuse: CfuseLayout;
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the built-in macOS directories (tests pass temp dirs or []). */
  wellKnownDirs?: string[];
}

const BINARY_NAMES: readonly BinaryName[] = [
  "cld",
  "codex",
  "claude",
  "cfuse-claude-code",
  "cfuse-claude",
  "cfuse",
  "kimi",
  "grok",
  "cursor-agent",
];

const DRIVER_BY_NAME: Record<InstallationName, DriverId> = {
  cld: "claude-stream-json",
  codex: "codex-app-server",
  kimi: "kimi-stream-json",
  grok: "grok-stream-json",
  "cursor-agent": "cursor-stream-json",
};

/** Scan directories in order: inherited PATH first, then well-known dirs. */
export function discoveryDirs(
  options: DiscoveryOptions = {},
): { dir: string; source: "path" | "well-known" }[] {
  const env = options.env ?? process.env;
  const dirs: { dir: string; source: "path" | "well-known" }[] = [];
  const seen = new Set<string>();
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    dirs.push({ dir: entry, source: "path" });
  }
  for (const dir of options.wellKnownDirs ?? defaultDriverWellKnownBinDirs(env)) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push({ dir, source: "well-known" });
  }
  return dirs;
}

function findCandidate(
  dirs: { dir: string; source: "path" | "well-known" }[],
  name: BinaryName,
): DiscoveredCandidate | null {
  for (let index = 0; index < dirs.length; index += 1) {
    const entry = dirs[index] as { dir: string; source: "path" | "well-known" };
    const candidate = join(entry.dir, name);
    try {
      if (statSync(candidate).isFile()) {
        return { name, path: candidate, source: entry.source, pathIndex: index };
      }
    } catch {
      // Missing files and unreadable directories simply yield no candidate.
    }
  }
  return null;
}

export function cfuseLayoutFromCandidates(
  found: ReadonlyMap<BinaryName, DiscoveredCandidate>,
): CfuseLayout {
  const cld = found.get("cld") ?? null;
  const standalone = found.get("cfuse") ?? null;
  const backend = found.get("cfuse-claude-code") ?? found.get("cfuse-claude") ?? null;
  const seat = cld ? "cld" : standalone ? "standalone" : backend ? "backend-only" : "absent";
  return { cld, standalone, backend, seat };
}

export function discoverInstallations(options: DiscoveryOptions = {}): DiscoveryOutcome {
  const dirs = discoveryDirs(options);
  const found = new Map<BinaryName, DiscoveredCandidate>();
  for (const name of BINARY_NAMES) {
    const candidate = findCandidate(dirs, name);
    if (candidate) found.set(name, candidate);
  }
  const cfuse = cfuseLayoutFromCandidates(found);
  const installations: DiscoveredInstallation[] = [];
  const cld = found.get("cld");
  if (cld) {
    installations.push({
      name: "cld",
      driverId: DRIVER_BY_NAME.cld,
      wrapper: cld,
      claude: found.get("claude") ?? null,
      cfuse: cfuse.backend,
    });
  }
  const codex = found.get("codex");
  if (codex) {
    installations.push({
      name: "codex",
      driverId: DRIVER_BY_NAME.codex,
      wrapper: codex,
      claude: null,
      cfuse: null,
    });
  }
  const kimi = found.get("kimi");
  if (kimi) {
    installations.push({
      name: "kimi",
      driverId: DRIVER_BY_NAME.kimi,
      wrapper: kimi,
      claude: null,
      cfuse: null,
    });
  }
  const grok = found.get("grok");
  if (grok) {
    installations.push({
      name: "grok",
      driverId: DRIVER_BY_NAME.grok,
      wrapper: grok,
      claude: null,
      cfuse: null,
    });
  }
  const cursorAgent = found.get("cursor-agent");
  if (cursorAgent) {
    installations.push({
      name: "cursor-agent",
      driverId: DRIVER_BY_NAME["cursor-agent"],
      wrapper: cursorAgent,
      claude: null,
      cfuse: null,
    });
  }
  return { installations, cfuse };
}
