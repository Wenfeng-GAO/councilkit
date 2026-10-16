/**
 * Split process argv (after the node binary and script path) into the global
 * flags and the leaf command's argv.
 *
 * `--json`, `--help`, `-h`, and `--version` are global only when they are
 * their own option. The next token of a known string option, and any token
 * after `--`, stays in `rest`. An unknown long option does not take the next
 * token, so a typo cannot hide a later global flag.
 */

/** Long options declared `type: "string"` on a leaf command. The next token is their value. */
export const COMMAND_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--against",
  "--agent",
  "--agents",
  "--aggregator",
  "--background",
  "--cluster",
  "--codex-timeout",
  "--color",
  "--concurrency",
  "--config",
  "--council",
  "--debate-rounds",
  "--decision",
  "--driver-id",
  "--execution",
  "--focus",
  "--from",
  "--id",
  "--isolation",
  "--keep",
  "--max-outer-cycles",
  "--model-id",
  "--models",
  "--name",
  "--options",
  "--orchestrator",
  "--out",
  "--persona-prompt",
  "--pin-sha",
  "--planner-b",
  "--pr",
  "--profile",
  "--protocol",
  "--reaggregate",
  "--reason",
  "--repair-package",
  "--repo",
  "--reporter",
  "--resume",
  "--review-models",
  "--reviewer",
  "--revision",
  "--rounds",
  "--run",
  "--run-id",
  "--run-timeout",
  "--spec",
  "--target-output",
  "--task",
  "--timeout",
  "--topic",
  "--verifier",
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
  return COMMAND_VALUE_FLAGS.has(arg);
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
