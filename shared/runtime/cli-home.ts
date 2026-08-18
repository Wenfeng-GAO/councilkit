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

export const CLI_STORE_DIR_NAME = "councilkit" as const;

export function resolveCouncilkitHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COUNCILKIT_HOME;
  if (override !== undefined && override.length > 0) return resolve(override);
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) return resolve(xdg, CLI_STORE_DIR_NAME);
  return resolve(homedir(), ".config", CLI_STORE_DIR_NAME);
}

export function resolveCliRunsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCouncilkitHome(env), "runs");
}
