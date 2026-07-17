import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { DriverId } from "@shared/runtime/contracts";

/**
 * PATH/well-known discovery of `cld`, `codex` and — for the `cld` composite
 * installation — the underlying `claude` executable.
 *
 * Discovery is metadata-only: candidates are located, never executed (no
 * `--version`, no handshake). First found wins; ordering is the scan order of
 * the inherited PATH followed by the built-in macOS well-known directories.
 */

export type InstallationName = "cld" | "codex";
export type BinaryName = InstallationName | "claude";

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
  /** `cld` composite only: the underlying Claude executable (null = incomplete). */
  claude: DiscoveredCandidate | null;
}

export interface DiscoveryOutcome {
  installations: DiscoveredInstallation[];
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the built-in macOS directories (tests pass temp dirs or []). */
  wellKnownDirs?: string[];
}

const BINARY_NAMES: readonly BinaryName[] = ["cld", "codex", "claude"];

const DRIVER_BY_NAME: Record<InstallationName, DriverId> = {
  cld: "claude-stream-json",
  codex: "codex-app-server",
};

function defaultWellKnownDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
  ];
}

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
  for (const dir of options.wellKnownDirs ?? defaultWellKnownDirs(env)) {
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

export function discoverInstallations(options: DiscoveryOptions = {}): DiscoveryOutcome {
  const dirs = discoveryDirs(options);
  const found = new Map<BinaryName, DiscoveredCandidate>();
  for (const name of BINARY_NAMES) {
    const candidate = findCandidate(dirs, name);
    if (candidate) found.set(name, candidate);
  }
  const installations: DiscoveredInstallation[] = [];
  const cld = found.get("cld");
  if (cld) {
    installations.push({
      name: "cld",
      driverId: DRIVER_BY_NAME.cld,
      wrapper: cld,
      claude: found.get("claude") ?? null,
    });
  }
  const codex = found.get("codex");
  if (codex) {
    installations.push({
      name: "codex",
      driverId: DRIVER_BY_NAME.codex,
      wrapper: codex,
      claude: null,
    });
  }
  return { installations };
}
