import { execFileSync } from "node:child_process";
/**
 * review command: arg-validation matrix + an end-to-end run with a fake spawn
 * (zero real processes, plan §测试). Asserts the report's five aggregation
 * sections + per-attempt appendix, the transcript kind sequence, and `--out`.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_PROBE_PROMPT } from "../src/auto/driver-commands";
import type { RunnerTimers, SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { readReviewTranscript } from "../src/auto/transcript";
import { dispatch } from "../src/cli";
import { ReviewExit, runReview } from "../src/commands/review";
import { CliError } from "../src/errors";
import { resolvePaths } from "../src/store/paths";
import { Store } from "../src/store/store";

interface FakeSink {
  json: boolean;
  lines: string[];
  finished: unknown;
  progress(m: string): void;
  diag(m: string): void;
  finish(d: unknown): Promise<void>;
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
    await expectUsage(["--agents", "[]"], "one of a PR URL, --pr, or --task");
  });

  it("rejects a non-URL positional", async () => {
    await expectUsage(["not-a-url"], "must be a PR URL");
  });

  it("rejects a positional URL together with --pr", async () => {
    await expectUsage(
      ["https://example.com/p/1", "--pr", "https://example.com/p/1"],
      "positional or --pr, not both",
    );
  });

  it("defaults to pr-jury and errors when it is missing", async () => {
    await expectUsage(["https://example.com/p/1"], "default pr-jury is missing");
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

  it("rejects --against without a prior report", async () => {
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
      [
        "--agents",
        `["A"]`,
        "--aggregator",
        "A",
        "--task",
        "x",
        "--against",
        "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      ],
      "no report.md or findings.json",
    );
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

  it("PR review without --repo or a matching cwd clone is a usage error", async () => {
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
      ["--agents", `["A"]`, "--aggregator", "A", "--pr", "https://github.com/acme/other/pull/1"],
      "no local clone",
    );
  });

  it("rejects blank --pr (whitespace only)", async () => {
    await expectUsage(["--agents", "[]", "--pr", "  "], "empty or whitespace");
  });

  it("rejects --run-id together with --resume", async () => {
    const runId = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9";
    await expectUsage(
      ["--agents", "[]", "--aggregator", "A", "--task", "x", "--run-id", runId, "--resume", runId],
      "mutually exclusive",
    );
  });

  it("rejects --run-id that is not a ck-review-uuid", async () => {
    await expectUsage(
      ["--agents", "[]", "--aggregator", "A", "--task", "x", "--run-id", "not-a-run-id"],
      "ck-review-",
    );
  });

  it("rejects --run-id when transcript.jsonl already exists", async () => {
    const runId = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9";
    const dir = join(home, "runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript.jsonl"), "{}\n");
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
      ["--agents", `["A"]`, "--aggregator", "A", "--task", "x", "--run-id", runId],
      "already exists",
    );
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
    process.env.PATH = `${bin}${oldPath ? `:${oldPath}` : ""}`;
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

  function seedGitRepo(): string {
    const dir = join(home, "src-repo");
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
    return dir;
  }

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
          "--repo",
          seedGitRepo(),
          "--out",
          outPath,
        ],
        sink,
        { spawnImpl: fakeSpawn(), worktreeRef: "HEAD" },
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
    expect(report).toContain("## 附录:各审查者交付物");
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

    const statusPath = join(dirname(outcome.transcriptPath), "status.json");
    expect(existsSync(statusPath)).toBe(true);
    const live = JSON.parse(readFileSync(statusPath, "utf8")) as {
      status: string;
      progress: { phase: string; attempts: unknown[] };
    };
    expect(live.status).toBe("completed");
    expect(live.progress.phase).toBe("done");
    expect(live.progress.attempts.length).toBe(4);
  });

  it("honors --run-id for a new run (onRunCreated / report path)", async () => {
    const { agentIds, aggregatorName } = seed();
    const sink = makeSink();
    const runId = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9";
    let created: string | undefined;
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
          "--run-id",
          runId,
        ],
        sink,
        {
          spawnImpl: fakeSpawn(),
          onRunCreated: (id) => {
            created = id;
          },
        },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(0);
    expect(created).toBe(runId);
    const outcome = sink.finished as { runId: string; reportPath: string };
    expect(outcome.runId).toBe(runId);
    expect(outcome.reportPath).toContain(runId);
  });

  it("positional PR URL uses default pr-jury", async () => {
    const { agentIds, aggregatorName } = seed();
    const store = new Store();
    const reporter = store.getAgent(aggregatorName);
    store.createCouncil({
      name: "pr-jury",
      topic: "jury",
      background: "bg",
      targetOutput: "out",
      agentIds,
      rounds: 1,
      reporterAgentId: reporter.id,
    });
    const sink = makeSink();
    let exitCode = -1;
    try {
      await runReview(["https://github.com/acme/repo/pull/9", "--repo", seedGitRepo()], sink, {
        spawnImpl: fakeSpawn(),
        worktreeRef: "HEAD",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    expect(exitCode).toBe(0);
    const outcome = sink.finished as { status: string };
    expect(outcome.status).toBe("completed");
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
    // Probes succeed (P1-1): this test exercises ATTEMPT failure. A driver the
    // probe cannot reach is a different semantic — exit 3, covered separately.
    const failing: SpawnImpl = async (input) => {
      if (input.prompt === DRIVER_PROBE_PROMPT) return claudeEnvelope("ok");
      return {
        stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "" }),
        exitCode: 1,
        timedOut: false,
        aborted: false,
      };
    };
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

/**
 * P1-1 probes / P2-2 resume / P1-4 killed / P2-1 heartbeat hardening coverage.
 * Same fake-spawn discipline as the e2e block above: zero real processes.
 */
