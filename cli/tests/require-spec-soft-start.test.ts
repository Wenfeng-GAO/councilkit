/**
 * Soft-start for SPEC_REQUIRED: command entry / Host start must not exit solely
 * for a missing auto-detected spec; refusal happens in the review stage when
 * --require-spec (default) and still unbound. --no-require-spec continues.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { ReviewExit, runReview } from "../src/commands/review";
import { Store } from "../src/store/store";

function makeSink() {
  const sink = {
    json: false,
    lines: [] as string[],
    finished: undefined as unknown,
    progress(m: string) {
      sink.lines.push(m);
    },
    diag() {},
    finish(d: unknown) {
      sink.finished = d;
      return Promise.resolve();
    },
  };
  return sink;
}

function claudeEnvelope(text: string): SpawnOutput {
  return {
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }),
    exitCode: 0,
    timedOut: false,
    aborted: false,
  };
}

function fakeSpawn(): SpawnImpl {
  return async (input: SpawnInput) => {
    if (input.prompt.includes("对比汇总")) {
      return claudeEnvelope("## Overview\nok\n## Verdict\napprove\n");
    }
    return claudeEnvelope(
      "## Findings\n- [nit] ok\n## Verification\n未验证\n## Verdict\ncomment\n",
    );
  };
}

describe("require-spec soft-start", () => {
  let home: string;
  const oldHome = process.env.COUNCILKIT_HOME;
  const oldPath = process.env.PATH;
  let aliceId: string;
  let bobId: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-soft-spec-"));
    process.env.COUNCILKIT_HOME = home;
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["cld", "kimi", "codex"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = `${bin}${oldPath ? `:${oldPath}` : ""}`;
    const store = new Store();
    const alice = store.createAgent({
      name: "Alice",
      personaPrompt: "a",
      modelId: "m",
      color: "#000000",
      driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
    });
    const bob = store.createAgent({
      name: "Bob",
      personaPrompt: "b",
      modelId: "m",
      color: "#111111",
      driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
    });
    aliceId = alice.id;
    bobId = bob.id;
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.COUNCILKIT_HOME;
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("soft-start: require-spec default does not throw SPEC_REQUIRED before run scaffold", async () => {
    const sink = makeSink();
    const args = [
      "--agents",
      JSON.stringify([aliceId, bobId]),
      "--aggregator",
      "Bob",
      "--task",
      "no conventional contract here",
      "--require-spec",
    ];
    let caught: unknown;
    try {
      await runReview(args, sink, { spawnImpl: fakeSpawn() });
    } catch (e) {
      caught = e;
    }
    // Must have created a run (soft-start past command entry).
    expect(sink.lines.some((l) => /review ck-review-/.test(l))).toBe(true);
    expect(sink.lines.some((l) => /soft-start|unbound/.test(l))).toBe(true);
    // Mid-stage refuse: ReviewExit usage (2) after finalize.
    expect(caught).toBeInstanceOf(ReviewExit);
    expect((caught as ReviewExit).exitCode).toBe(2);
    const finished = sink.finished as { failure?: { code?: string }; status?: string };
    expect(finished?.failure?.code).toBe("SPEC_REQUIRED");
    expect(finished?.status).toBe("failed");
  });

  it("--no-require-spec continues without a bound contract", async () => {
    const sink = makeSink();
    const args = [
      "--agents",
      JSON.stringify([aliceId, bobId]),
      "--aggregator",
      "Bob",
      "--task",
      "legacy unbound review",
      "--no-require-spec",
    ];
    let exitCode = -1;
    try {
      await runReview(args, sink, { spawnImpl: fakeSpawn() });
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(0);
    expect(sink.lines.some((l) => /non-contract|--no-require-spec/.test(l))).toBe(true);
    const finished = sink.finished as { status?: string; failure?: unknown };
    expect(finished?.status).toBe("completed");
    expect(finished?.failure).toBeUndefined();
  });

  it("rejects --require-spec together with --no-require-spec", async () => {
    await expect(
      runReview(
        [
          "--agents",
          JSON.stringify([aliceId]),
          "--aggregator",
          "Alice",
          "--task",
          "x",
          "--require-spec",
          "--no-require-spec",
        ],
        makeSink(),
      ),
    ).rejects.toMatchObject({
      name: "CliError",
      message: expect.stringContaining("mutually exclusive"),
    });
  });
});
