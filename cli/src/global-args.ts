/**
 * Split process argv (after the node binary and script path) into the global
 * flags and the leaf command's argv.
 *
 * `--json`, `--help`, `-h`, and `--version` are global only when they are
 * their own option. A value of a preceding long option, and any token after
 * `--`, stays in `rest` so the leaf parser sees it.
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

function consumesNextToken(arg: string): boolean {
  if (!arg.startsWith("--") || arg.length <= 2 || arg.includes("=")) return false;
  return !COMMAND_BOOLEAN_FLAGS.has(arg);
}

export function partitionGlobalArgs(args: readonly string[]): GlobalArgPartition {
  let json = false;
  let help = false;
  let version = false;
  let command: string | undefined;
  let endOfOptions = false;
  let expectValue = false;
  const rest: string[] = [];

  for (const arg of args) {
    if (expectValue) {
      expectValue = false;
      if (arg === "--") endOfOptions = true;
      rest.push(arg);
      continue;
    }

    if (arg === "--") {
      endOfOptions = true;
      rest.push(arg);
      continue;
    }

    if (!endOfOptions && arg === "--json") {
      json = true;
      continue;
    }
    if (!endOfOptions && (arg === "--help" || arg === "-h")) {
      help = true;
      continue;
    }
    if (!endOfOptions && arg === "--version") {
      version = true;
      continue;
    }

    if (command === undefined && !arg.startsWith("-")) {
      command = arg;
      continue;
    }

    rest.push(arg);
    if (!endOfOptions && consumesNextToken(arg)) expectValue = true;
  }

  return { json, help, version, command, rest };
}