describe("cli review command — probes, resume, killed, heartbeat", () => {
  let home: string;
  let oldHome: string | undefined;
  let oldPath: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-review-hard-"));
    oldHome = process.env.COUNCILKIT_HOME;
    oldPath = process.env.PATH;
    process.env.COUNCILKIT_HOME = home;
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

  const AGGREGATION_TEXT = [
    "## Overview",
    "synthesized",
    "## Consensus findings",
    "- s",
    "## Unique findings",
    "- u",
    "## Disagreements",
    "none",
    "## Verdict",
    "approve",
  ].join("\n");

  type SpawnKind = "probe" | "aggregation" | `attempt:${string}`;

  function classify(input: SpawnInput): SpawnKind {
    if (input.prompt === DRIVER_PROBE_PROMPT) return "probe";
    if (input.prompt.includes("对比汇总")) return "aggregation";
    const m = /^你是 (.+)，一位独立代码审查者。/.exec(input.prompt.split("\n")[0] ?? "");
    return `attempt:${m?.[1] ?? "unknown"}`;
  }

  function attemptEnvelope(name: string): SpawnOutput {
    return claudeEnvelope(
      `## Findings\n- ok from ${name}\n## Verification\n未验证\n## Verdict\ncomment`,
    );
  }

  function seedTwo(): { aliceId: string; bobId: string } {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    const a = store.createAgent({
      name: "Alice",
      personaPrompt: "senior",
      modelId: "m",
      color: "#111111",
      driverSelection: ds,
    });
    const b = store.createAgent({
      name: "Bob",
      personaPrompt: "security",
      modelId: "m",
      color: "#222222",
      driverSelection: ds,
    });
    return { aliceId: a.id, bobId: b.id };
  }

  function twoAgentArgs(aliceId: string, bobId: string, task: string): string[] {
    return ["--agents", JSON.stringify([aliceId, bobId]), "--aggregator", "Bob", "--task", task];
  }

  async function runCapturing(
    args: string[],
    sink: FakeSink,
    deps: { spawnImpl: SpawnImpl; timers?: RunnerTimers; heartbeatIntervalMs?: number },
  ): Promise<number> {
    let exitCode = -1;
    try {
      await runReview(args, sink, deps);
    } catch (e) {
      expect(e).toBeInstanceOf(ReviewExit);
      exitCode = (e as ReviewExit).exitCode;
    }
    return exitCode;
  }

  type Rec = Record<string, unknown> & { kind: string };

  function readRecords(transcriptPath: string): Rec[] {
    return readFileSync(transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Rec);
  }

  /** Write a pre-hardening transcript: no `probe` on review.started, no
   * `activity` on attempt.finished. Must stay readable by --resume. */
  function writeLegacyTranscript(opts: {
    runId: string;
    task: string;
    attempts: Array<{ attemptId: string; agentId: string; agentName: string }>;
    aggregator: { agentId: string; agentName: string };
    finished: Array<Record<string, unknown>>;
  }): void {
    const paths = resolvePaths();
    mkdirSync(paths.runDir(opts.runId), { recursive: true });
    const started = {
      kind: "review.started",
      version: 1,
      runId: opts.runId,
      startedAt: "2026-07-01T00:00:00.000Z",
      task: { task: opts.task },
      attempts: opts.attempts.map((a) => ({
        ...a,
        driverId: "claude-stream-json",
        modelId: "m",
      })),
      aggregator: {
        attemptId: "aggregator",
        agentId: opts.aggregator.agentId,
        agentName: opts.aggregator.agentName,
        driverId: "claude-stream-json",
        modelId: "m",
      },
      // no probe field — legacy transcript
    };
    const records = [
      started,
      ...opts.finished,
      {
        kind: "review.finished",
        version: 1,
        status: "completed",
        endedAt: "2026-07-01T00:01:00.000Z",
      },
    ];
    writeFileSync(
      paths.transcript(opts.runId),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
  }

  interface FakeTimerControl {
    timers: RunnerTimers;
    advance(ms: number): void;
    fire(): void;
    activeCount(): number;
  }

  function makeFakeTimers(): FakeTimerControl {
    let now = 0;
    let nextId = 1;
    const intervals = new Map<number, () => void>();
    return {
      timers: {
        now: () => now,
        setInterval: (cb: () => void) => {
          const id = nextId++;
          intervals.set(id, cb);
          return id;
        },
        clearInterval: (handle: unknown) => {
          intervals.delete(handle as number);
        },
      },
      advance: (ms) => {
        now += ms;
      },
      fire: () => {
        for (const cb of [...intervals.values()]) cb();
      },
      activeCount: () => intervals.size,
    };
  }

  it("aggregator driver probe failing → exit 3, attempts cancelled, no workspace, no aggregation", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink = makeSink();
    const calls: SpawnInput[] = [];
    const alwaysFail: SpawnImpl = async (input) => {
      calls.push(input);
      return {
        stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "" }),
        exitCode: 1,
        timedOut: false,
        aborted: false,
      };
    };
    const exitCode = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink, {
      spawnImpl: alwaysFail,
    });
    expect(exitCode).toBe(3);
    // Only the deduped probe ran — attempts and aggregation never spawned.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe(DRIVER_PROBE_PROMPT);

    const outcome = sink.finished as {
      status: string;
      incomplete: boolean;
      runId: string;
      reportPath: string;
      transcriptPath: string;
      failure?: { phase: string; code: string };
    };
    expect(outcome.status).toBe("failed");
    expect(outcome.incomplete).toBe(true);
    expect(outcome.failure?.phase).toBe("probe");
    expect(outcome.failure?.code).toBe("DRIVER_UNREACHABLE");
    // No workspace was ever created (the run aborts before workspace creation).
    expect(existsSync(join(resolvePaths().runDir(outcome.runId), "workspaces"))).toBe(false);
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("INCOMPLETE");
    expect(report).not.toContain("## Overview");
    const records = readRecords(outcome.transcriptPath);
    const started = records.find((r) => r.kind === "review.started");
    const probe = started?.probe as Array<{ status: string }>;
    expect(probe).toHaveLength(1);
    expect(probe[0]?.status).toBe("failure");
    const attemptRecs = records.filter((r) => r.kind === "attempt.finished");
    expect(attemptRecs).toHaveLength(2);
    // The attempts share the Aggregator's driver, so each carries its own
    // synthetic DRIVER_UNREACHABLE (the run still aborts before the runner).
    expect(
      attemptRecs.every(
        (r) => (r.failure as { code: string } | null)?.code === "DRIVER_UNREACHABLE",
      ),
    ).toBe(true);
    expect(records.some((r) => r.kind === "aggregation.finished")).toBe(false);
  });

  it("aggregator-only probe failure cancels attempts whose own driver is healthy (CANCELLED)", async () => {
    const store = new Store();
    const claude = {
      driverId: "claude-stream-json" as const,
      options: { route: "cfuse" as const },
    };
    const kimi = { driverId: "kimi-stream-json" as const, options: {} };
    const a = store.createAgent({
      name: "Alice",
      personaPrompt: "p",
      modelId: "m",
      color: "#111111",
      driverSelection: claude,
    });
    const b = store.createAgent({
      name: "Bob",
      personaPrompt: "p",
      modelId: "kimi-code/k3",
      color: "#222222",
      driverSelection: kimi,
    });
    const sink = makeSink();
    const spawn: SpawnImpl = async (input) => {
      if (input.prompt === DRIVER_PROBE_PROMPT) {
        // Only the Aggregator's driver (kimi) is unreachable.
        if (input.driverId === "kimi-stream-json") {
          return { stdout: "", exitCode: 1, timedOut: false, aborted: false };
        }
        return claudeEnvelope("ok");
      }
      const kind = classify(input);
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      return attemptEnvelope("Alice");
    };
    const exitCode = await runCapturing(
      ["--agents", JSON.stringify([a.id, b.id]), "--aggregator", "Bob", "--task", "x"],
      sink,
      { spawnImpl: spawn },
    );
    expect(exitCode).toBe(3);
    const outcome = sink.finished as {
      transcriptPath: string;
      attempts: Array<{ agentName: string; failure?: { code: string } }>;
    };
    // Alice's own driver probed fine, but the run aborted before the runner:
    // her attempt is CANCELLED; Bob's carries DRIVER_UNREACHABLE.
    const alice = outcome.attempts.find((x) => x.agentName === "Alice");
    const bob = outcome.attempts.find((x) => x.agentName === "Bob");
    expect(alice?.failure?.code).toBe("CANCELLED");
    expect(bob?.failure?.code).toBe("DRIVER_UNREACHABLE");
    const records = readRecords(outcome.transcriptPath);
    expect(records.some((r) => r.kind === "aggregation.finished")).toBe(false);
  });

  it("probes a shared driver exactly once, before any workspace exists", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink = makeSink();
    let probeCalls = 0;
    let workspaceExistedAtProbe = true;
    const spawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      if (kind === "probe") {
        probeCalls++;
        const { runsRoot } = resolvePaths();
        workspaceExistedAtProbe =
          existsSync(runsRoot) &&
          readdirSync(runsRoot).some((d) => existsSync(join(runsRoot, d, "workspaces")));
        return claudeEnvelope("ok");
      }
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      return attemptEnvelope(kind === "attempt:Alice" ? "Alice" : "Bob");
    };
    const exitCode = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink, {
      spawnImpl: spawn,
    });
    expect(exitCode).toBe(0);
    expect(probeCalls).toBe(1);
    expect(workspaceExistedAtProbe).toBe(false);
    const records = readRecords((sink.finished as { transcriptPath: string }).transcriptPath);
    const started = records.find((r) => r.kind === "review.started");
    const probe = started?.probe as Array<{ status: string; driverId: string }>;
    expect(probe).toHaveLength(1);
    expect(probe[0]?.status).toBe("success");
  });

  it("a non-aggregator driver probe failure skips only its attempts (DRIVER_UNREACHABLE)", async () => {
    const store = new Store();
    const claude = {
      driverId: "claude-stream-json" as const,
      options: { route: "cfuse" as const },
    };
    const kimi = { driverId: "kimi-stream-json" as const, options: {} };
    const a = store.createAgent({
      name: "Alice",
      personaPrompt: "p",
      modelId: "m",
      color: "#111111",
      driverSelection: claude,
    });
    const b = store.createAgent({
      name: "Bob",
      personaPrompt: "p",
      modelId: "m",
      color: "#222222",
      driverSelection: claude,
    });
    const c = store.createAgent({
      name: "Carol",
      personaPrompt: "p",
      modelId: "kimi-code/k3",
      color: "#333333",
      driverSelection: kimi,
    });
    const sink = makeSink();
    const probedDrivers: (string | undefined)[] = [];
    const spawn: SpawnImpl = async (input) => {
      if (input.prompt === DRIVER_PROBE_PROMPT) {
        probedDrivers.push(input.driverId);
        if (input.driverId === "kimi-stream-json") {
          return { stdout: "", exitCode: 1, timedOut: false, aborted: false };
        }
        return claudeEnvelope("ok");
      }
      const kind = classify(input);
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      return attemptEnvelope(kind === "attempt:Alice" ? "Alice" : "Bob");
    };
    const exitCode = await runCapturing(
      ["--agents", JSON.stringify([a.id, b.id, c.id]), "--aggregator", "Bob", "--task", "x"],
      sink,
      { spawnImpl: spawn },
    );
    expect(exitCode).toBe(0);
    // Each distinct driver probed exactly once.
    expect(probedDrivers.sort()).toEqual(["claude-stream-json", "kimi-stream-json"]);
    const outcome = sink.finished as {
      status: string;
      incomplete: boolean;
      runId: string;
      reportPath: string;
      attempts: Array<{
        agentName: string;
        status: string;
        exitCode: unknown;
        failure?: { code: string };
      }>;
      attemptFailures: Array<{ agentName: string; code: string }>;
    };
    expect(outcome.status).toBe("completed");
    expect(outcome.incomplete).toBe(true);
    expect(outcome.attemptFailures).toHaveLength(1);
    expect(outcome.attemptFailures[0]?.code).toBe("DRIVER_UNREACHABLE");
    const carol = outcome.attempts.find((x) => x.agentName === "Carol");
    expect(carol?.status).toBe("failure");
    expect(carol?.exitCode).toBeNull();
    // Aggregation still ran on the surviving attempts.
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("## Overview");
    // Carol's attempt never got a workspace; the others (and the aggregator) did.
    const wsRoot = join(resolvePaths().runDir(outcome.runId), "workspaces");
    expect(existsSync(join(wsRoot, "attempt-2"))).toBe(false);
    expect(existsSync(join(wsRoot, "attempt-0"))).toBe(true);
    expect(existsSync(join(wsRoot, "aggregator"))).toBe(true);
  });

  it("--resume reruns only failed attempts; reused attempts keep their history", async () => {
    const { aliceId, bobId } = seedTwo();
    // First run: Alice's attempt fails, Bob's succeeds.
    const firstSpawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      if (kind === "attempt:Alice") {
        return { stdout: "", exitCode: 1, timedOut: false, aborted: false };
      }
      return attemptEnvelope("Bob");
    };
    const sink1 = makeSink();
    const exit1 = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink1, {
      spawnImpl: firstSpawn,
    });
    expect(exit1).toBe(0);
    const runId = (sink1.finished as { runId: string }).runId;

    // Resume: only Alice's attempt may spawn again.
    const spawned: SpawnKind[] = [];
    const secondSpawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      spawned.push(kind);
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      return attemptEnvelope("Alice");
    };
    const sink2 = makeSink();
    const exit2 = await runCapturing(
      [...twoAgentArgs(aliceId, bobId, "x"), "--resume", runId],
      sink2,
      { spawnImpl: secondSpawn },
    );
    expect(exit2).toBe(0);
    expect(spawned).toEqual(["probe", "attempt:Alice", "aggregation"]);

    const outcome = sink2.finished as {
      incomplete: boolean;
      reportPath: string;
      transcriptPath: string;
      attempts: Array<{ agentName: string; reused?: boolean }>;
    };
    expect(outcome.incomplete).toBe(false);
    expect(outcome.attempts.find((x) => x.agentName === "Bob")?.reused).toBe(true);
    const records = readRecords(outcome.transcriptPath);
    const resumed = records.find((r) => r.kind === "review.resumed");
    expect(resumed?.reusedAttemptIds).toEqual(["attempt-1"]);
    expect(resumed?.rerunAttemptIds).toEqual(["attempt-0"]);
    // No NEW attempt.finished for the reused attempt — the history already has one.
    const bobRecs = records.filter((r) => r.kind === "attempt.finished" && r.agentName === "Bob");
    expect(bobRecs).toHaveLength(1);
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("[reused]");
  });

  it("--resume with every attempt successful spawns zero attempts but still probes + re-aggregates", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink1 = makeSink();
    const exit1 = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink1, {
      spawnImpl: fakeSpawn(),
    });
    expect(exit1).toBe(0);
    const runId = (sink1.finished as { runId: string }).runId;

    const spawned: SpawnKind[] = [];
    const secondSpawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      spawned.push(kind);
      if (kind === "probe") return claudeEnvelope("ok");
      return claudeEnvelope(AGGREGATION_TEXT);
    };
    const sink2 = makeSink();
    const exit2 = await runCapturing(
      [...twoAgentArgs(aliceId, bobId, "x"), "--resume", runId],
      sink2,
      { spawnImpl: secondSpawn },
    );
    expect(exit2).toBe(0);
    // Zero attempt spawns; the Aggregator driver is still probed (aggregation
    // always re-runs) and the aggregation itself re-runs.
    expect(spawned).toEqual(["probe", "aggregation"]);
    const records = readRecords((sink2.finished as { transcriptPath: string }).transcriptPath);
    const resumed = records.find((r) => r.kind === "review.resumed");
    expect(resumed?.reusedAttemptIds).toEqual(["attempt-0", "attempt-1"]);
    expect(resumed?.rerunAttemptIds).toEqual([]);
  });

  it("--resume rejects mismatched immutable inputs and unsafe run ids (exit 2)", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink1 = makeSink();
    const exit1 = await runCapturing(twoAgentArgs(aliceId, bobId, "original"), sink1, {
      spawnImpl: fakeSpawn(),
    });
    expect(exit1).toBe(0);
    const runId = (sink1.finished as { runId: string }).runId;

    const expectUsage = async (args: string[], fragment: string): Promise<void> => {
      try {
        await runReview(args, makeSink(), { spawnImpl: fakeSpawn() });
        throw new Error("expected runReview to throw");
      } catch (e) {
        const err = e as CliError;
        expect(err).toBeInstanceOf(CliError);
        expect(err.exitCode).toBe(2);
        expect(err.message).toContain(fragment);
      }
    };
    await expectUsage(
      [...twoAgentArgs(aliceId, bobId, "changed"), "--resume", runId],
      "must match the resumed run",
    );
    await expectUsage(
      [
        "--agents",
        JSON.stringify([bobId, aliceId]),
        "--aggregator",
        "Bob",
        "--task",
        "original",
        "--resume",
        runId,
      ],
      "must match the resumed run",
    );
    await expectUsage(
      [...twoAgentArgs(aliceId, bobId, "original"), "--resume", "../escape"],
      "ck-review-",
    );
  });

  it("--resume rejects a transcript whose review.started runId does not match (exit 2)", async () => {
    const { aliceId, bobId } = seedTwo();
    const runId = "ck-review-66666666-7777-4888-8999-000000000000";
    writeLegacyTranscript({
      runId,
      task: "t",
      attempts: [
        { attemptId: "attempt-0", agentId: aliceId, agentName: "Alice" },
        { attemptId: "attempt-1", agentId: bobId, agentName: "Bob" },
      ],
      aggregator: { agentId: bobId, agentName: "Bob" },
      finished: [],
    });
    // Corrupt the linkage: the started record claims a DIFFERENT run id.
    const transcriptPath = resolvePaths().transcript(runId);
    const text = readFileSync(transcriptPath, "utf8");
    writeFileSync(
      transcriptPath,
      text.replace(
        `"runId":"${runId}"`,
        '"runId":"ck-review-ffffffff-ffff-4fff-8fff-ffffffffffff"',
      ),
    );
    try {
      await runReview([...twoAgentArgs(aliceId, bobId, "t"), "--resume", runId], makeSink(), {
        spawnImpl: fakeSpawn(),
      });
      throw new Error("expected runReview to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain("does not match");
    }
  });

  it("--resume refuses a corrupt transcript line (exit 5, line number, no echo)", async () => {
    const { aliceId, bobId } = seedTwo();
    const runId = "ck-review-12345678-9abc-4def-8abc-def012345678";
    writeLegacyTranscript({
      runId,
      task: "t",
      attempts: [
        { attemptId: "attempt-0", agentId: aliceId, agentName: "Alice" },
        { attemptId: "attempt-1", agentId: bobId, agentName: "Bob" },
      ],
      aggregator: { agentId: bobId, agentName: "Bob" },
      finished: [],
    });
    const transcriptPath = resolvePaths().transcript(runId);
    const expectCorrupt = async (fragment: string): Promise<void> => {
      try {
        await runReview([...twoAgentArgs(aliceId, bobId, "t"), "--resume", runId], makeSink(), {
          spawnImpl: fakeSpawn(),
        });
        throw new Error("expected runReview to throw");
      } catch (e) {
        const err = e as CliError;
        expect(err).toBeInstanceOf(CliError);
        expect(err.exitCode).toBe(5);
        expect(err.message).toContain(fragment);
        expect(err.message).not.toContain("SECRET-MARKER");
      }
    };
    // A non-JSON line (line 3) carrying a secret-shaped marker: reported by
    // line number, content NEVER echoed back.
    writeFileSync(
      transcriptPath,
      `${readFileSync(transcriptPath, "utf8")}not-json-SECRET-MARKER\n`,
    );
    await expectCorrupt("line 3");
    // A schema-mismatching record line is likewise fatal.
    const valid = readFileSync(transcriptPath, "utf8").trim().split("\n").slice(0, 2);
    writeFileSync(
      transcriptPath,
      `${valid.join("\n")}\n{"kind":"attempt.finished","SECRET-MARKER":1}\n`,
    );
    await expectCorrupt("line 3");
  });

  it("--resume refuses to rebuild workspaces when the run dir is a symlink (exit 5, outside untouched)", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink1 = makeSink();
    const exit1 = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink1, {
      spawnImpl: fakeSpawn(),
    });
    expect(exit1).toBe(0);
    const runId = (sink1.finished as { runId: string }).runId;

    // Swap the whole run dir for a symlink to an outside tree (the transcript
    // comes along, so the resume gets as far as the workspace rebuild).
    const runDir = resolvePaths().runDir(runId);
    const outside = join(home, "outside-run");
    renameSync(runDir, outside);
    writeFileSync(join(outside, "precious.txt"), "keep me");
    symlinkSync(outside, runDir);

    try {
      await runReview([...twoAgentArgs(aliceId, bobId, "x"), "--resume", runId], makeSink(), {
        spawnImpl: fakeSpawn(),
      });
      throw new Error("expected runReview to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
      expect(err.message).toContain("not a real directory");
    }
    // Nothing was deleted through the symlink.
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(lstatSync(runDir).isSymbolicLink()).toBe(true);
  });

  it("--resume validates a symlinked run dir BEFORE any read/write: artifacts through the link stay byte-identical", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink1 = makeSink();
    const exit1 = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink1, {
      spawnImpl: fakeSpawn(),
    });
    expect(exit1).toBe(0);
    const runId = (sink1.finished as { runId: string }).runId;

    const runDir = resolvePaths().runDir(runId);
    const transcriptBefore = readFileSync(join(runDir, "transcript.jsonl"), "utf8");
    const reportBefore = readFileSync(join(runDir, "report.md"), "utf8");

    // Swap the run dir for a symlink to the real tree: with the run-dir check
    // ordered after the transcript load / probes / review.resumed append, the
    // resume would atomically rewrite the transcript THROUGH the link before
    // being refused (reviewer finding).
    const outside = join(home, "outside-run");
    renameSync(runDir, outside);
    symlinkSync(outside, runDir);

    try {
      await runReview([...twoAgentArgs(aliceId, bobId, "x"), "--resume", runId], makeSink(), {
        spawnImpl: fakeSpawn(),
      });
      throw new Error("expected runReview to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
      expect(err.message).toContain("not a real directory");
    }
    // No review.resumed append, no transcript rewrite, no report re-render —
    // everything reachable through the symlink is byte-identical.
    expect(readFileSync(join(outside, "transcript.jsonl"), "utf8")).toBe(transcriptBefore);
    expect(readFileSync(join(outside, "report.md"), "utf8")).toBe(reportBefore);
    expect(lstatSync(runDir).isSymbolicLink()).toBe(true);
  });

  it("--resume keeps the entry-bound runs root: a root swapped after entry makes every later write fail (exit 5)", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink1 = makeSink();
    const exit1 = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink1, {
      spawnImpl: fakeSpawn(),
    });
    expect(exit1).toBe(0);
    const runId = (sink1.finished as { runId: string }).runId;

    const { runsRoot } = resolvePaths();
    const transcriptBefore = readFileSync(join(runsRoot, runId, "transcript.jsonl"), "utf8");

    // Swap the runs root AFTER the entry validation but BEFORE the first
    // resume write: the probe spawn is the first thing to run after the entry
    // checks, so the fake performs the swap there. A delete + fresh real
    // directory keeps the realpath string but changes the inode — exactly the
    // swap a plain realpath re-check (or a fresh re-bind of the CURRENT root)
    // cannot see; only the carried entry binding detects it (reviewer
    // finding).
    let swapped = false;
    const swapSpawn: SpawnImpl = async (input) => {
      if (!swapped) {
        swapped = true;
        renameSync(runsRoot, `${runsRoot}.orig`);
        mkdirSync(runsRoot);
      }
      return fakeSpawn()(input);
    };

    try {
      await runReview([...twoAgentArgs(aliceId, bobId, "x"), "--resume", runId], makeSink(), {
        spawnImpl: swapSpawn,
      });
      throw new Error("expected runReview to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
      expect(err.message).toContain("trusted root changed");
    }
    // The replacement root was never written to: no review.resumed append, no
    // recreated run dir, no workspace rebuild.
    expect(readdirSync(runsRoot)).toEqual([]);
    // The original tree (moved aside by the swap) stays byte-identical.
    expect(readFileSync(join(`${runsRoot}.orig`, runId, "transcript.jsonl"), "utf8")).toBe(
      transcriptBefore,
    );
  });

  it("retry workspace rebuild revalidates the bound root; a same-path swap is fail-closed exit 5 (phase=workspace)", async () => {
    // Reviewer findings: (1) the retry path's recreateWorkspace reused the
    // long-held TrustedRoot without revalidating — a same-path REPLACEMENT of
    // runsRoot (delete + fresh real directory) keeps the realpath string but
    // changes dev/ino, so the assertWithinRoot realpath check alone cannot see
    // it and the retry would rmSync inside the swapped tree. (3) when the
    // retry rebuild threw, the run-level catch mapped every error to
    // phase=transcript/code=IO_TRANSCRIPT; a workspace/fs-safe fault must be
    // reported as phase=workspace.
    const { aliceId, bobId } = seedTwo();
    const { runsRoot } = resolvePaths();
    // Fresh run, serial (--concurrency 1) so Alice's first try + retry is
    // deterministic. Alice's first try fails with a transient EXIT (<120s) →
    // the runner retries, rebuilding her workspace first. Swap runsRoot DURING
    // that first spawn: rename it aside and recreate the run dir at the SAME
    // lexical path so later transcript writes still resolve.
    let swapped = false;
    const swapSpawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      if (kind === "attempt:Alice" && !swapped) {
        swapped = true;
        renameSync(runsRoot, `${runsRoot}.orig`);
        // Recreate the swapped tree's attempt-0 workspace (input.cwd is the
        // lexical runsRoot/.../attempt-0 path, now pointing at the new root).
        mkdirSync(input.cwd, { recursive: true });
        writeFileSync(join(input.cwd, "sentinel.txt"), "swap-tree");
        // Transient EXIT failure with a duration well under the 120s retry cap.
        return { stdout: "", exitCode: 1, timedOut: false, aborted: false };
      }
      return attemptEnvelope(kind === "attempt:Bob" ? "Bob" : "Alice");
    };
    const sink = makeSink();
    const exitCode = await runCapturing(
      [...twoAgentArgs(aliceId, bobId, "x"), "--concurrency", "1"],
      sink,
      { spawnImpl: swapSpawn },
    );
    // The retry rebuild's revalidate refuses the swapped root → exit 5.
    expect(exitCode).toBe(5);
    const outcome = sink.finished as {
      incomplete: boolean;
      runId: string;
      failure?: { phase: string; code: string; message: string };
    };
    expect(outcome.incomplete).toBe(true);
    // Finding 3: the fault is reported as phase=workspace, not transcript.
    expect(outcome.failure?.phase).toBe("workspace");
    expect(outcome.failure?.code).toBe("IO_WORKSPACE");
    expect(outcome.failure?.message).toContain("trusted root changed");
    // Finding 1: the swapped tree's workspace was NOT deleted (revalidate threw
    // before rmSync) — the sentinel survives.
    expect(
      readFileSync(
        join(runsRoot, outcome.runId, "workspaces", "attempt-0", "sentinel.txt"),
        "utf8",
      ),
    ).toBe("swap-tree");
  });

  /** Legacy-transcript resume where both attempts are reused: only the
   * aggregator workspace is recreated. */
  function seedReusedResume(runId: string): { aliceId: string; bobId: string } {
    const { aliceId, bobId } = seedTwo();
    const finishedFor = (attemptId: string, agentName: string): Record<string, unknown> => ({
      kind: "attempt.finished",
      version: 1,
      attemptId,
      agentName,
      driverId: "claude-stream-json",
      status: "success",
      output: `legacy output from ${agentName}`,
      exitCode: 0,
      durationMs: 5,
      failure: null,
    });
    writeLegacyTranscript({
      runId,
      task: "legacy task",
      attempts: [
        { attemptId: "attempt-0", agentId: aliceId, agentName: "Alice" },
        { attemptId: "attempt-1", agentId: bobId, agentName: "Bob" },
      ],
      aggregator: { agentId: bobId, agentName: "Bob" },
      finished: [finishedFor("attempt-0", "Alice"), finishedFor("attempt-1", "Bob")],
    });
    return { aliceId, bobId };
  }

  it("--resume refuses to DELETE through a symlinked workspaces dir (exit 5, outside untouched)", async () => {
    const runId = "ck-review-22222222-2222-4222-8222-222222222222";
    const { aliceId, bobId } = seedReusedResume(runId);
    // An intermediate symlink: runDir is real, but runDir/workspaces points to
    // an outside tree holding an aggregator workspace with precious content.
    const runDir = resolvePaths().runDir(runId);
    const outside = join(home, "outside-ws");
    mkdirSync(join(outside, "aggregator"), { recursive: true });
    writeFileSync(join(outside, "aggregator", "precious.txt"), "keep me");
    symlinkSync(outside, join(runDir, "workspaces"));

    try {
      await runReview(
        [...twoAgentArgs(aliceId, bobId, "legacy task"), "--resume", runId],
        makeSink(),
        { spawnImpl: fakeSpawn() },
      );
      throw new Error("expected runReview to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
    }
    // Nothing deleted through the intermediate symlink, symlink left in place.
    expect(readFileSync(join(outside, "aggregator", "precious.txt"), "utf8")).toBe("keep me");
    expect(lstatSync(join(runDir, "workspaces")).isSymbolicLink()).toBe(true);
  });

  it("--resume refuses to CREATE a workspace through a symlinked workspaces dir (exit 5, outside stays empty)", async () => {
    const runId = "ck-review-33333333-3333-4333-8333-333333333333";
    const { aliceId, bobId } = seedReusedResume(runId);
    // The workspace does NOT exist yet (outside dir is empty): the create path
    // used to skip validation entirely and would mkdir through the link, then
    // spawn a high-permission attempt with that external cwd (reviewer finding).
    const runDir = resolvePaths().runDir(runId);
    const outside = join(home, "outside-empty");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(runDir, "workspaces"));

    try {
      await runReview(
        [...twoAgentArgs(aliceId, bobId, "legacy task"), "--resume", runId],
        makeSink(),
        { spawnImpl: fakeSpawn() },
      );
      throw new Error("expected runReview to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
    }
    // Nothing created outside the runs tree; the symlink was never followed.
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(runDir, "workspaces")).isSymbolicLink()).toBe(true);
  });

  it("readReviewTranscript: only ENOENT returns [], other read failures are exit 5", () => {
    // A directory path makes readFileSync fail with EISDIR (not ENOENT).
    const dir = resolvePaths().runDir("ck-review-dir");
    mkdirSync(dir, { recursive: true });
    try {
      readReviewTranscript(dir);
      throw new Error("expected readReviewTranscript to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
      expect(err.message).toContain("failed to read review transcript");
    }
    expect(readReviewTranscript(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("--resume rebuilds rerun + aggregator workspaces pristine; a reused attempt's workspace is untouched", async () => {
    const { aliceId, bobId } = seedTwo();
    // First run: Alice's attempt fails, Bob's succeeds.
    const firstSpawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      if (kind === "attempt:Alice") {
        return { stdout: "", exitCode: 1, timedOut: false, aborted: false };
      }
      return attemptEnvelope("Bob");
    };
    const sink1 = makeSink();
    const exit1 = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink1, {
      spawnImpl: firstSpawn,
    });
    expect(exit1).toBe(0);
    const runId = (sink1.finished as { runId: string }).runId;

    // Plant stale leftovers in every workspace — including a stale codex-style
    // `.last-message.md` that a no-output rerun could otherwise pass off as
    // this round's deliverable.
    const wsRoot = join(resolvePaths().runDir(runId), "workspaces");
    for (const dir of ["attempt-0", "attempt-1", "aggregator"]) {
      writeFileSync(join(wsRoot, dir, "stale.txt"), "leftover");
      writeFileSync(join(wsRoot, dir, ".last-message.md"), "stale deliverable");
    }

    const secondSpawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      return attemptEnvelope("Alice");
    };
    const sink2 = makeSink();
    const exit2 = await runCapturing(
      [...twoAgentArgs(aliceId, bobId, "x"), "--resume", runId],
      sink2,
      { spawnImpl: secondSpawn },
    );
    expect(exit2).toBe(0);

    // Rerun attempt + aggregator: recreated EMPTY (stale files gone).
    expect(existsSync(join(wsRoot, "attempt-0"))).toBe(true);
    expect(existsSync(join(wsRoot, "attempt-0", "stale.txt"))).toBe(false);
    expect(existsSync(join(wsRoot, "attempt-0", ".last-message.md"))).toBe(false);
    expect(existsSync(join(wsRoot, "aggregator"))).toBe(true);
    expect(existsSync(join(wsRoot, "aggregator", "stale.txt"))).toBe(false);
    // Reused attempt (Bob): workspace neither recreated nor deleted.
    expect(readFileSync(join(wsRoot, "attempt-1", "stale.txt"), "utf8")).toBe("leftover");
  });

  it("--resume reads a legacy transcript (no probe/activity), reuses successes, creates no workspace for them", async () => {
    const { aliceId, bobId } = seedTwo();
    const runId = "ck-review-11111111-2222-4333-8444-555555555555";
    const finishedFor = (attemptId: string, agentName: string): Record<string, unknown> => ({
      kind: "attempt.finished",
      version: 1,
      attemptId,
      agentName,
      driverId: "claude-stream-json",
      status: "success",
      output: `legacy output from ${agentName}`,
      exitCode: 0,
      durationMs: 5,
      failure: null,
      // no activity field — legacy record
    });
    writeLegacyTranscript({
      runId,
      task: "legacy task",
      attempts: [
        { attemptId: "attempt-0", agentId: aliceId, agentName: "Alice" },
        { attemptId: "attempt-1", agentId: bobId, agentName: "Bob" },
      ],
      aggregator: { agentId: bobId, agentName: "Bob" },
      finished: [finishedFor("attempt-0", "Alice"), finishedFor("attempt-1", "Bob")],
    });

    const spawned: SpawnKind[] = [];
    const spawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      spawned.push(kind);
      if (kind === "probe") return claudeEnvelope("ok");
      return claudeEnvelope(AGGREGATION_TEXT);
    };
    const sink = makeSink();
    const exitCode = await runCapturing(
      [...twoAgentArgs(aliceId, bobId, "legacy task"), "--resume", runId],
      sink,
      { spawnImpl: spawn },
    );
    expect(exitCode).toBe(0);
    expect(spawned).toEqual(["probe", "aggregation"]);
    const outcome = sink.finished as { reportPath: string };
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("[reused]");
    expect(report).toContain("无过程数据");
    // Reused attempts got no workspace; only the Aggregator did.
    const wsRoot = join(resolvePaths().runDir(runId), "workspaces");
    expect(readdirSync(wsRoot)).toEqual(["aggregator"]);
  });

  it("--resume lets the LAST attempt.finished win (a later failure erases an earlier success)", async () => {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    const a = store.createAgent({
      name: "Alice",
      personaPrompt: "p",
      modelId: "m",
      color: "#111111",
      driverSelection: ds,
    });
    const runId = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    writeLegacyTranscript({
      runId,
      task: "t",
      attempts: [{ attemptId: "attempt-0", agentId: a.id, agentName: "Alice" }],
      aggregator: { agentId: a.id, agentName: "Alice" },
      finished: [
        {
          kind: "attempt.finished",
          version: 1,
          attemptId: "attempt-0",
          agentName: "Alice",
          driverId: "claude-stream-json",
          status: "success",
          output: "old good output",
          exitCode: 0,
          durationMs: 5,
          failure: null,
        },
        {
          kind: "attempt.finished",
          version: 1,
          attemptId: "attempt-0",
          agentName: "Alice",
          driverId: "claude-stream-json",
          status: "failure",
          output: null,
          exitCode: "killed",
          durationMs: 9,
          failure: { code: "TIMEOUT", message: "timed out after 1ms" },
        },
      ],
    });

    const spawned: SpawnKind[] = [];
    const spawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      spawned.push(kind);
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      return attemptEnvelope("Alice");
    };
    const sink = makeSink();
    const exitCode = await runCapturing(
      [
        "--agents",
        JSON.stringify([a.id]),
        "--aggregator",
        "Alice",
        "--task",
        "t",
        "--resume",
        runId,
      ],
      sink,
      { spawnImpl: spawn },
    );
    expect(exitCode).toBe(0);
    // The earlier success must NOT be reused — the attempt reruns.
    expect(spawned).toEqual(["probe", "attempt:Alice", "aggregation"]);
  });

  it('timeout-killed attempts record exit "killed" even when the child reports exit 0', async () => {
    const { aliceId, bobId } = seedTwo();
    const sink = makeSink();
    const spawn: SpawnImpl = async (input) => {
      if (input.prompt === DRIVER_PROBE_PROMPT) return claudeEnvelope("ok");
      // A child reaped with exit 0 after SIGTERM must not display as clean.
      return { stdout: "", exitCode: 0, timedOut: true, aborted: false };
    };
    const exitCode = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink, {
      spawnImpl: spawn,
    });
    expect(exitCode).toBe(4);
    const outcome = sink.finished as {
      reportPath: string;
      transcriptPath: string;
      attempts: Array<{ exitCode: unknown; status: string }>;
    };
    expect(outcome.attempts.every((x) => x.exitCode === "killed")).toBe(true);
    const records = readRecords(outcome.transcriptPath);
    const attemptRecs = records.filter((r) => r.kind === "attempt.finished");
    expect(attemptRecs).toHaveLength(2);
    expect(attemptRecs.every((r) => r.exitCode === "killed")).toBe(true);
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("failed:TIMEOUT");
  });

  it("human mode emits a 仍在运行 heartbeat per interval and stops when the attempt finishes", async () => {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    const a = store.createAgent({
      name: "Alice",
      personaPrompt: "p",
      modelId: "m",
      color: "#111111",
      driverSelection: ds,
    });
    const fake = makeFakeTimers();
    const sink = makeSink();
    const spawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      fake.advance(30_000);
      fake.fire();
      fake.advance(30_000);
      fake.fire();
      return attemptEnvelope("Alice");
    };
    const exitCode = await runCapturing(
      ["--agents", JSON.stringify([a.id]), "--aggregator", "Alice", "--task", "x"],
      sink,
      { spawnImpl: spawn, timers: fake.timers, heartbeatIntervalMs: 30_000 },
    );
    expect(exitCode).toBe(0);
    const beats = sink.lines.filter((l) => l.includes("仍在运行"));
    expect(beats).toEqual(["  attempt Alice 仍在运行 (30s)", "  attempt Alice 仍在运行 (1m00s)"]);
    // The timer is always cleared — a finished attempt never heartbeats again.
    expect(fake.activeCount()).toBe(0);
  });

  it("--json emits no human heartbeat lines but writes status.json mid-attempt", async () => {
    const store = new Store();
    const ds = { driverId: "claude-stream-json" as const, options: { route: "cfuse" as const } };
    const a = store.createAgent({
      name: "Alice",
      personaPrompt: "p",
      modelId: "m",
      color: "#111111",
      driverSelection: ds,
    });
    const fake = makeFakeTimers();
    const sink = makeSink();
    sink.json = true;
    let midStatus = "";
    let midDuration: number | null = null;
    let midActivity: string | null = null;
    const spawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      input.onActivity?.("git fetch origin");
      fake.advance(60_000);
      fake.fire();
      const runs = readdirSync(join(home, "runs"));
      const statusPath = join(home, "runs", runs[0], "status.json");
      const live = JSON.parse(readFileSync(statusPath, "utf8")) as {
        status: string;
        progress: {
          attempts: Array<{
            status: string;
            durationMs: number | null;
            lastActivity: string | null;
          }>;
        };
      };
      midStatus = live.status;
      const running = live.progress.attempts.find((row) => row.status === "running");
      midDuration = running?.durationMs ?? null;
      midActivity = running?.lastActivity ?? null;
      return attemptEnvelope("Alice");
    };
    const exitCode = await runCapturing(
      ["--agents", JSON.stringify([a.id]), "--aggregator", "Alice", "--task", "x", "--json"],
      sink,
      { spawnImpl: spawn, timers: fake.timers, heartbeatIntervalMs: 30_000 },
    );
    expect(exitCode).toBe(0);
    expect(sink.lines.filter((l) => l.includes("仍在运行"))).toHaveLength(0);
    expect(fake.activeCount()).toBe(0);
    expect(midStatus).toBe("running");
    expect(midDuration).toBe(60_000);
    expect(midActivity).toBe("git fetch origin");
  });

  it("transient EXIT <120s retries once: two transcript records, one final result, 45min default", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink = makeSink();
    const seen: Array<{ kind: SpawnKind; timeoutMs: number }> = [];
    let aliceTries = 0;
    const spawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      seen.push({ kind, timeoutMs: input.timeoutMs });
      if (kind === "probe") return claudeEnvelope("ok");
      if (kind === "aggregation") return claudeEnvelope(AGGREGATION_TEXT);
      if (kind === "attempt:Alice") {
        aliceTries++;
        if (aliceTries === 1) {
          return { stdout: "", stderr: "boom", exitCode: 1, timedOut: false, aborted: false };
        }
      }
      return attemptEnvelope("Alice");
    };
    const exitCode = await runCapturing(twoAgentArgs(aliceId, bobId, "x"), sink, {
      spawnImpl: spawn,
    });
    expect(exitCode).toBe(0);
    const outcome = sink.finished as {
      attempts: Array<{ agentName: string; durationMs: number }>;
      transcriptPath: string;
    };
    // Two attempts total (Alice + Bob), final results only.
    expect(outcome.attempts).toHaveLength(2);
    for (const a of outcome.attempts) expect(typeof a.durationMs).toBe("number");
    // Two attempt.finished records for Alice: first failure + retry success.
    const alice = readRecords(outcome.transcriptPath).filter(
      (r) => r.kind === "attempt.finished" && r.agentName === "Alice",
    );
    expect(alice).toHaveLength(2);
    expect(alice[0].attemptNumber).toBe(1);
    expect(alice[1].attemptNumber).toBe(2);
    expect(alice[1].retryOf).toBe(1);
    // 45min default for attempts; probe stays 60s.
    expect(seen.find((s) => s.kind === "probe")?.timeoutMs).toBe(60_000);
    expect(seen.find((s) => s.kind === "attempt:Alice")?.timeoutMs).toBe(2_700_000);
  });

  it("codex seats default to 90m; claude stays 45m", async () => {
    const store = new Store();
    const alice = store.createAgent({
      name: "Alice",
      personaPrompt: "p",
      modelId: "m",
      color: "#111111",
      driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
    });
    const codex = store.createAgent({
      name: "Codex",
      personaPrompt: "p",
      modelId: "gpt-5",
      color: "#222222",
      driverSelection: { driverId: "codex-app-server", options: {} },
    });
    const seen: Array<{ kind: SpawnKind; timeoutMs: number }> = [];
    const envelope = (input: SpawnInput, text: string): SpawnOutput => {
      if (input.driverId === "codex-app-server") {
        return {
          stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`,
          exitCode: 0,
          timedOut: false,
          aborted: false,
        };
      }
      return claudeEnvelope(text);
    };
    const spawn: SpawnImpl = async (input) => {
      const kind = classify(input);
      seen.push({ kind, timeoutMs: input.timeoutMs });
      if (kind === "probe") return envelope(input, "ok");
      if (kind === "aggregation") return envelope(input, AGGREGATION_TEXT);
      const name = kind.startsWith("attempt:") ? kind.slice("attempt:".length) : "x";
      return envelope(
        input,
        `## Findings\n- ok from ${name}\n## Verification\n未验证\n## Verdict\ncomment`,
      );
    };
    const sink = makeSink();
    const exitCode = await runCapturing(
      ["--agents", JSON.stringify([alice.id, codex.id]), "--aggregator", "Codex", "--task", "x"],
      sink,
      { spawnImpl: spawn },
    );
    expect(exitCode).toBe(0);
    expect(seen.find((s) => s.kind === "attempt:Alice")?.timeoutMs).toBe(2_700_000);
    expect(seen.find((s) => s.kind === "attempt:Codex")?.timeoutMs).toBe(5_400_000);
    expect(seen.find((s) => s.kind === "aggregation")?.timeoutMs).toBe(5_400_000);
  });

  it("incomplete outcome prints a --resume command that reuses successes", async () => {
    const { aliceId, bobId } = seedTwo();
    const sink = makeSink();
    const spawn: SpawnImpl = async (input) => {
      if (input.prompt === DRIVER_PROBE_PROMPT) return claudeEnvelope("ok");
      return { stdout: "", exitCode: 0, timedOut: true, aborted: false };
    };
    const exitCode = await runCapturing(twoAgentArgs(aliceId, bobId, "the-task"), sink, {
      spawnImpl: spawn,
    });
    expect(exitCode).toBe(4);
    const outcome = sink.finished as {
      resumeCommand: string | null;
      runId: string;
      incomplete: boolean;
    };
    expect(outcome.incomplete).toBe(true);
    expect(outcome.resumeCommand).toBe(
      `councilkit review --resume ${outcome.runId} --task "the-task"`,
    );
  });
});
