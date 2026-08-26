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

export type InstallationName = "cld" | "codex" | "kimi" | "grok" | "cursor-agent";
export type BinaryName = InstallationName | "claude" | "cfuse-claude-code";

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
  /** `cld` composite only: the `cfuse-claude-code` backend the `cfuse` route
   * execs via `CLD_CFUSE_BIN` (null = absent; cfuse route then unavailable). */
  cfuse: DiscoveredCandidate | null;
}

export interface DiscoveryOutcome {
  installations: DiscoveredInstallation[];
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

function defaultWellKnownDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    // kimi-code installs its binary under its own data dir, not always on PATH.
    join(home, ".kimi-code", "bin"),
    // grok TUI installs its binary under ~/.grok/bin (often not on PATH).
    join(home, ".grok", "bin"),
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
      cfuse: found.get("cfuse-claude-code") ?? null,
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
  return { installations };
}
