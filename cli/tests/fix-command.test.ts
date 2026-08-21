import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_PROBE_PROMPT } from "../src/auto/driver-commands";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { FixExit, runFix } from "../src/commands/fix";
import { CliError } from "../src/errors";
import { Store } from "../src/store/store";

const RUN_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const PR_URL = "https://github.com/acme/repo/pull/9";

const PLAN_DOC = [
  "# 修复方案",
  "",
  "## 不变量",
  "1. JSONL 失败不得留下半行",
  "",
  "## 落地顺序",
  "",
  "### 集群 1: eventlog-short-write",
  "- 不变量: JSONL 失败不得留下半行",
  "- 方针: 删除非幂等重试；短写 Truncate",
  "- 禁止: 对 Append 加重试循环",
  "- 测试: 真文件短写",
  "",
  "## 本轮不落地",
  "- lastSeq > head: 产品合同",
  "",
  "## 合并门槛",
  "- 阻塞不变量有测试",
].join("\n");

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

function envelope(input: SpawnInput, text: string): SpawnOutput {
  if (input.driverId === "grok-stream-json") {
    return { stdout: JSON.stringify({ text }), exitCode: 0, timedOut: false, aborted: false };
  }
  if (input.driverId === "codex-app-server") {
    return {
      stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`,
      exitCode: 0,
      timedOut: false,
      aborted: false,
    };
  }
  if (input.driverId === "kimi-stream-json") {
    return {
      stdout: `${JSON.stringify({ role: "assistant", content: text })}\n`,
      exitCode: 0,
      timedOut: false,
      aborted: false,
    };
  }
  return {
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }),
    exitCode: 0,
    timedOut: false,
    aborted: false,
  };
}

describe("cli fix command", () => {
  let home: string;
  let bin: string;
  const oldHome = process.env.COUNCILKIT_HOME;
  const oldPath = process.env.PATH;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-fix-"));
    bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["grok", "cld", "codex", "kimi", "gh", "git"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    process.env.COUNCILKIT_HOME = home;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
  });

  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) process.env.PATH = undefined;
    else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  });

  function seedRoster(): void {
    const store = new Store();
    const security = store.createAgent({
      name: "review-security",
      personaPrompt: "security",
      modelId: "m",
      color: "#111111",
      driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
    });
    const correctness = store.createAgent({
      name: "review-correctness",
      personaPrompt: "correctness",
      modelId: "g",
      color: "#222222",
      driverSelection: { driverId: "codex-app-server", options: {} },
    });
    const maintain = store.createAgent({
      name: "review-maintainability",
      personaPrompt: "maintain",
      modelId: "k",
      color: "#333333",
      driverSelection: { driverId: "kimi-stream-json", options: {} },
    });
    const adversarial = store.createAgent({
      name: "review-adversarial",
      personaPrompt: "adversarial",
      modelId: "grok-4.6",
      color: "#444444",
      driverSelection: { driverId: "grok-stream-json", options: {} },
    });
    store.createCouncil({
      name: "pr-jury",
      topic: "jury",
      agentIds: [security.id, correctness.id, maintain.id, adversarial.id],
      rounds: 1,
      reporterAgentId: adversarial.id,
    });
  }

  function seedReview(): void {
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "report.md"),
      "# Autonomous Review Report\n\n## 结论\nchanges-requested\n",
    );
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "review.started",
        version: 1,
        runId: RUN_ID,
        startedAt: "2026-08-01T00:00:00.000Z",
        task: { pr: PR_URL },
        attempts: [],
        aggregator: {
          attemptId: "aggregator",
          agentId: "a",
          agentName: "review-adversarial",
          driverId: "grok-stream-json",
          modelId: "grok-4.6",
        },
      })}\n${JSON.stringify({
        kind: "review.finished",
        version: 1,
        status: "completed",
        endedAt: "2026-08-01T01:00:00.000Z",
        incomplete: false,
        reportPath: join(dir, "report.md"),
      })}\n`,
    );
  }

  function fakeSpawn(opts: { verdicts?: Array<"approve" | "changes-requested"> } = {}): {
    impl: SpawnImpl;
    prompts: string[];
  } {
    const prompts: string[] = [];
    let planRound = 0;
    const verdicts = opts.verdicts ?? ["approve"];
    const impl: SpawnImpl = async (input) => {
      prompts.push(input.prompt);
      if (input.prompt === DRIVER_PROBE_PROMPT) return envelope(input, "ok");
      if (input.prompt.includes("起草（或修订）一份修复方案")) return envelope(input, PLAN_DOC);
      if (input.prompt.includes("修复方案审查者")) {
        return envelope(input, "## 发现\n- [nit] 范围合适\n## 验证\n读了方案\n## 结论\napprove");
      }
      if (input.prompt.includes("产出一份他们能接受的共识方案")) {
        const verdict = verdicts[Math.min(planRound, verdicts.length - 1)] ?? "approve";
        planRound += 1;
        return envelope(
          input,
          `## 概览\njury\n## 共识计划\n${PLAN_DOC}\n## 分歧\n无\n## 结论\n${verdict}`,
        );
      }
      return envelope(input, "unexpected prompt");
    };
    return { impl, prompts };
  }

  async function capturing(argv: string[], spawnImpl: SpawnImpl): Promise<number> {
    const sink = makeSink();
    try {
      await runFix(argv, sink, { spawnImpl });
      return 0;
    } catch (error) {
      if (error instanceof FixExit) return error.exitCode;
      throw error;
    }
  }

  it("requires --run", async () => {
    try {
      await runFix([], makeSink(), { spawnImpl: fakeSpawn().impl });
      throw new Error("expected usage");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
  });

  it("writes a consensus plan and skips apply with --plan-only", async () => {
    seedRoster();
    seedReview();
    const fake = fakeSpawn();
    const code = await capturing(["--run", RUN_ID, "--plan-only"], fake.impl);
    expect(code).toBe(0);
    const plan = readFileSync(join(home, "runs", RUN_ID, "plan.md"), "utf8");
    expect(plan).toContain("eventlog-short-write");
    const lock = JSON.parse(readFileSync(join(home, "runs", RUN_ID, "plan.lock.json"), "utf8")) as {
      clusters: Array<{ id: string }>;
    };
    expect(lock.clusters[0]?.id).toBe("eventlog-short-write");
    expect(fake.prompts.some((p) => p.includes("起草（或修订）一份修复方案"))).toBe(true);
    expect(fake.prompts.some((p) => p.includes("而不是重新审查整个 PR"))).toBe(true);
    expect(fake.prompts.some((p) => p.includes("这个仓库的实现 agent"))).toBe(false);
    const status = JSON.parse(readFileSync(join(home, "runs", RUN_ID, "status.json"), "utf8")) as {
      pipeline: { planVerdict: string; applyStatus: string; phase: string };
    };
    expect(status.pipeline.planVerdict).toBe("approve");
    expect(status.pipeline.applyStatus).toBe("skipped");
    expect(status.pipeline.phase).toBe("done");
  });

  it("does not apply when the plan jury never approves", async () => {
    seedRoster();
    seedReview();
    const fake = fakeSpawn({ verdicts: ["changes-requested", "changes-requested"] });
    const sink = makeSink();
    let code = 0;
    try {
      await runFix(["--run", RUN_ID, "--plan-only"], sink, { spawnImpl: fake.impl });
    } catch (error) {
      if (error instanceof FixExit) code = error.exitCode;
      else throw error;
    }
    expect(code).toBe(4);
    const outcome = sink.finished as { failure: { code: string } | null; applied: boolean };
    expect(outcome.failure?.code).toBe("PLAN_NO_CONSENSUS");
    expect(outcome.applied).toBe(false);
  });
});
