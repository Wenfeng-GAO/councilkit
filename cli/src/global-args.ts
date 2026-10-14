/**
 * Split process argv (after the node binary and script path) into the global
 * flags and the leaf command's argv.
 */

/** Long options declared `type: "boolean"` on a leaf command. They do not take the next token. */
export const COMMAND_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--all",
  "--all-clusters",
  "--disabled",
  "--dry-run",
  "--force",
  "--no-push",
  "--no-re-review",
  "--no-require-spec",
  "--plan-only",
  "--re-review-only",
  "--require-spec",
  "--selected",
]);

export interface GlobalArgPartition {
  json: boolean;
  help: boolean;
  version: boolean;
  command: string | undefined;
  rest: string[];
}

export function partitionGlobalArgs(args: readonly string[]): GlobalArgPartition {
  let json = false;
  let help = false;
  let version = false;
  let command: string | undefined;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version") version = true;
    else if (command === undefined && !arg.startsWith("-")) command = arg;
    else rest.push(arg);
  }
  return { json, help, version, command, rest };
}
