/**
 * Vendor install locations that are often missing from a stripped PATH
 * (launchd, Host-spawned CLI). Host discovery and CLI executable resolution
 * must scan the same directories so a trusted kimi/grok in Settings is also
 * spawnable from 「立即修复」/「只再审一遍」.
 */
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function vendorHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME;
  if (home !== undefined && home.trim().length > 0) return home;
  return homedir();
}

/** kimi-code and grok TUI install under their data dirs, not always on PATH. */
export function vendorDriverBinDirs(home: string): string[] {
  return [join(home, ".kimi-code", "bin"), join(home, ".grok", "bin")];
}

export function defaultDriverWellKnownBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = vendorHome(env);
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    ...vendorDriverBinDirs(home),
  ];
}

/** Append vendor bin dirs that are not already on PATH. PATH order is unchanged. */
export function withDriverWellKnownPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra = vendorDriverBinDirs(vendorHome(env));
  const parts = (env.PATH ?? "").split(delimiter);
  const seen = new Set(parts.filter((dir) => dir.length > 0));
  const appended: string[] = [];
  for (const dir of extra) {
    if (dir.length === 0 || seen.has(dir)) continue;
    seen.add(dir);
    appended.push(dir);
  }
  if (appended.length === 0) return env;
  return { ...env, PATH: [...parts, ...appended].join(delimiter) };
}
