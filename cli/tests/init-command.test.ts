/**
 * `councilkit init` public seam: isolated COUNCILKIT_HOME + stub PATH.
 * Expected names/colors/models are the product literals, not derived from
 * the implementation under test beyond importing the command.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { dispatch } from "../src/cli";
import { runInit } from "../src/commands/init";
import { ReviewExit, runReview } from "../src/commands/review";
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

function fakeSpawn(): SpawnImpl {
  return async (input: SpawnInput) => {
    if (input.prompt.includes("对比汇总") || input.prompt.includes("Aggregator")) {
      return claudeEnvelope(
        "## 概览\nok\n## 共识发现\n- x\n## 独有发现\n- y\n## 分歧\nnone\n## 结论\napprove",
      );
    }
    return claudeEnvelope("## 发现\n- [nit] a.ts:1 — n\n## 验证\n未验证\n## 结论\ncomment");
  };
}

describe("councilkit init", () => {
  let home: string;
  let bin: string;
  let oldHome: string | undefined;
  let oldPath: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-init-home-"));
    bin = mkdtempSync(join(tmpdir(), "ck-init-bin-"));
    oldHome = process.env.COUNCILKIT_HOME;
    oldPath = process.env.PATH;
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) process.env.PATH = undefined;
    else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  function stub(names: string[]): void {
    for (const name of names) {
      const p = join(bin, name);
      writeFileSync(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
    }
    process.env.PATH = bin;
  }

  it("fails with exit 2 and writes no store when no drivers are on PATH", async () => {
    process.env.PATH = bin;
    const sink = makeSink();
    await expect(runInit([], sink)).rejects.toMatchObject({ exitCode: 2 });
    expect(readMaybe(resolvePaths().agents)).toBeNull();
    expect(readMaybe(resolvePaths().councils)).toBeNull();
  });

  it("creates four default agents and pr-jury when cld, kimi and grok exist", async () => {
    stub(["cld", "kimi", "grok"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: Array<{ name: string; driverId: string; modelId: string }>;
      createdCouncil: { name: string; reporter: string };
      next: string;
    };
    expect(out.createdAgents.map((a) => a.name).sort()).toEqual([
      "review-adversarial",
      "review-correctness",
      "review-maintainability",
      "review-security",
    ]);
    expect(out.createdAgents.find((a) => a.name === "review-security")).toMatchObject({
      driverId: "claude-stream-json",
      modelId: "antchat/GLM-5.2[1m]",
    });
    expect(out.createdAgents.find((a) => a.name === "review-correctness")).toMatchObject({
      driverId: "grok-stream-json",
      modelId: "grok-4.6",
    });
    expect(out.createdAgents.find((a) => a.name === "review-maintainability")).toMatchObject({
      driverId: "kimi-stream-json",
      modelId: "kimi-code/k3",
    });
    expect(out.createdCouncil.name).toBe("pr-jury");
    expect(out.createdCouncil.reporter).toBe("review-adversarial");
    expect(out.next).toContain("review --council pr-jury");

    const store = new Store();
    const security = store.getAgent("review-security");
    expect(security.color).toBe("#f74f6e");
    expect(security.driverSelection).toEqual({
      driverId: "claude-stream-json",
      options: { route: "cfuse" },
    });
    const council = store.getCouncil("pr-jury");
    expect(council.agentIds).toHaveLength(4);
    expect(council.reporterAgentId).toBe(store.getAgent("review-adversarial").id);
  });

  it("adds review-adversarial to pr-jury when grok is on PATH", async () => {
    stub(["cld", "kimi", "grok"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as { createdAgents: Array<{ name: string; driverId: string }> };
    expect(out.createdAgents.map((a) => a.name)).toContain("review-adversarial");
    expect(out.createdAgents.find((a) => a.name === "review-adversarial")?.driverId).toBe(
      "grok-stream-json",
    );
    const store = new Store();
    expect(store.getCouncil("pr-jury").agentIds).toHaveLength(4);
    expect(store.getCouncil("pr-jury").reporterAgentId).toBe(
      store.getAgent("review-adversarial").id,
    );
  });

  it("a later init with grok on PATH adds adversarial and switches reporter", async () => {
    stub(["cld", "kimi"]);
    await runInit([], makeSink());
    expect(new Store().getCouncil("pr-jury").reporterAgentId).toBe(
      new Store().getAgent("review-security").id,
    );
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    const store = new Store();
    expect(store.listAgents().map((a) => a.name)).toContain("review-adversarial");
    expect(store.getCouncil("pr-jury").reporterAgentId).toBe(
      store.getAgent("review-adversarial").id,
    );
    expect(store.getCouncil("pr-jury").agentIds).toHaveLength(4);
  });

  it("creates a one-agent pr-jury when only kimi is on PATH", async () => {
    stub(["kimi"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: Array<{ name: string }>;
      createdCouncil: { reporter: string };
      missingDrivers: string[];
    };
    expect(out.createdAgents.map((a) => a.name)).toEqual(["review-maintainability"]);
    expect(out.createdCouncil.reporter).toBe("review-maintainability");
    expect(out.missingDrivers.sort()).toEqual(["cld", "grok"]);
  });

  it("migrates an existing correctness seat off codex onto grok", async () => {
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    const store = new Store();
    store.updateAgent("review-correctness", {
      modelId: "gpt-5",
      driverSelection: { driverId: "codex-app-server", options: {} },
    });
    expect(store.getAgent("review-correctness").driverSelection.driverId).toBe("codex-app-server");
    await runInit([], makeSink());
    const migrated = new Store().getAgent("review-correctness");
    expect(migrated.driverSelection.driverId).toBe("grok-stream-json");
    expect(migrated.modelId).toBe("grok-4.6");
  });

  it("is idempotent: a second init reuses names and does not duplicate", async () => {
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    const first = new Store().getAgent("review-security").id;
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: unknown[];
      reusedAgents: Array<{ id: string; name: string }>;
      reusedCouncil: { name: string } | null;
      createdCouncil: unknown;
    };
    expect(out.createdAgents).toEqual([]);
    expect(out.reusedAgents).toHaveLength(4);
    expect(out.reusedCouncil?.name).toBe("pr-jury");
    expect(out.createdCouncil).toBeNull();
    expect(new Store().getAgent("review-security").id).toBe(first);
    expect(new Store().listAgents()).toHaveLength(4);
    expect(new Store().listCouncils()).toHaveLength(1);
  });

  it("--force recreates default agents after deleting pr-jury", async () => {
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    const firstId = new Store().getAgent("review-security").id;
    await runInit(["--force"], makeSink());
    const secondId = new Store().getAgent("review-security").id;
    expect(secondId).not.toBe(firstId);
    expect(new Store().listAgents()).toHaveLength(4);
    expect(new Store().getCouncil("pr-jury").name).toBe("pr-jury");
  });

  it("does not overwrite a user-edited default agent without --force", async () => {
    stub(["kimi"]);
    await runInit([], makeSink());
    const path = resolvePaths().agents;
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      agents: Array<{ name: string; personaPrompt: string }>;
    };
    const agent = raw.agents.find((a) => a.name === "review-maintainability");
    expect(agent).toBeDefined();
    (agent as { personaPrompt: string }).personaPrompt = "user-customized persona";
    writeFileSync(path, JSON.stringify(raw));
    await runInit([], makeSink());
    expect(new Store().getAgent("review-maintainability").personaPrompt).toBe(
      "user-customized persona",
    );
  });

  it("lets review --council pr-jury run after init (fake spawn)", async () => {
    // Only cld: fake spawn returns a claude envelope; mixed drivers would
    // need per-driver extractors. One-agent jury is a supported product path.
    stub(["cld"]);
    await runInit([], makeSink());
    const sink = makeSink();
    try {
      await runReview(["--council", "pr-jury", "--task", "fixture review"], sink, {
        spawnImpl: fakeSpawn(),
      });
    } catch (error) {
      if (!(error instanceof ReviewExit) || error.exitCode !== 0) throw error;
    }
    const finished = sink.finished as { reportPath?: string; status?: string };
    expect(finished.status === "completed" || finished.reportPath !== undefined).toBe(true);
    const reportPath = (finished.reportPath ?? "") as string;
    expect(reportPath.length).toBeGreaterThan(0);
    const report = readFileSync(reportPath, "utf8");
    expect(report).toContain("# Autonomous Review Report");
  });

  it("dispatch routes the init command", async () => {
    stub(["kimi"]);
    const sink = makeSink();
    await dispatch("init", [], sink);
    expect((sink.finished as { createdCouncil: { name: string } }).createdCouncil.name).toBe(
      "pr-jury",
    );
  });
});

function readMaybe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
