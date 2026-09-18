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

/** User-installed CLIs (antcode 1.1 `pr show`, cld shims) live here and must
 * beat Homebrew's older same-named binaries on a launchd PATH. */
export function userCliBinDirs(home: string): string[] {
  return [join(home, ".local", "bin"), join(home, "bin")];
}

export function preferredCliBinDirs(home: string): string[] {
  return [...userCliBinDirs(home), ...vendorDriverBinDirs(home)];
}

export function defaultDriverWellKnownBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = vendorHome(env);
  return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...preferredCliBinDirs(home)];
}

/** Put user/vendor bin dirs first so Host-spawned review/fix sees the same
 * `antcode`/`kimi` as an interactive shell. Homebrew stays on PATH after. */
export function withDriverWellKnownPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const prefer = preferredCliBinDirs(vendorHome(env));
  const rest = (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir.length > 0 && !prefer.includes(dir));
  return { ...env, PATH: [...prefer, ...rest].join(delimiter) };
}
