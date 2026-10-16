/**
 * Real `runReview` whose first seat never returns. The parent kills -9 this
 * process to leave a mid-run review on disk.
 */
import { DRIVER_PROBE_PROMPT } from "../../src/auto/driver-commands";
import { runReview } from "../../src/commands/review";

const argv = process.argv.slice(2);
const sink = {
  json: false,
  progress(message: string) {
    process.stderr.write(`${message}\n`);
  },
  diag() {},
  finish() {
    return Promise.resolve();
  },
};

// A pending promise does not keep Node alive, and tsx exits 13 on an
// unsettled top-level await once the event loop is empty. This timer is
// the handle the parent SIGKILLs.
const keepAlive = setInterval(() => {}, 60_000);

void runReview(argv, sink, {
  spawnImpl: async (input) => {
    if (input.prompt === DRIVER_PROBE_PROMPT) {
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
        }),
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    process.stderr.write("seat spawn started\n");
    await new Promise(() => {});
    throw new Error("seat hang ended");
  },
}).then(
  () => {
    clearInterval(keepAlive);
    process.stderr.write("HANG_FAIL review returned\n");
    process.exit(1);
  },
  (error: unknown) => {
    clearInterval(keepAlive);
    const message =
      error instanceof Error
        ? (error.stack ?? error.message)
        : typeof error === "object" && error !== null && "exitCode" in error
          ? `ReviewExit ${(error as { exitCode: unknown }).exitCode}`
          : String(error);
    process.stderr.write(`HANG_FAIL ${message}\n`);
    process.exit(1);
  },
);
