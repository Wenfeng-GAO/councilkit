/**
 * review command: arg-validation matrix + an end-to-end run with a fake spawn
 * (zero real processes, plan §测试). Asserts the report's five aggregation
 * sections + per-attempt appendix, the transcript kind sequence, and `--out`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { dispatch } from "../src/cli";
import { ReviewExit, runReview } from "../src/commands/review";
import { CliError } from "../src/errors";
import { Store } from "../src/store/store";

interface FakeSink {
  json: boolean;
  lines: string[];
  finished: unknown;
  progress(m: string): void;
  diag(m: string): void;
  finish(d: unknown): void;
}

function makeSink(): FakeSink {
  const sink: FakeSink = {
    json: false,
    lines: [],
    finished: undefined,
    progress: (m) => sink.lines.push(m),
    diag: () => {},
    finish: (d) => {
      sink.finished = d;
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

/** Fake spawn: returns a per-attempt review or an aggregation, keyed on prompt. */
function fakeSpawn(): SpawnImpl {
  return async (input: SpawnInput) => {
    const p = input.prompt;
    if (p.includes("对比汇总")) {
      return claudeEnvelope(
        [
          "## Overview",
          "synthesized summary",
          "## Consensus findings",
          "- shared issue",
          "## Unique findings",
          "- only one agent saw X",
          "## Disagreements",
          "A vs B on severity",
          "## Verdict",
          "approve",
        ].join("\n"),
      );
    }
    const firstLine = p.split("\n")[0] ?? "";
    const m = /^你是 (.+)，一位独立代码审查者。/.exec(firstLine);
    const name = m?.[1] ?? "unknown";
    return claudeEnvelope(
      [
        "## Findings",
        `- [major] file.ts:1 — finding from ${name}`,
        "## Verification",
        "未验证",
        "## Verdict",
        "comment",
      ].join("\n"),
    );
  };
}

describe("cli review command — argument matrix", () => {
  let home: string;
  const oldHome = process.env.COUNCILKIT_HOME;
  const oldPath = process.env.PATH;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-review-"));
    process.env.COUNCILKIT_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) process.env.PATH = undefined;
    else process.env.PATH = oldPath;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function expectUsage(args: string[], fragment: string): Promise<void> {
    try {
      await runReview(args, makeSink(), { spawnImpl: fakeSpawn() });
      throw new Error("expected runReview to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain(fragment);
    }
  }

  it("rejects --pr and --task together", async () => {
    await expectUsage(["--agents", "[]", "--pr", "x", "--task", "y"], "mutually exclusive");
  });

  it("rejects --timeout above the 32-bit setTimeout ceiling", async () => {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    store.createAgent({
      name: "A",
      personaPrompt: "p",
      modelId: "m",
      color: "#112233",
      driverSelection: ds,
    });
    await expectUsage(
      ["--agents", `["A"]`, "--aggregator", "A", "--pr", "x", "--timeout", "99999999h"],
      "<= 2147483647ms",
    );
  });

  it("rejects when neither --pr nor --task is given", async () => {
    await expectUsage(["--agents", "[]"], "one of --pr or --task");
  });

  it("rejects --council with --agents", async () => {
    await expectUsage(["--council", "c", "--agents", "[]", "--pr", "x"], "mutually exclusive");
  });

  it("rejects --council with --aggregator", async () => {
    await expectUsage(["--council", "c", "--aggregator", "a", "--pr", "x"], "mutually exclusive");
  });

  it("rejects --aggregator not among --agents", async () => {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    store.createAgent({
      name: "A",
      personaPrompt: "p",
      modelId: "m",
      color: "#112233",
      driverSelection: ds,
    });
    store.createAgent({
      name: "B",
      personaPrompt: "p",
      modelId: "m",
      color: "#445566",
      driverSelection: ds,
    });
    // B exists (so it resolves) but is not in the --agents list.
    await expectUsage(["--agents", `["A"]`, "--aggregator", "B", "--pr", "x"], "among --agents");
  });

  it("dispatch routes `review` to runReview (usage when no task)", async () => {
    const sink = makeSink();
    await expect(dispatch("review", ["--agents", "[]"], sink)).rejects.toBeInstanceOf(CliError);
  });

  it("rejects a disabled agent before any cost is incurred", async () => {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    store.createAgent({
      name: "Off",
      personaPrompt: "p",
      modelId: "m",
      color: "#112233",
      driverSelection: ds,
      enabled: false,
    });
    await expectUsage(["--agents", `["Off"]`, "--aggregator", "Off", "--task", "x"], "disabled");
  });

  it("rejects blank --task (whitespace only)", async () => {
    await expectUsage(["--agents", "[]", "--task", "   "], "empty or whitespace");
  });

  it("rejects blank --pr (whitespace only)", async () => {
    await expectUsage(["--agents", "[]", "--pr", "  "], "empty or whitespace");
  });
});

