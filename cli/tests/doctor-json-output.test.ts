/**
 * `councilkit doctor --json` when the Host is down.
 *
 * main strips the global `--json` flag before dispatch, so the command sees an
 * empty argv and a json OutputSink. The startup paragraph is human-only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/commands/doctor";
import { CliError } from "../src/errors";
import { createOutput } from "../src/output";

const UNREACHABLE =
  "Host unreachable at http://127.0.0.1:43127: connect ECONNREFUSED 127.0.0.1:43127\n";
const STARTUP =
  "The Runtime Host is not running. The CLI never spawns it — start it with `pnpm start` (or `pnpm dev`) on http://127.0.0.1:43127, then retry.\n";

describe("doctor output when the Host is down", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function captureStreams(): { stderr: () => string; stdout: () => string } {
    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    return {
      stderr: () => stderr.join(""),
      stdout: () => stdout.join(""),
    };
  }

  function hostDown(): void {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("connect ECONNREFUSED 127.0.0.1:43127")));
  }

  it("prints only the diagnostic on stderr for a json sink", async () => {
    hostDown();
    const streams = captureStreams();

    const error = await runDoctor([], createOutput(true)).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(3);
    expect(streams.stderr()).toBe(UNREACHABLE);
    expect(streams.stdout()).toBe("");
  });

  it("prints the startup paragraph on stdout in human mode", async () => {
    hostDown();
    const streams = captureStreams();

    const error = await runDoctor([], createOutput(false)).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(3);
    expect(streams.stdout()).toBe(STARTUP);
    expect(streams.stderr()).toBe(UNREACHABLE);
  });
});
