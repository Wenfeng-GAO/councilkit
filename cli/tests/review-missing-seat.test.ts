import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnImpl, SpawnInput } from "../src/auto/runner";
import { runInit } from "../src/commands/init";
import { ReviewExit, type ReviewOutcome, runReview } from "../src/commands/review";
import { Store } from "../src/store/store";

function sink() {
  return { json: true, progress() {}, diag() {}, finish: async (_value: unknown) => {} };
}

describe("#383 missing review executables", () => {
  let home: string;
  let bin: string;
  let saved: NodeJS.ProcessEnv;
  let calls: SpawnInput[];
  const spawn: SpawnImpl = async (input) => {
    calls.push(input);
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "## 概览\nok\n## 结论\ncomment",
      }),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    };
  };
  beforeEach(() => {
    saved = { ...process.env };
    const root = join(process.cwd(), "node_modules", ".cache");
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, "ck-383-"));
    bin = join(home, "bin");
    mkdirSync(bin);
    process.env.COUNCILKIT_HOME = home;
    process.env.HOME = home;
    process.env.CODEX_HOME = home;
    process.env.PATH = bin;
    process.env.COUNCILKIT_PROBE_FORCE_LLM = "1";
    calls = [];
  });
  afterEach(() => {
    process.env = saved;
    rmSync(home, { recursive: true, force: true });
  });
  function stub(tool: string) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  function agents() {
    const store = new Store();
    store.createAgent({
      name: "review-security",
      personaPrompt: "p",
      modelId: "test",
      color: "#112233",
      driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
    });
    store.createAgent({
      name: "review-kimi",
      personaPrompt: "p",
      modelId: "kimi-code/k3",
      color: "#445566",
      driverSelection: { driverId: "kimi-stream-json", options: {} },
    });
  }
  async function review(args: string[], exitCode: number): Promise<ReviewOutcome> {
    let outcome: ReviewOutcome | undefined;
    const output = {
      ...sink(),
      finish: async (value: unknown) => {
        outcome = value as ReviewOutcome;
      },
    };
    await expect(
      runReview([...args, "--task", "x", "--no-require-spec", "--json"], output, {
        spawnImpl: spawn,
      }),
    ).rejects.toEqual(new ReviewExit(exitCode));
    expect(outcome?.exitCode).toBe(exitCode);
    expect(existsSync(outcome?.reportPath ?? "")).toBe(true);
    return outcome as ReviewOutcome;
  }
  const explicit = [
    "--agents",
    '["review-security","review-kimi"]',
    "--aggregator",
    "review-security",
  ];
  it("#383 one missing seat is absent, never spawned or probed; partial success exits 0", async () => {
    stub("cld");
    agents();
    const outcome = await review(explicit, 0);
    expect(outcome).toMatchObject({ status: "completed", incomplete: true });
    expect(outcome.attempts[1]).toMatchObject({
      status: "failure",
      failure: { code: "EXECUTABLE_NOT_FOUND", message: "没有找到 kimi。" },
    });
    expect(readFileSync(outcome.reportPath, "utf8")).toContain(
      "缺席：review-kimi（kimi）：没有找到 kimi。",
    );
    expect(readFileSync(outcome.reportPath, "utf8")).toContain("- Status: partial");
    expect(calls.some((call) => call.prompt.includes("你是 review-security，"))).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((call) => call.driverId === "claude-stream-json")).toBe(true);
    expect(existsSync(join(home, "runs", outcome.runId, "workspaces", "attempt-1"))).toBe(false);
  });
  it("#383 all missing seats produce ALL_FAILED exit 4 and a report naming every seat", async () => {
    agents();
    const outcome = await review(explicit, 4);
    expect(outcome).toMatchObject({
      status: "failed",
      incomplete: true,
      failure: { code: "ALL_FAILED" },
    });
    const report = readFileSync(outcome.reportPath, "utf8");
    expect(report).toContain("缺席：review-security（cfuse）：没有找到 cfuse。");
    expect(report).toContain("缺席：review-kimi（kimi）：没有找到 kimi。");
    expect(calls).toEqual([]);
  });
  it("#383 council initialized before a tool disappears keeps its remaining seat", async () => {
    stub("cld");
    stub("kimi");
    await runInit([], sink());
    rmSync(join(bin, "kimi"));
    const outcome = await review(["--council", "pr-jury"], 0);
    expect(outcome).toMatchObject({ status: "completed", incomplete: true });
    expect(readFileSync(outcome.reportPath, "utf8")).toContain(
      "缺席：review-maintainability（kimi）：没有找到 kimi。",
    );
    expect(calls.every((call) => call.driverId === "claude-stream-json")).toBe(true);
  });
  it("#383 missing Aggregator lets a present seat run, then follows aggregation failure exit 4", async () => {
    stub("cld");
    agents();
    const outcome = await review(
      ["--agents", '["review-security","review-kimi"]', "--aggregator", "review-kimi"],
      4,
    );
    expect(outcome).toMatchObject({
      status: "failed",
      incomplete: true,
      failure: { phase: "aggregation", code: "EXECUTABLE_NOT_FOUND" },
    });
    expect(outcome.attempts[0].status).toBe("success");
    expect(calls.every((call) => call.driverId === "claude-stream-json")).toBe(true);
    expect(readFileSync(outcome.reportPath, "utf8")).toContain(
      "缺席：review-kimi（kimi）：没有找到 kimi。",
    );
  });
  it("#383 resume retries the absent seat without probing a reused successful seat", async () => {
    stub("cld");
    agents();
    const first = await review(explicit, 0);
    calls = [];
    const resumed = await review(["--resume", first.runId], 0);
    expect(resumed.attempts[0].reused).toBe(true);
    expect(resumed.attempts[1].failure?.code).toBe("EXECUTABLE_NOT_FOUND");
    expect(calls.every((call) => call.driverId === "claude-stream-json")).toBe(true);
  });
});
