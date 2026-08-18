import { dispatch } from "./cli";
import { ReviewExit } from "./commands/review";
import { RunExit } from "./commands/run";
/**
 * CouncilKit CLI entrypoint (bundled to dist/main.mjs).
 *
 * Strips the global flags (--json/--help/--version), builds the OutputSink,
 * dispatches to a leaf command, and maps every exit path onto the documented
 * exit-code table (0/2/3/4/5/7/130). `--json` discipline: progress/diagnostics
 * to stderr, exactly one final JSON document on stdout; errors are a single
 * redacted JSON object on stdout in --json mode, or a redacted line on stderr
 * in human mode.
 */
import { CliError, EXIT, errors } from "./errors";
import { createOutput, renderErrorHuman } from "./output";
import { redact } from "./redact";

const VERSION = "0.0.1";

const HELP = `councilkit ${VERSION} — multi-agent council orchestration outside the browser.

Usage:
  councilkit --help
  councilkit --version
  councilkit <command> [options] [--json]

Commands:
  init [--force]                      Discover local CLIs and write the default pr-jury roster.
  doctor                              Host reachability, installations, catalog summary.
  models                              Closed set of available driver/route/model.
  agent create|list|show|delete       Manage agents (name + persona + Driver Selection + modelId).
  council create|list|show|delete     Manage councils (topic, agents, rounds, reporter).
  run --council <name|id>             Run a fixed-N-round discussion; emit Markdown report.
  run --agents '<json-array>'         One-shot run without a stored council.
  runs gc [--keep <days>] [--dry-run] [--all]
                                      Delete old runs/<id>/workspaces only
                                      (report.md/transcript.jsonl are always kept).
  review --agents '<json-array>'      N autonomous agents independently review one task,
      --aggregator <id>               then one synthesizes a report. Bypasses the Host.
      [--resume <run-id>]             Reuse successful attempts from a prior run.
  review --council <ref>              Map a stored council (agents→attempts, reporter→aggregator).
  runs list                           List CLI runs (report.md + transcript).
  runs open <run-id>                  Print the in-app URL for a run report.

Global flags:
  --json     Machine-readable output: progress/diagnostics on stderr, one final JSON on stdout.
  --help     Show this help.
  --version  Print the CLI version.

Exit codes:
  0 success | 2 usage/schema/ref/validation | 3 Host unreachable or not ready
  4 run execution failure (turn/Reporter/ACK/SSE/cleanup) | 5 store/report IO
  7 Host quota rejected | 130 SIGINT

The CLI never spawns the Host and holds cookie/CSRF only in process memory.
The CLI and the browser do not share data (separate stores).
`;

function main(argv: string[]): void {
  const args = argv.slice(2);

  // Extract global flags (--json/--help/--version) from anywhere; the remainder
  // is [command, ...commandArgs].
  let json = false;
  let help = false;
  let version = false;
  const rest: string[] = [];
  let command: string | undefined;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version") {
      version = true;
    } else if (command === undefined && !arg.startsWith("-")) {
      command = arg;
    } else {
      rest.push(arg);
    }
  }

  if (help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const out = createOutput(json);

  if (command === undefined) {
    emitError(out, errors.usage("no command given. Run `councilkit --help` for usage."), json);
    process.exit(EXIT.usage);
  }

  dispatch(command, rest, out)
    .then(() => {
      // A command that completes without throwing ran successfully.
      process.exit(EXIT.ok);
    })
    .catch((error: unknown) => {
      if (error instanceof RunExit) {
        process.exit(error.exitCode);
      }
      if (error instanceof ReviewExit) {
        process.exit(error.exitCode);
      }
      if (error instanceof CliError) {
        emitError(out, error, json);
        process.exit(error.exitCode);
      }
      // Unexpected non-CliError: redacted message, exit 4 (CLI/internal fault).
      const message = error instanceof Error ? error.message : String(error);
      emitError(out, errors.runFailed(`unexpected failure: ${redact(message) as string}`), json);
      process.exit(EXIT.runFailed);
    });
}

/** Emit a CliError in the correct stream for the mode. */
function emitError(out: ReturnType<typeof createOutput>, err: CliError, json: boolean): void {
  if (json) {
    // Single redacted JSON error object on stdout (progress was on stderr).
    process.stdout.write(
      `${JSON.stringify(
        redact({
          ok: false,
          error: {
            code: err.exitCode,
            message: err.message,
            detail: err.detail ?? {},
          },
        }),
      )}\n`,
    );
  } else {
    process.stderr.write(`${renderErrorHuman(err)}\n`);
  }
  void out;
}

main(process.argv);