describe("cli review command — end-to-end (fake spawn)", () => {
  let home: string;
  let oldHome: string | undefined;
  let oldPath: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-review-e2e-"));
    oldHome = process.env.COUNCILKIT_HOME;
    oldPath = process.env.PATH;
    process.env.COUNCILKIT_HOME = home;
    // Provide fake cld/kimi/codex on PATH so buildSpawnSpec resolves executables.
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cld"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "kimi"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    for (const name of ["cld", "kimi", "codex"]) chmodSync(join(bin, name), 0o755);
    process.env.PATH = bin;
  });
  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) process.env.PATH = undefined;
    else process.env.PATH = oldPath;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function seed(): { agentIds: string[]; aggregatorName: string } {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    const a = store.createAgent({
      name: "Alice",
      personaPrompt: "senior",
      modelId: "antchat/GLM-5.2",
      color: "#111111",
      driverSelection: ds,
    });
    const b = store.createAgent({
      name: "Bob",
      personaPrompt: "security",
      modelId: "antchat/GLM-5.2",
      color: "#222222",
      driverSelection: ds,
    });
    const c = store.createAgent({
      name: "Carol",
      personaPrompt: "performance",
      modelId: "antchat/GLM-5.2",
      color: "#333333",
      driverSelection: ds,
    });
    return { agentIds: [a.id, b.id, c.id], aggregatorName: "Bob" };
  }

  it("runs 3 attempts + aggregation, writes report/transcript, --out copy, exit 0", async () => {
    const { agentIds, aggregatorName } = seed();
    const sink = makeSink();
    const outPath = join(home, "out-report.md");
    let exitCode = -1;
    try {
      await runReview(
        [
          "--agents",
          JSON.stringify(agentIds),
          "--aggregator",
          aggregatorName,
          "--pr",
          "https://github.com/Wenfeng-GAO/councilkit/pull/1",
          "--out",
          outPath,
        ],
        sink,
        { spawnImpl: fakeSpawn() },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(0);

    const outcome = sink.finished as {
      status: string;
      reportPath: string;
      transcriptPath: string;
      attemptFailures: unknown[];
      incomplete: boolean;
    };
    expect(outcome.status).toBe("completed");
    expect(outcome.attemptFailures).toHaveLength(0);
    expect(outcome.incomplete).toBe(false);

    const report = readFileSync(outcome.reportPath, "utf8");
    // Five aggregation sections.
    expect(report).toContain("## Overview");
    expect(report).toContain("## Consensus findings");
    expect(report).toContain("## Unique findings");
    expect(report).toContain("## Disagreements");
    expect(report).toContain("## Verdict");
    // Appendix with each attempt named + the aggregator's own attempt output.
    expect(report).toContain("## Appendix: per-attempt outputs");
    expect(report).toContain("Alice");
    expect(report).toContain("Bob");
    expect(report).toContain("Carol");
    // Deterministic header.
    expect(report).toContain("# Autonomous Review Report");
    // --out copy written.
    const copy = readFileSync(outPath, "utf8");
    expect(copy).toBe(report);

    // Transcript kind sequence.
    const transcriptLines = readFileSync(outcome.transcriptPath, "utf8").trim().split("\n");
    const records = transcriptLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const kinds = records.map((r) => r.kind);
    expect(kinds).toEqual([
      "review.started",
      "attempt.finished",
      "attempt.finished",
      "attempt.finished",
      "aggregation.finished",
      "review.finished",
    ]);
    // Each attempt.finished carries its final output; aggregation.finished the synthesis.
    const attemptRecs = records.filter((r) => r.kind === "attempt.finished");
    expect(
      attemptRecs.every((r) => typeof r.output === "string" && (r.output as string).length > 0),
    ).toBe(true);
    const aggRec = records.find((r) => r.kind === "aggregation.finished");
    expect(
      typeof aggRec?.output === "string" && (aggRec.output as string).includes("## Overview"),
    ).toBe(true);
  });

  it("SIGINT during aggregation → interrupted, exit 130, transcript/report persisted", async () => {
    const { agentIds, aggregatorName } = seed();
    const sink = makeSink();
    const ac = new AbortController();
    const spawn: SpawnImpl = async (input) => {
      if (input.prompt.includes("对比汇总")) {
        // SIGINT fires mid-aggregation.
        ac.abort();
        return { stdout: "", exitCode: null, timedOut: false, aborted: true };
      }
      return claudeEnvelope("## Findings\n- ok\n## Verification\n未验证\n## Verdict\ncomment");
    };
    let exitCode = -1;
    try {
      await runReview(
        ["--agents", JSON.stringify(agentIds), "--aggregator", aggregatorName, "--task", "x"],
        sink,
        { spawnImpl: spawn, abortController: ac },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(130);
    const outcome = sink.finished as {
      status: string;
      exitCode: number;
      reportPath: string;
      transcriptPath: string;
    };
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(130);
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("interrupted");
    expect(report).toContain("Reason:");
    expect(report).not.toContain("## Overview");
    const transcriptLines = readFileSync(outcome.transcriptPath, "utf8").trim().split("\n");
    const last = JSON.parse(transcriptLines[transcriptLines.length - 1] ?? "") as Record<
      string,
      unknown
    >;
    expect(last.kind).toBe("review.finished");
    expect(last.status).toBe("interrupted");
  });

  it("--out copy IO failure → exit 5, canonical report still complete, review.finished persisted", async () => {
    const { agentIds, aggregatorName } = seed();
    const sink = makeSink();
    // Make `blocker` a plain file so a path under it cannot be written.
    const blocker = join(home, "blocker");
    writeFileSync(blocker, "x");
    const badOut = join(blocker, "out.md");
    let exitCode = -1;
    try {
      await runReview(
        [
          "--agents",
          JSON.stringify(agentIds),
          "--aggregator",
          aggregatorName,
          "--task",
          "x",
          "--out",
          badOut,
        ],
        sink,
        { spawnImpl: fakeSpawn() },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(5);
    const outcome = sink.finished as {
      status: string;
      exitCode: number;
      reportPath: string;
      transcriptPath: string;
      failure?: { phase: string };
    };
    expect(outcome.exitCode).toBe(5);
    expect(outcome.status).toBe("completed");
    expect(outcome.failure?.phase).toBe("out");
    // Canonical report is intact and complete.
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("## Overview");
    const transcriptLines = readFileSync(outcome.transcriptPath, "utf8").trim().split("\n");
    const last = JSON.parse(transcriptLines[transcriptLines.length - 1] ?? "") as Record<
      string,
      unknown
    >;
    expect(last.kind).toBe("review.finished");
    expect((last.failure as { phase: string }).phase).toBe("out");
  });

  it("maps --council (agents→attempts, reporter→aggregator, topic injected)", async () => {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    const a = store.createAgent({
      name: "A",
      personaPrompt: "reviewer",
      modelId: "m",
      color: "#111111",
      driverSelection: ds,
    });
    const b = store.createAgent({
      name: "B",
      personaPrompt: "reviewer",
      modelId: "m",
      color: "#222222",
      driverSelection: ds,
    });
    const council = store.createCouncil({
      name: "rev-council",
      topic: "my council topic",
      agentIds: [a.id, b.id],
      rounds: 3, // ignored by review
      reporterAgentId: b.id,
    });
    const sink = makeSink();
    let exitCode = -1;
    try {
      await runReview(
        [
          "--council",
          council.name,
          "--task",
          "review the diff",
          "--timeout",
          "5m",
          "--concurrency",
          "2",
        ],
        sink,
        { spawnImpl: fakeSpawn() },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(0);
    const outcome = sink.finished as { attempts: { agentName: string }[] };
    expect(outcome.attempts.map((x) => x.agentName).sort()).toEqual(["A", "B"]);
  });

  it("all attempts failing → status failed, exit 4, no aggregation body", async () => {
    const { agentIds, aggregatorName } = seed();
    const sink = makeSink();
    const failing: SpawnImpl = async () => ({
      stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "" }),
      exitCode: 1,
      timedOut: false,
      aborted: false,
    });
    let exitCode = -1;
    try {
      await runReview(
        ["--agents", JSON.stringify(agentIds), "--aggregator", aggregatorName, "--task", "x"],
        sink,
        { spawnImpl: failing },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(4);
    const outcome = sink.finished as {
      status: string;
      incomplete: boolean;
      attemptFailures: unknown[];
    };
    expect(outcome.status).toBe("failed");
    expect(outcome.incomplete).toBe(true);
    expect(outcome.attemptFailures).toHaveLength(3);
    const report = readFileSync((sink.finished as { reportPath: string }).reportPath, "utf8");
    expect(report).toContain("INCOMPLETE");
    expect(report).not.toContain("## Overview");
  });

  it("partial failure (one attempt fails) → completed + incomplete, aggregation still runs", async () => {
    const { agentIds, aggregatorName } = seed();
    const sink = makeSink();
    const mixed: SpawnImpl = async (input) => {
      if (input.prompt.includes("对比汇总"))
        return claudeEnvelope("## Overview\n## Verdict\napprove");
      const firstLine = input.prompt.split("\n")[0] ?? "";
      const m = /^你是 (.+)，一位独立代码审查者。/.exec(firstLine);
      const name = m?.[1] ?? "x";
      if (name === "Alice") {
        return {
          stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "" }),
          exitCode: 1,
          timedOut: false,
          aborted: false,
        };
      }
      return claudeEnvelope(
        `## Findings\n- ok from ${name}\n## Verification\n未验证\n## Verdict\ncomment`,
      );
    };
    let exitCode = -1;
    try {
      await runReview(
        ["--agents", JSON.stringify(agentIds), "--aggregator", aggregatorName, "--task", "x"],
        sink,
        { spawnImpl: mixed },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(0);
    const outcome = sink.finished as {
      status: string;
      incomplete: boolean;
      attemptFailures: unknown[];
    };
    expect(outcome.status).toBe("completed");
    expect(outcome.incomplete).toBe(true);
    expect(outcome.attemptFailures).toHaveLength(1);
  });
});
