/**
 * CLI data-home path math shared by the CLI store and the Runtime Host
 * report reader. No filesystem I/O — callers create/read directories.
 *
 * Priority matches cli/src/store/paths.ts:
 *   1. COUNCILKIT_HOME
 *   2. ${XDG_CONFIG_HOME}/councilkit
 *   3. ${HOME}/.config/councilkit
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { nonBlank } from "./non-blank";

export const CLI_STORE_DIR_NAME = "councilkit" as const;

export function resolveCouncilkitHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonBlank(env.COUNCILKIT_HOME);
  if (override !== undefined) return resolve(override);
  const xdg = nonBlank(env.XDG_CONFIG_HOME);
  if (xdg !== undefined) return resolve(xdg, CLI_STORE_DIR_NAME);
  return resolve(homedir(), ".config", CLI_STORE_DIR_NAME);
}

export function resolveCliRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCouncilkitHome(env), "runs");
}

/**
 * Per-run bare `--shared` clone (runs/<id>/source.git) that receives PR-mode
 * fetches, so a review never writes into the user's .git (#273 SAFE-05).
 * Written by the CLI review; read by the Host review explainer.
 */
export const ISOLATED_SOURCE_DIR = "source.git";
