/**
 * `councilkit review --help`. Kept out of main.ts so tests can import it
 * without running the entrypoint.
 */
import { REVIEW_FLAG_HELP } from "./commands/review";

/** Every review flag, generated from the parser's own flag table. */
export const REVIEW_HELP = `councilkit review — independent reviews of one task, then one synthesized report.

Usage:
  councilkit review <pr-url> [options]
  councilkit review --task "<text>" --agents '<json-array>' --aggregator <id> [options]

Options:
${REVIEW_FLAG_HELP}

Seats are read-only by default: no permission-skip flags, each CLI in its own
plan / ask / read-only mode. Only --allow-write (or \`councilkit apply\`) lets
seats edit files or run commands.
`;
