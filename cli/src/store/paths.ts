import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
/**
 * XDG-style data-home resolution (brief §2b, D1 §11). Priority:
 *   1. COUNCILKIT_HOME          (explicit override; tests pin a temp dir)
 *   2. ${XDG_CONFIG_HOME}/councilkit
 *   3. ${HOME}/.config/councilkit
 *
 * The home dir is created 0700; managed files are written 0600. The store is
 * secret-free by construction, but the permissions still avoid needless local
 * exposure (D1 §11).
 */
import { CLI_STORE_DIR_NAME, resolveCouncilkitHome } from "@shared/runtime/cli-home";

export const STORE_DIR_NAME = CLI_STORE_DIR_NAME;

export function councilkitHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCouncilkitHome(env);
}

export interface StorePaths {
  home: string;
  agents: string;
  councils: string;
  /** Root for run artifacts: `<home>/runs/<run-id>/`. */
  runsRoot: string;
  runDir: (runId: string) => string;
  transcript: (runId: string) => string;
  report: (runId: string) => string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): StorePaths {
  const home = councilkitHome(env);
  const runsRoot = join(home, "runs");
  return {
    home,
    agents: join(home, "agents.json"),
    councils: join(home, "councils.json"),
    runsRoot,
    runDir: (runId) => join(runsRoot, runId),
    transcript: (runId) => join(runsRoot, runId, "transcript.jsonl"),
    report: (runId) => join(runsRoot, runId, "report.md"),
  };
}

/** Ensure the home dir exists with 0700 perms. Throws a redacted IO error on
 * failure. Safe to call repeatedly. */
export function ensureHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = councilkitHome(env);
  if (!existsSync(home)) {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch (cause) {
      throw new Error(`could not create councilkit home dir (path redacted): ${ioReason(cause)}`);
    }
  }
  return home;
}

/** Ensure a single run directory exists (0700). */
export function ensureRunDir(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  ensureHome(env);
  const { runDir } = resolvePaths(env);
  const dir = runDir(runId);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (cause) {
      throw new Error(`could not create run dir (path redacted): ${ioReason(cause)}`);
    }
  }
  return dir;
}

function ioReason(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === "Error" ? "IO failure" : cause.name;
  }
  return "IO failure";
}
