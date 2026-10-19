/**
 * The claude-stream-json `cfuse` route on a machine with the standalone
 * CodeFuse CLI (`cfuse`) and no `cld` (#386 #389). Fake binaries on an
 * isolated PATH; spawns go through an injected spawnImpl.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_PROBE_PROMPT } from "../src/auto/driver-commands";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { IDEATE_REPORT_HEADINGS } from "../src/auto/templates/ideate";
import { IdeateExit, runIdeate } from "../src/commands/ideate";
import { ReviewExit, runReview } from "../src/commands/review";
import { Store } from "../src/store/store";

const CFUSE = { driverId: "claude-stream-json", options: { route: "cfuse" } } as const;

function makeSink() {
  const sink = {
    json: true,
    lines: [] as string[],
    finished: undefined as unknown,
    progress: (m: string) => sink.lines.push(m),
    diag: (_m: string) => {},
    finish: (d: unknown) => {
      sink.finished = d;
      return Promise.resolve();
    },
  };
  return sink;
}

function envelope(driverId: string | undefined, text: string): SpawnOutput {
  const line =
    driverId === "kimi-stream-json"
      ? { role: "assistant", content: text }
      : { type: "result", subtype: "success", is_error: false, result: text };
  return { stdout: `${JSON.stringify(line)}\n`, exitCode: 0, timedOut: false, aborted: false };
}

describe("standalone cfuse without cld", () => {
  let home: string;
  let bin: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-cfuse-home-"));
    bin = mkdtempSync(join(tmpdir(), "ck-cfuse-bin-"));
    for (const name of ["cfuse", "kimi"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    for (const key of ["COUNCILKIT_HOME", "PATH", "HOME", "COUNCILKIT_PROBE_FORCE_LLM"]) {
      saved[key] = process.env[key];
    }
    process.env.COUNCILKIT_HOME = home;
    // Only the fake bin dir: no `cld` anywhere, vendor homes under a temp HOME.
    process.env.PATH = bin;
    process.env.HOME = join(home, "user");
    mkdirSync(process.env.HOME, { recursive: true });
    delete process.env.COUNCILKIT_PROBE_FORCE_LLM;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it("review: the cfuse seat and its health probe run `cfuse --cc --skip-update` and the review exits 0 (#386)", async () => {
    const calls: SpawnInput[] = [];
    const spawnImpl: SpawnImpl = async (input) => {
      calls.push(input);
      return envelope(input.driverId, "## 发现\n无\n## 验证\n未验证\n## 结论\napprove");
    };
    const reviewModels = {
      models: [{ modelId: "antchat/GLM-5.3[1m]", driverSelection: CFUSE }],
      aggregatorIndex: 0,
    };
    let exitCode = 0;
    try {
      await runReview(
        [
          "--task",
          "Review this task",
          "--no-require-spec",
          "--review-models",
          JSON.stringify(reviewModels),
          "--json",
        ],
        makeSink(),
        { spawnImpl },
      );
    } catch (error) {
      if (!(error instanceof ReviewExit)) throw error;
      exitCode = error.exitCode;
    }
    expect(exitCode).toBe(0);
    const seats = calls.filter((c) => c.prompt !== DRIVER_PROBE_PROMPT);
    expect(seats.length).toBeGreaterThanOrEqual(2); // seat + aggregator
    for (const call of seats) {
      expect(call.executable).toBe(join(bin, "cfuse"));
      expect(call.argv.slice(0, 3)).toEqual(["--cc", "--skip-update", "--print"]);
      expect(call.argv).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
      expect(call.argv).not.toContain("--dangerously-skip-permissions");
      expect(call.promptStdin).toBe(true);
    }
  });

  it("ideate: a Claude seat runs standalone cfuse and ideate completes (#389)", async () => {
    const store = new Store();
    const claude = store.createAgent({
      name: "ideate-product",
      personaPrompt: "product",
      modelId: "antchat/GLM-5.3[1m]",
      color: "#38bdf8",
      driverSelection: CFUSE,
    });
    const kimi = store.createAgent({
      name: "ideate-engineering",
      personaPrompt: "engineering",
      modelId: "kimi-code/k3",
      color: "#4ade80",
      driverSelection: { driverId: "kimi-stream-json", options: {} },
    });
    store.createCouncil({
      name: "product-jury",
      topic: "ideate",
      background: "bg",
      targetOutput: "report",
      agentIds: [claude.id, kimi.id],
      rounds: 1,
      reporterAgentId: claude.id,
    });
    const calls: SpawnInput[] = [];
    const spawnImpl: SpawnImpl = async (input) => {
      calls.push(input);
      if (input.prompt.includes("中立决策 Aggregator")) {
        return envelope(
          input.driverId,
          IDEATE_REPORT_HEADINGS.map((h) => `${h}\nbody`).join("\n\n"),
        );
      }
      return envelope(input.driverId, `proposal from ${input.cwd}`);
    };
    const sink = makeSink();
    try {
      await runIdeate(["a local weekly feedback tool", "--debate-rounds", "0", "--json"], sink, {
        spawnImpl,
      });
    } catch (error) {
      if (!(error instanceof IdeateExit) || error.exitCode !== 0) throw error;
    }
    expect((sink.finished as { status: string }).status).toBe("completed");
    const claudeCalls = calls.filter((c) => c.driverId === "claude-stream-json");
    expect(claudeCalls.length).toBeGreaterThan(0);
    for (const call of claudeCalls) {
      expect(call.executable).toBe(join(bin, "cfuse"));
      expect(call.argv.slice(0, 3)).toEqual(["--cc", "--skip-update", "--print"]);
      expect(call.argv).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    }
  });
});
