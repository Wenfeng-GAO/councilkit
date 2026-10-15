/**
 * `councilkit init` public seam: isolated COUNCILKIT_HOME + stub PATH.
 * Expected names/colors/models are the product literals, not derived from
 * the implementation under test beyond importing the command.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { dispatch } from "../src/cli";
import { runInit } from "../src/commands/init";
import { ReviewExit, runReview } from "../src/commands/review";
import { CliError } from "../src/errors";
import { publicMissingDrivers } from "../src/init/no-ai-cli";
import { renderErrorHuman } from "../src/output";
import { resolvePaths } from "../src/store/paths";
import { Store } from "../src/store/store";

interface FakeSink {
  json: boolean;
  lines: string[];
  finished: unknown;
  /** Human render of `finished` (what a terminal user sees without --json). */
  rendered?: string;
  progress(m: string): void;
  diag(m: string): void;
  finish(d: unknown, humanRender?: (d: unknown) => string): Promise<void>;
}

function makeSink(): FakeSink {
  const sink: FakeSink = {
    json: false,
    lines: [],
    finished: undefined,
    progress: (m) => sink.lines.push(m),
    diag: () => {},
    finish: (d, humanRender) => {
      sink.finished = d;
      sink.rendered = humanRender?.(d);
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
  let codexHome: string;
  let oldHome: string | undefined;
  let oldPath: string | undefined;
  let oldCodex: string | undefined;
  let oldUserHome: string | undefined;
  let oldLang: string | undefined;
  let oldLcAll: string | undefined;
  let oldLcMessages: string | undefined;
  let oldLanguage: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-init-home-"));
    bin = mkdtempSync(join(tmpdir(), "ck-init-bin-"));
    codexHome = mkdtempSync(join(tmpdir(), "ck-init-codex-"));
    oldHome = process.env.COUNCILKIT_HOME;
    oldPath = process.env.PATH;
    oldCodex = process.env.CODEX_HOME;
    oldUserHome = process.env.HOME;
    oldLang = process.env.LANG;
    oldLcAll = process.env.LC_ALL;
    oldLcMessages = process.env.LC_MESSAGES;
    oldLanguage = process.env.LANGUAGE;
    process.env.COUNCILKIT_HOME = home;
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) process.env.PATH = undefined;
    else process.env.PATH = oldPath;
    if (oldCodex === undefined) process.env.CODEX_HOME = undefined;
    else process.env.CODEX_HOME = oldCodex;
    if (oldUserHome === undefined) process.env.HOME = undefined;
    else process.env.HOME = oldUserHome;
    if (oldLang === undefined) process.env.LANG = undefined;
    else process.env.LANG = oldLang;
    if (oldLcAll === undefined) process.env.LC_ALL = undefined;
    else process.env.LC_ALL = oldLcAll;
    if (oldLcMessages === undefined) process.env.LC_MESSAGES = undefined;
    else process.env.LC_MESSAGES = oldLcMessages;
    if (oldLanguage === undefined) process.env.LANGUAGE = undefined;
    else process.env.LANGUAGE = oldLanguage;
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  function stub(names: string[]): void {
    for (const name of names) {
      const p = join(bin, name);
      writeFileSync(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
    }
    process.env.PATH = bin;
  }

  function setLocale(lang: string): void {
    process.env.LANG = lang;
    process.env.LC_ALL = lang;
    process.env.LC_MESSAGES = lang;
    process.env.LANGUAGE = lang.slice(0, 2);
  }

  it("#318 zh init human lines use 「没找到：」 and 「下一步：」; --json keys stay English", async () => {
    stub(["grok"]);
    setLocale("zh_CN.UTF-8");
    const sink = makeSink();
    await runInit([], sink);
    const human = sink.rendered ?? "";
    expect(human).toMatch(/^没找到：/m);
    expect(human).toMatch(/^下一步：/m);
    expect(human).not.toContain("missing on PATH:");
    expect(human).not.toMatch(/^next: /m);
    const data = sink.finished as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(["missingDrivers", "next", "createdAgents", "reusedAgents"]),
    );
  });

  it("#318 en init human lines keep the English prefixes", async () => {
    stub(["grok"]);
    setLocale("en_US.UTF-8");
    const sink = makeSink();
    await runInit([], sink);
    const human = sink.rendered ?? "";
    expect(human).toMatch(/^missing on PATH: /m);
    expect(human).toMatch(/^next: /m);
    expect(human).not.toContain("没找到：");
  });

  it("fails with exit 2 and writes no store when no drivers are on PATH", async () => {
    process.env.PATH = bin;
    const sink = makeSink();
    await expect(runInit([], sink)).rejects.toMatchObject({ exitCode: 2 });
    expect(readMaybe(resolvePaths().agents)).toBeNull();
    expect(readMaybe(resolvePaths().councils)).toBeNull();
  });

  it("CLI-10 init without any AI CLI lists drivers from missingDrivers and points to demo", async () => {
    process.env.PATH = bin;
    process.env.LANG = "en_US.UTF-8";
    process.env.LC_ALL = "en_US.UTF-8";
    process.env.LC_MESSAGES = "en_US.UTF-8";
    process.env.LANGUAGE = "en";
    const sink = makeSink();
    let caught: unknown;
    try {
      await runInit(["--json"], sink);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    const err = caught as CliError;
    expect(err.exitCode).toBe(2);
    const missing = (err.detail?.missingDrivers as string[]) ?? [];
    const listed = publicMissingDrivers(missing);
    expect([...listed].sort()).toEqual(["codex", "cursor-agent", "grok", "kimi"].sort());
    for (const name of listed) expect(err.message).toContain(name);
    expect(err.message).toContain("councilkit demo");
    expect(err.message).not.toMatch(/\bcld\b/);
    expect(err.message).not.toMatch(/\bcode\b/);
    const json = JSON.stringify({
      ok: false,
      error: { code: err.exitCode, message: err.message, detail: err.detail ?? {} },
    });
    expect(json).toContain('"code"');
    // CLI-10: listed tools == detail.missingDrivers, and neither contains cld.
    expect(missing).toEqual(listed);
    expect(missing).not.toContain("cld");
    expect(missing).not.toContain("codex-model");
    expect(err.message).toBe(
      "No AI CLI found yet. Install and log in to any one of: grok, kimi, codex, cursor-agent — then run `councilkit init`. Or try `councilkit demo` first, no account needed.",
    );
    // The human line carries no error code and no detail dump.
    const human = renderErrorHuman(err);
    expect(human).toBe(err.message);
    expect(human).not.toMatch(/error\[\d+\]/);
    expect(human).not.toContain("detail:");
  });

  it("CLI-10 zh: clean HOME init prints the locked zh sentence only", async () => {
    process.env.PATH = bin;
    process.env.LANG = "zh_CN.UTF-8";
    process.env.LC_ALL = "zh_CN.UTF-8";
    process.env.LC_MESSAGES = "zh_CN.UTF-8";
    process.env.LANGUAGE = "zh_CN";
    let caught: unknown;
    try {
      await runInit([], makeSink());
    } catch (error) {
      caught = error;
    }
    const err = caught as CliError;
    expect(err.exitCode).toBe(2);
    expect(renderErrorHuman(err)).toBe(
      "还没找到可用的 AI 命令行工具。装好并登录下面任意一个，再运行 `councilkit init`：grok、kimi、codex、cursor-agent。也可以先运行 `councilkit demo` 看一份示例报告，不需要任何账号。",
    );
    expect(err.detail).toEqual({ missingDrivers: ["grok", "kimi", "codex", "cursor-agent"] });
  });

  function expectCreatedCouncilAndNextAgree(
    out: { createdCouncil: { name: string } | null; next: string },
    store: Store,
  ): void {
    const names = store.listCouncils().map((c) => c.name);
    if (
      /\b--council product-jury\b/.test(out.next) ||
      /ideate .*--council product-jury/.test(out.next)
    ) {
      expect(names).toContain("product-jury");
    } else {
      expect(out.next).not.toContain("--council product-jury");
    }
    if (out.next.includes("review --council pr-jury")) {
      expect(names).toContain("pr-jury");
    }
    if (out.createdCouncil !== null) {
      expect(names).toContain(out.createdCouncil.name);
      expect(out.next).toContain(out.createdCouncil.name);
    }
  }

  it("CK-1 BUG-01 only kimi: createdCouncil and next agree", async () => {
    stub(["kimi"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdCouncil: { name: string } | null;
      next: string;
      missingDrivers: string[];
    };
    expectCreatedCouncilAndNextAgree(out, new Store());
    expect(out.createdCouncil?.name).toBe("pr-jury");
    expect(out.next).not.toContain("--council product-jury");
    expect(out.next).toContain(
      "Product ideation needs at least two AI CLIs; found only kimi. Install and log in to grok or codex, then run `councilkit init`.",
    );
    expect(out.missingDrivers).not.toContain("cld");
    expect(out.missingDrivers).not.toContain("codex-model");
    expect(() => new Store().getCouncil("product-jury")).toThrow(/no council/);
  });

  it("CK-1 BUG-01 only grok: createdCouncil and next agree", async () => {
    stub(["grok"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdCouncil: { name: string } | null;
      next: string;
    };
    expectCreatedCouncilAndNextAgree(out, new Store());
    expect(out.createdCouncil?.name).toBe("pr-jury");
    expect(out.next).not.toContain("--council product-jury");
    expect(() => new Store().getCouncil("product-jury")).toThrow(/no council/);
  });

  it("CK-1 BUG-01 both: createdCouncil and next agree", async () => {
    stub(["kimi", "grok"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdCouncil: { name: string } | null;
      next: string;
    };
    expectCreatedCouncilAndNextAgree(out, new Store());
    expect(out.createdCouncil?.name).toBe("pr-jury");
    expect(out.next).toContain("--council product-jury");
    expect(new Store().getCouncil("product-jury").name).toBe("product-jury");
  });

  it("CK-1 re-running init backfills product-jury", async () => {
    stub(["kimi"]);
    await runInit([], makeSink());
    expect(() => new Store().getCouncil("product-jury")).toThrow(/no council/);
    stub(["kimi", "grok"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as { createdCouncil: { name: string } | null; next: string };
    expect(new Store().getCouncil("product-jury").name).toBe("product-jury");
    expect(out.createdCouncil?.name).toBe("product-jury");
    expect(out.next).toContain("--council product-jury");
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
      "ideate-engineering",
      "ideate-product",
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
    const product = store.getCouncil("product-jury");
    expect(product.agentIds).toHaveLength(2);
    expect(product.reporterAgentId).toBe(store.getAgent("ideate-product").id);
    expect(store.getAgent("ideate-product").modelId).toBe("grok-4.6");
    expect(store.getAgent("ideate-engineering").modelId).toBe("kimi-code/k3");
  });

  it("uses the challenger as product-jury reporter when Codex is on PATH", async () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-astra"\n');
    stub(["cld", "kimi", "grok", "codex"]);
    await runInit([], makeSink());
    const store = new Store();
    expect(store.getCouncil("product-jury").reporterAgentId).toBe(
      store.getAgent("ideate-challenger").id,
    );
    expect(store.getAgent("ideate-challenger").modelId).toBe("gpt-6-astra");
  });

  it("does not invent a Codex model when none is configured", async () => {
    stub(["cld", "kimi", "grok", "codex"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as { missingDrivers: string[] };
    expect(out.missingDrivers).toContain("codex");
    expect(out.missingDrivers).not.toContain("codex-model");
    expect(out.missingDrivers).not.toContain("cld");
    expect(new Store().listAgents().map((agent) => agent.name)).not.toContain("ideate-challenger");
  });

  it("does not silently replace a configured product-jury reporter", async () => {
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    expect(new Store().getCouncil("product-jury").reporterAgentId).toBe(
      new Store().getAgent("ideate-product").id,
    );
    // PATH-only `codex` is not enough under the current contract: challenger
    // is created only when a Codex model is discoverable.
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-astra"\n');
    stub(["cld", "kimi", "grok", "codex"]);
    await runInit([], makeSink());
    const store = new Store();
    expect(store.listAgents().map((a) => a.name)).toContain("ideate-challenger");
    expect(store.getCouncil("product-jury").reporterAgentId).toBe(
      store.getAgent("ideate-product").id,
    );
    expect(store.getCouncil("product-jury").agentIds).toContain(
      store.getAgent("ideate-challenger").id,
    );
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

  it("adds review-cursor with model auto when cursor-agent is on PATH", async () => {
    stub(["cld", "kimi", "grok", "cursor-agent"]);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: Array<{ name: string; driverId: string; modelId: string }>;
    };
    expect(out.createdAgents.find((a) => a.name === "review-cursor")).toMatchObject({
      driverId: "cursor-stream-json",
      modelId: "auto",
    });
    const store = new Store();
    expect(store.getCouncil("pr-jury").agentIds).toHaveLength(5);
    expect(store.getAgent("review-cursor").driverSelection).toEqual({
      driverId: "cursor-stream-json",
      options: {},
    });
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
    expect(out.createdAgents.map((a) => a.name).sort()).toEqual([
      "ideate-engineering",
      "review-maintainability",
    ]);
    expect(out.createdCouncil.reporter).toBe("review-maintainability");
    expect([...out.missingDrivers].sort()).toEqual(["codex", "cursor-agent", "grok"]);
    expect(out.missingDrivers).not.toContain("cld");
  });

  it("creates review-maintainability when kimi lives only in ~/.kimi-code/bin", async () => {
    process.env.PATH = bin;
    const vendor = join(home, ".kimi-code", "bin");
    mkdirSync(vendor, { recursive: true });
    const kimi = join(vendor, "kimi");
    writeFileSync(kimi, "#!/bin/sh\nexit 0\n");
    chmodSync(kimi, 0o755);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: Array<{ name: string }>;
      createdCouncil: { reporter: string };
    };
    expect(out.createdAgents.map((a) => a.name).sort()).toEqual([
      "ideate-engineering",
      "review-maintainability",
    ]);
    expect(out.createdCouncil.reporter).toBe("review-maintainability");
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
    expect(out.reusedAgents).toHaveLength(6);
    expect(out.reusedCouncil?.name).toBe("pr-jury");
    expect(out.createdCouncil).toBeNull();
    expect(new Store().getAgent("review-security").id).toBe(first);
    expect(new Store().listAgents()).toHaveLength(6);
    expect(new Store().listCouncils()).toHaveLength(2);
    expect(
      new Store()
        .listCouncils()
        .map((c) => c.name)
        .sort(),
    ).toEqual(["pr-jury", "product-jury"]);
  });

  it("--force recreates default agents after deleting pr-jury", async () => {
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    const firstId = new Store().getAgent("review-security").id;
    await runInit(["--force"], makeSink());
    const secondId = new Store().getAgent("review-security").id;
    expect(secondId).not.toBe(firstId);
    expect(new Store().listAgents()).toHaveLength(6);
    expect(new Store().getCouncil("pr-jury").name).toBe("pr-jury");
    expect(new Store().getCouncil("product-jury").name).toBe("product-jury");
  });

  it("keeps a default agent a custom council still uses and rebuilds pr-jury", async () => {
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    const before = new Store();
    const securityId = before.getAgent("review-security").id;
    const maintainabilityId = before.getAgent("review-maintainability").id;
    const prJuryId = before.getCouncil("pr-jury").id;
    before.createCouncil({
      name: "release-jury",
      topic: "release review",
      agentIds: [securityId],
      rounds: 1,
      reporterAgentId: securityId,
    });

    await runInit(["--force"], makeSink());

    const after = new Store();
    expect(after.getAgent("review-security").id).toBe(securityId);
    expect(after.getAgent("review-maintainability").id).not.toBe(maintainabilityId);
    expect(after.getCouncil("pr-jury").id).not.toBe(prJuryId);
    expect(after.getCouncil("pr-jury").agentIds).toContain(securityId);
    expect(after.getCouncil("release-jury").agentIds).toEqual([securityId]);
  });

  it("still resets defaults when a custom council uses only its own agent", async () => {
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    const store = new Store();
    const own = store.createAgent({
      name: "release-reader",
      personaPrompt: "read the release",
      modelId: "grok-4.6",
      color: "#112233",
      driverSelection: { driverId: "grok-stream-json", options: {} },
    });
    store.createCouncil({
      name: "release-jury",
      topic: "release review",
      agentIds: [own.id],
      rounds: 1,
      reporterAgentId: own.id,
    });
    const firstSecurity = store.getAgent("review-security").id;
    await runInit(["--force"], makeSink());
    const after = new Store();
    expect(after.getAgent("review-security").id).not.toBe(firstSecurity);
    expect(after.getCouncil("release-jury").agentIds).toEqual([own.id]);
    expect(after.getAgent("release-reader").id).toBe(own.id);
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
      await runReview(
        ["--council", "pr-jury", "--task", "fixture review", "--no-require-spec"],
        sink,
        {
          spawnImpl: fakeSpawn(),
        },
      );
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
