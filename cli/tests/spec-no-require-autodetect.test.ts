/**
 * #303: `--no-require-spec` + an AUTO-DETECTED document with no acceptance IDs
 * must continue in non-contract mode (one explanatory line), not refuse with
 * SPEC_VERIFY_UNBOUND. An explicit `--spec` without IDs still refuses, and the
 * default require-spec path is unchanged.
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

describe("#303 --no-require-spec with an auto-detected spec that has no acceptance IDs", () => {
  let home: string;
  const oldHome = process.env.COUNCILKIT_HOME;
  const oldPath = process.env.PATH;
  let aliceId: string;
  let bobId: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-spec-nr-"));
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

  function repoWithPlanWithoutIds(): string {
    const repo = join(home, "repo");
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    writeFileSync(
      join(repo, "docs", "plans", "narrative-plan.md"),
      "# Narrative plan\n\nWe will make the room faster. No acceptance section here.\n",
    );
    return repo;
  }

  async function run(extra: string[]) {
    const sink = makeSink();
    const args = [
      "--agents",
      JSON.stringify([aliceId, bobId]),
      "--aggregator",
      "Bob",
      "--task",
      "Review the change described in docs/plans/narrative-plan.md",
      "--repo",
      repoWithPlanWithoutIds(),
      ...extra,
    ];
    let caught: unknown;
    try {
      await runReview(args, sink, { spawnImpl: fakeSpawn() });
    } catch (e) {
      caught = e;
    }
    return { sink, caught };
  }

  it("SPEC-NR-01 --no-require-spec + auto-detected spec without IDs proceeds unbound", async () => {
    const { sink, caught } = await run(["--no-require-spec"]);
    if (!(caught instanceof ReviewExit)) throw caught;
    expect(caught.exitCode).toBe(0);
    expect(
      sink.lines.some(
        (l) =>
          l.includes("narrative-plan.md") &&
          l.includes("但没有验收 ID，按非合同模式审查"),
      ),
    ).toBe(true);
    const finished = sink.finished as { status?: string; failure?: unknown };
    expect(finished?.status).toBe("completed");
    expect(finished?.failure).toBeUndefined();
  });

  it("SPEC-NR-02 explicit --spec without IDs still refuses", async () => {
    const { caught } = await run(["--no-require-spec", "--spec", "docs/plans/narrative-plan.md"]);
    expect(caught).toMatchObject({
      name: "CliError",
      detail: expect.objectContaining({ code: "SPEC_VERIFY_UNBOUND" }),
    });
  });

  it("SPEC-NR-03 default require-spec + auto-detected spec without IDs still refuses", async () => {
    const { caught } = await run([]);
    expect(caught).toMatchObject({
      name: "CliError",
      detail: expect.objectContaining({ code: "SPEC_VERIFY_UNBOUND" }),
    });
  });
});
