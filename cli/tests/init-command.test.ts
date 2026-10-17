/**
 * `councilkit init` public seam: isolated COUNCILKIT_HOME + stub PATH.
 * Expected names/colors/models are the product literals, not derived from
 * the implementation under test beyond importing the command.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_PROBE_PROMPT } from "../src/auto/driver-commands";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { dispatch } from "../src/cli";
import { runIdeate } from "../src/commands/ideate";
import { runInit } from "../src/commands/init";
import { ReviewExit, runReview } from "../src/commands/review";
import { DEFAULT_AGENT_NAMES } from "../src/init/defaults";
import { IDEATE_AGENT_NAMES } from "../src/init/ideate-defaults";
import { renderErrorHuman } from "../src/output";
import { resolvePaths } from "../src/store/paths";
import { Store } from "../src/store/store";

interface FakeSink {
  json: boolean;
  lines: string[];
  finished: unknown;
  human: string;
  progress(m: string): void;
  diag(m: string): void;
  finish(d: unknown, human?: (data: unknown) => string): Promise<void>;
}

function makeSink(): FakeSink {
  const sink: FakeSink = {
    json: false,
    lines: [],
    finished: undefined,
    human: "",
    progress: (m) => sink.lines.push(m),
    diag: () => {},
    finish: (d, human) => {
      sink.finished = d;
      sink.human = human?.(d) ?? "";
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
  let oldCursorKey: string | undefined;
  let oldGrokHome: string | undefined;
  let oldXdg: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-init-home-"));
    bin = mkdtempSync(join(tmpdir(), "ck-init-bin-"));
    codexHome = mkdtempSync(join(tmpdir(), "ck-init-codex-"));
    oldHome = process.env.COUNCILKIT_HOME;
    oldPath = process.env.PATH;
    oldCodex = process.env.CODEX_HOME;
    oldUserHome = process.env.HOME;
    oldCursorKey = process.env.CURSOR_API_KEY;
    oldGrokHome = process.env.GROK_HOME;
    oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.COUNCILKIT_HOME = home;
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = home;
    delete process.env.GROK_HOME;
    delete process.env.CURSOR_API_KEY;
    // GitHub ubuntu runners set XDG_CONFIG_HOME outside HOME. cld's login
    // probe follows it, so the fixture must own that directory.
    delete process.env.XDG_CONFIG_HOME;
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
    if (oldCursorKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = oldCursorKey;
    if (oldGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = oldGrokHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  function stub(names: string[], script = "#!/bin/sh\nexit 0\n"): void {
    for (const name of names) {
      const p = join(bin, name);
      writeFileSync(p, script);
      chmodSync(p, 0o755);
    }
    // File probes treat a missing credential as logged-out. A stubbed binary
    // is a present driver; only the explicit logged-out script stays signed out.
    if (script !== LOGGED_OUT) {
      if (names.includes("kimi")) {
        mkdirSync(join(home, ".kimi-code"), { recursive: true });
        writeFileSync(join(home, ".kimi-code", "credentials"), "{}\n");
      }
      if (names.includes("grok")) {
        mkdirSync(join(home, ".grok"), { recursive: true });
        writeFileSync(join(home, ".grok", "auth.json"), "{}\n");
      }
    }
    process.env.PATH = bin;
  }

  const LOGGED_IN = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.2.3"; exit 0; fi
if [ "$1" = "login" ] || [ "$1" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
exit 0
`;
  const LOGGED_OUT = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.2.3"; exit 0; fi
if [ "$1" = "login" ] || [ "$1" = "status" ]; then echo "Not logged in"; exit 1; fi
exit 1
`;

  it("fails with exit 2 and writes no agents when no drivers are on PATH", async () => {
    process.env.PATH = bin;
    delete process.env.CURSOR_API_KEY;
    const sink = makeSink();
    await expect(runInit([], sink)).rejects.toMatchObject({ exitCode: 2 });
    expect(readMaybe(resolvePaths().agents)).toBeNull();
    const councils = JSON.parse(readMaybe(resolvePaths().councils) ?? "null") as {
      councils: unknown[];
      pendingCouncils: Array<{ name: string }>;
    };
    expect(councils.councils).toEqual([]);
    expect(councils.pendingCouncils.map((row) => row.name).sort()).toEqual([
      "pr-jury",
      "product-jury",
    ]);
  });

  it("names a next step for every missing driver and does not print a stack", async () => {
    process.env.PATH = bin;
    delete process.env.CURSOR_API_KEY;
    const sink = makeSink();
    const error = await runInit([], sink).then(
      () => null,
      (caught: {
        message?: string;
        detail?: { drivers?: Array<{ driver: string; next: string | null }> };
      }) => caught,
    );
    expect(error).not.toBeNull();
    const message = error?.message ?? "";
    expect(message).not.toMatch(/^\s+at /m);
    expect(message).toContain("cld login");
    expect(message).toContain("npm install -g @openai/codex");
    expect(message).toContain("kimi login");
    expect(message).toContain("grok login");
    expect(message).toContain("cursor-agent login");
    expect(message).toContain("pr-jury ·");
    expect(message).toContain("✗ review-security  skipped: cld not installed");
    expect(message).toContain("review-security");
    expect(message).toContain("put cld on PATH, then: cld login");
    expect(message).not.toContain("CLD_CFUSE_BIN");
    expect(message).not.toContain("backend");
    const skipped = (
      error as { detail?: { skippedSeats?: Array<{ seat: string; reason: string }> } }
    ).detail?.skippedSeats;
    expect(
      skipped?.some((seat) => seat.seat === "review-security" && seat.reason === "missing"),
    ).toBe(true);
    const drivers = error?.detail?.drivers ?? [];
    expect(drivers.map((row) => row.driver).sort()).toEqual([
      "cfuse",
      "cld",
      "codex",
      "cursor-agent",
      "grok",
      "kimi",
    ]);
    for (const row of drivers) {
      expect(row.next, row.driver).toEqual(expect.any(String));
      expect(row.next).not.toMatch(/^\s+at /m);
    }
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
    expect(store.getAgent("review-codex").modelId).toBe("gpt-6-astra");
    expect(store.getCouncil("pr-jury").agentIds).toContain(store.getAgent("review-codex").id);
  });

  it("creates review-codex on the CLI default model when none is configured", async () => {
    stub(["cld", "kimi", "grok", "codex"], LOGGED_IN);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      missingDrivers: string[];
      drivers: Array<{ driver: string; next: string | null }>;
    };
    const store = new Store();
    expect(out.missingDrivers).not.toContain("codex-model");
    expect(store.getAgent("review-codex").modelId).toBe("default");
    expect(store.getAgent("ideate-challenger").modelId).toBe("default");
    expect(store.getCouncil("pr-jury").agentIds).toContain(store.getAgent("review-codex").id);
    expect(store.getCouncil("product-jury").agentIds).toContain(
      store.getAgent("ideate-challenger").id,
    );
    const codex = out.drivers.find((row) => row.driver === "codex");
    expect(codex?.next).toContain('model = "<model-id>"');
    expect(codex?.next).toContain("-m");
    expect(codex?.next).not.toContain(">>");
    expect(sink.human).toContain("✓ review-codex");
    expect(sink.human).toContain("✓ ideate-challenger");
    expect(sink.human).toContain("logged in · default model");
    expect(sink.human).not.toContain("config.toml");
    expect(sink.human).not.toContain(">>");
    expect(sink.human).not.toContain("seat not created");
  });

  it("keeps ideate-challenger on the CLI default model when the top-level model disappears", async () => {
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-astra"\n');
    stub(["kimi", "grok", "codex"], LOGGED_IN);
    await runInit([], makeSink());
    const seeded = new Store();
    expect(seeded.getCouncil("product-jury").agentIds).toContain(
      seeded.getAgent("ideate-challenger").id,
    );
    rmSync(join(codexHome, "config.toml"));
    await runInit([], makeSink());
    const store = new Store();
    expect(store.getAgent("ideate-challenger").modelId).toBe("default");
    expect(store.getAgent("review-codex").modelId).toBe("default");
    expect(store.getCouncil("product-jury").agentIds).toContain(
      store.getAgent("ideate-challenger").id,
    );
  });

  it("does not write an existing codex config.toml and still uses the default model", async () => {
    const original = [
      'sandbox_mode = "read-only"',
      "",
      "[profiles.x]",
      'model = "gpt-from-profile"',
      "",
    ].join("\n");
    const path = join(codexHome, "config.toml");
    writeFileSync(path, original);
    const stamp = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, stamp, stamp);
    const before = readFileSync(path);
    stub(["codex"], LOGGED_IN);
    await runInit([], makeSink());
    const after = readFileSync(path);
    expect(Buffer.compare(before, after)).toBe(0);
    expect(after.toString("utf8")).toBe(original);
    expect(statSync(path).mtimeMs).toBe(stamp.getTime());
    const store = new Store();
    expect(store.getAgent("review-codex").modelId).toBe("default");
    expect(store.getCouncil("pr-jury").agentIds).toContain(store.getAgent("review-codex").id);
  });

  it("does not silently replace a configured product-jury reporter", async () => {
    stub(["cld", "kimi", "grok"]);
    await runInit([], makeSink());
    expect(new Store().getCouncil("product-jury").reporterAgentId).toBe(
      new Store().getAgent("ideate-product").id,
    );
    // A later init may add Codex seats. An already chosen reporter stays.
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
    expect(out.missingDrivers.sort()).toEqual(["cld", "codex", "cursor-agent", "grok"]);
  });

  it("creates review-maintainability when kimi lives only in ~/.kimi-code/bin", async () => {
    process.env.PATH = bin;
    const vendor = join(home, ".kimi-code", "bin");
    mkdirSync(vendor, { recursive: true });
    const kimi = join(vendor, "kimi");
    writeFileSync(kimi, "#!/bin/sh\nexit 0\n");
    chmodSync(kimi, 0o755);
    writeFileSync(join(home, ".kimi-code", "credentials"), "{}\n");
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

  it("uses standalone cfuse as the review-security seat when cld is absent", async () => {
    stub(["cfuse", "kimi"], LOGGED_IN);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: Array<{ name: string; driverId: string }>;
      missingDrivers: string[];
      drivers: Array<{
        driver: string;
        found: boolean;
        path: string | null;
        version: string | null;
        login: string;
        next: string | null;
      }>;
    };
    expect(out.createdAgents.map((agent) => agent.name)).toContain("review-security");
    expect(out.createdAgents.find((agent) => agent.name === "review-security")?.driverId).toBe(
      "claude-stream-json",
    );
    expect(out.missingDrivers).not.toContain("cld");
    const cfuse = out.drivers.find((row) => row.driver === "cfuse");
    const cld = out.drivers.find((row) => row.driver === "cld");
    expect(cfuse).toMatchObject({ found: true, version: "1.2.3", login: "unknown", next: null });
    expect(cfuse?.path).toBe(join(bin, "cfuse"));
    expect(cld).toMatchObject({ found: false, path: null, login: "unknown" });
    expect(cld?.next).toContain("review-security");
    expect(cld?.next).toContain("cld login");
    expect(sink.human).toContain("✓ review-security");
    expect(sink.human).toContain("cfuse 1.2.3");
    expect(sink.human).toContain("login not checked");
    expect(sink.human).toContain(
      "? cld  not installed (review-security is using standalone cfuse instead)",
    );
    expect(sink.human).toContain("for full features, put cld on PATH, then: cld login");
    expect(sink.human).not.toContain("CLD_CFUSE_BIN");
    expect(sink.human).not.toContain("backend");
    expect(sink.human).not.toMatch(/\broute\b/);
    expect(sink.human).not.toMatch(/^\s+at /m);
    expect(new Store().getAgent("review-security").driverSelection).toEqual({
      driverId: "claude-stream-json",
      options: { route: "cfuse" },
    });
  });

  it("does not treat cfuse-claude alone as a seat", async () => {
    stub(["cfuse-claude", "kimi"], LOGGED_IN);
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: Array<{ name: string }>;
      missingDrivers: string[];
      drivers: Array<{
        driver: string;
        found: boolean;
        next: string | null;
        backendPath?: string | null;
      }>;
    };
    expect(out.createdAgents.map((agent) => agent.name)).not.toContain("review-security");
    expect(out.missingDrivers).toContain("cld");
    const cld = out.drivers.find((row) => row.driver === "cld");
    expect(cld?.found).toBe(false);
    expect(cld?.backendPath).toBe(join(bin, "cfuse-claude"));
    expect(cld?.next).toContain("cfuse-claude");
    expect(cld?.next).toContain("cld is required");
    expect(cld?.next).toContain("cld login");
    expect(sink.human).toContain("✗ review-security  skipped: cld not installed");
    expect(sink.human).toContain("put cld on PATH, then: cld login");
    expect(sink.human).not.toContain("cld is required");
    expect(sink.human).not.toContain("CLD_CFUSE_BIN");
    expect(sink.human).not.toContain("backend");
    const skipped = (
      out as {
        skippedSeats?: Array<{ seat: string; driver: string; reason: string; next: string }>;
      }
    ).skippedSeats;
    expect(skipped).toContainEqual(
      expect.objectContaining({
        seat: "review-security",
        driver: "cld",
        reason: "missing",
      }),
    );
    expect(skipped?.find((seat) => seat.seat === "review-security")?.next).toContain(
      "cld is required",
    );
    expect(new Store().getCouncil("pr-jury").skippedSeats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seat: "review-security", reason: "missing" }),
      ]),
    );
  });

  it("reports each driver logged out when the binary is present but login is not", async () => {
    stub(["cld", "kimi", "grok", "cursor-agent", "codex", "cfuse-claude-code"], LOGGED_OUT);
    delete process.env.CURSOR_API_KEY;
    delete process.env.GROK_HOME;
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      drivers: Array<{
        driver: string;
        found: boolean;
        login: string;
        next: string | null;
        version: string | null;
      }>;
    };
    for (const name of ["codex", "cursor-agent", "kimi", "grok"]) {
      const row = out.drivers.find((item) => item.driver === name);
      expect(row, name).toMatchObject({ found: true, login: "logged-out", version: "1.2.3" });
      expect(row?.next).toContain(`${name} login`);
    }
    expect(sink.human).toContain("✗ review-maintainability  skipped: kimi not logged in");
    expect(sink.human).toContain("review-maintainability");
    expect(sink.human).toContain("\n      kimi login\n");
    expect(sink.human).toContain("\n      codex login\n");
    expect(sink.human).toContain("not logged in");
    expect(sink.human).not.toMatch(/^\s+at /m);
  });

  it("reports every discovered driver ready when login checks succeed", async () => {
    stub(["cld", "cfuse", "kimi", "grok", "cursor-agent", "codex", "cfuse-claude-code"], LOGGED_IN);
    delete process.env.CURSOR_API_KEY;
    delete process.env.GROK_HOME;
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), "{}\n");
    mkdirSync(join(home, ".config", "cld"), { recursive: true });
    writeFileSync(join(home, ".config", "cld", "env"), "\n");
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: Array<{ name: string }>;
      drivers: Array<{
        driver: string;
        found: boolean;
        login: string;
        next: string | null;
        path: string | null;
      }>;
      skippedSeats: Array<{ seat: string; driver: string; reason: string }>;
    };
    expect(out.createdAgents.map((agent) => agent.name)).toContain("review-security");
    for (const name of ["cld", "kimi", "grok", "cursor-agent"]) {
      const row = out.drivers.find((item) => item.driver === name);
      expect(row, name).toMatchObject({
        found: true,
        login: "logged-in",
        next: null,
        path: join(bin, name),
      });
    }
    const codex = out.drivers.find((item) => item.driver === "codex");
    expect(codex).toMatchObject({ found: true, login: "logged-in", path: join(bin, "codex") });
    expect(codex?.next).toContain("-m");
    expect(codex?.next).not.toContain(">>");
    expect(out.drivers.find((item) => item.driver === "cfuse")).toMatchObject({
      found: true,
      login: "unknown",
      next: null,
    });
    expect(sink.human).toContain("logged in · default model");
    expect(sink.human).toContain("pr-jury (reporter");
    expect(sink.human).toContain("product-jury (reporter");
    expect(sink.human).not.toContain("login logged-in");
    expect(sink.human).not.toContain(" · councilkit");
    expect(sink.human).not.toContain("config.toml");
    expect(sink.human).not.toContain(">>");
    expect(sink.human).not.toMatch(/^\s+at /m);
    const skipped = out.skippedSeats;
    expect(skipped.filter((seat) => seat.seat.startsWith("review-"))).toEqual([]);
    expect(skipped.map((seat) => seat.seat)).not.toContain("ideate-challenger");
    expect(new Store().getCouncil("pr-jury").agentIds).toContain(
      new Store().getAgent("review-codex").id,
    );
    expect(new Store().getAgent("review-codex").modelId).toBe("default");
    expect(new Store().getCouncil("pr-jury").skippedSeats).toEqual([]);
    expect(new Store().getCouncil("product-jury").skippedSeats).toEqual([]);
  });

  it("records a missing default seat on the council and in both outputs", async () => {
    stub(["kimi"]);
    const sink = makeSink();
    await runInit([], sink);
    expect(sink.human).toContain("✗ review-security  skipped: cld not installed");
    expect(sink.human).toContain("put cld on PATH, then: cld login");
    const out = sink.finished as {
      skippedSeats: Array<{ seat: string; driver: string; reason: string; next: string }>;
    };
    const security = out.skippedSeats.find((seat) => seat.seat === "review-security");
    expect(security).toMatchObject({ driver: "cld", reason: "missing" });
    expect(security?.next).toContain("cld login");
    expect(out.skippedSeats.map((seat) => seat.seat)).toEqual([
      "review-security",
      "review-correctness",
      "review-adversarial",
      "review-cursor",
      "review-codex",
      "ideate-product",
      "ideate-challenger",
    ]);
    expect(new Store().getCouncil("pr-jury").skippedSeats?.map((seat) => seat.seat)).toEqual([
      "review-security",
      "review-correctness",
      "review-adversarial",
      "review-cursor",
      "review-codex",
    ]);
    expect(new Store().listAgents().map((agent) => agent.name)).not.toContain("review-security");
  });

  it("skips a default seat when its driver is logged out", async () => {
    stub(["cld", "kimi", "grok"]);
    rmSync(join(home, ".grok", "auth.json"));
    const sink = makeSink();
    await runInit([], sink);
    const out = sink.finished as {
      createdAgents: Array<{ name: string }>;
      skippedSeats: Array<{ seat: string; driver: string; reason: string; next: string }>;
    };
    expect(out.createdAgents.map((agent) => agent.name)).not.toContain("review-correctness");
    expect(out.createdAgents.map((agent) => agent.name)).not.toContain("review-adversarial");
    expect(out.createdAgents.map((agent) => agent.name)).toContain("review-security");
    expect(sink.human).toContain("✗ 2 seats skipped: grok not logged in");
    expect(sink.human).toContain("review-correctness, review-adversarial");
    expect(sink.human).toContain("\n      grok login\n");
    expect(out.skippedSeats).toContainEqual(
      expect.objectContaining({
        seat: "review-correctness",
        driver: "grok",
        reason: "logged-out",
        next: "Run `grok login`.",
      }),
    );
    expect(out.skippedSeats).toContainEqual(
      expect.objectContaining({ seat: "review-adversarial", driver: "grok", reason: "logged-out" }),
    );
    expect(out.skippedSeats).toContainEqual(
      expect.objectContaining({ seat: "ideate-product", driver: "grok", reason: "logged-out" }),
    );
    const stored = new Store().getCouncil("pr-jury").skippedSeats ?? [];
    expect(stored.map((seat) => seat.seat).sort()).toEqual(
      ["review-adversarial", "review-codex", "review-correctness", "review-cursor"].sort(),
    );
  });

  it("does not list review-security as skipped when standalone cfuse fills it", async () => {
    stub(["cfuse", "kimi"], LOGGED_IN);
    const sink = makeSink();
    await runInit([], sink);
    const skipped = (sink.finished as { skippedSeats: Array<{ seat: string }> }).skippedSeats.map(
      (seat) => seat.seat,
    );
    expect(skipped).not.toContain("review-security");
    expect(new Store().getCouncil("pr-jury").skippedSeats?.map((seat) => seat.seat)).not.toContain(
      "review-security",
    );
  });

  it("clears a skipped seat after the driver is installed and init runs again", async () => {
    stub(["kimi"]);
    await runInit([], makeSink());
    expect(new Store().getCouncil("pr-jury").skippedSeats?.map((seat) => seat.seat)).toContain(
      "review-security",
    );
    stub(["kimi", "cld"]);
    await runInit([], makeSink());
    const skips = new Store().getCouncil("pr-jury").skippedSeats ?? [];
    expect(skips.map((seat) => seat.seat)).not.toContain("review-security");
    expect(new Store().listAgents().map((agent) => agent.name)).toContain("review-security");
  });

  it("still loads a council written before skippedSeats existed", async () => {
    stub(["kimi"]);
    await runInit([], makeSink());
    const path = resolvePaths().councils;
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      councils: Array<Record<string, unknown>>;
    };
    for (const council of file.councils) delete council.skippedSeats;
    writeFileSync(path, JSON.stringify(file));
    const loaded = new Store().getCouncil("pr-jury");
    expect(loaded.name).toBe("pr-jury");
    expect(loaded.skippedSeats).toBeUndefined();
  });

  it("lists every default seat as created or skipped", async () => {
    const names = [...DEFAULT_AGENT_NAMES, ...IDEATE_AGENT_NAMES];
    const accounted = (input: {
      createdAgents?: Array<{ name: string }>;
      reusedAgents?: Array<{ name: string }>;
      skippedSeats?: Array<{ seat: string }>;
    }) => {
      const created = new Set([
        ...(input.createdAgents ?? []).map((agent) => agent.name),
        ...(input.reusedAgents ?? []).map((agent) => agent.name),
      ]);
      const skipped = new Set((input.skippedSeats ?? []).map((seat) => seat.seat));
      for (const name of names) {
        expect(created.has(name) !== skipped.has(name), name).toBe(true);
      }
    };

    process.env.PATH = bin;
    delete process.env.CURSOR_API_KEY;
    const missing = await runInit([], makeSink()).then(
      () => null,
      (error: { detail?: { skippedSeats?: Array<{ seat: string }> } }) => error,
    );
    accounted({ skippedSeats: missing?.detail?.skippedSeats });

    stub(["kimi"]);
    const kimiOnly = makeSink();
    await runInit([], kimiOnly);
    accounted(
      kimiOnly.finished as {
        createdAgents: Array<{ name: string }>;
        reusedAgents: Array<{ name: string }>;
        skippedSeats: Array<{ seat: string }>;
      },
    );

    stub(["cfuse", "kimi", "cursor-agent", "codex"], LOGGED_IN);
    const codexDefault = makeSink();
    await runInit([], codexDefault);
    const codexOut = codexDefault.finished as {
      createdAgents: Array<{ name: string; modelId: string }>;
      reusedAgents: Array<{ name: string }>;
      skippedSeats: Array<{ seat: string }>;
    };
    accounted(codexOut);
    expect(
      codexOut.createdAgents.find((agent) => agent.name === "ideate-challenger")?.modelId,
    ).toBe("default");
    expect(codexOut.skippedSeats.map((seat) => seat.seat)).not.toContain("ideate-challenger");
    expect(codexOut.skippedSeats.map((seat) => seat.seat)).not.toContain("review-codex");

    stub(["cld", "kimi", "grok", "cursor-agent", "codex"], LOGGED_OUT);
    const signedOut = makeSink();
    await runInit([], signedOut);
    accounted(
      signedOut.finished as {
        createdAgents: Array<{ name: string }>;
        reusedAgents: Array<{ name: string }>;
        skippedSeats: Array<{ seat: string }>;
      },
    );
  });

  it("prints the symbol layout for a mixed PATH", async () => {
    const script = (version: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
if [ "$1" = "login" ] || [ "$1" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
exit 0
`;
    for (const [name, version] of [
      ["cfuse", "2.6.43"],
      ["kimi", "2.1.1"],
      ["cursor-agent", "2026.10.16"],
      ["codex", "codex-cli 0.161.0"],
    ] as const) {
      const path = join(bin, name);
      writeFileSync(path, script(version));
      chmodSync(path, 0o755);
    }
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    writeFileSync(join(home, ".kimi-code", "credentials"), "{}\n");
    process.env.PATH = bin;
    const sink = makeSink();
    await runInit([], sink);
    expect(sink.human).toBe(`init: 2 councils · 6 seats ready, 3 skipped

pr-jury (reporter review-security) · 4 ready, 2 skipped
  ✓ review-security        cfuse 2.6.43   login not checked
  ✓ review-maintainability kimi 2.1.1     logged in
  ✓ review-cursor          cursor-agent   logged in
  ✓ review-codex           codex 0.161.0  logged in · default model
  ✗ 2 seats skipped: grok not installed
      review-correctness, review-adversarial
      install grok so it's on PATH, then: grok login

product-jury (reporter ideate-challenger) · 2 ready, 1 skipped
  ✓ ideate-engineering     kimi 2.1.1     logged in
  ✓ ideate-challenger      codex 0.161.0  logged in · default model
  ✗ ideate-product  skipped: grok not installed
      install grok so it's on PATH, then: grok login

  ? cld  not installed (review-security is using standalone cfuse instead)
      for full features, put cld on PATH, then: cld login

next:
  councilkit review --council pr-jury --pr <url>
  councilkit ideate "<idea>" --council product-jury
open reports: http://127.0.0.1:43127/reports`);
    expect(sink.human).not.toContain("CLD_CFUSE_BIN");
    expect(sink.human).not.toContain(" · councilkit");
    expect(sink.human).not.toContain("config.toml");
    expect(sink.human).not.toContain(">>");
    const out = sink.finished as { drivers: Array<{ driver: string; next: string | null }> };
    const codex = out.drivers.find((row) => row.driver === "codex");
    expect(codex?.next).toContain('model = "<model-id>"');
    expect(codex?.next).toContain("-m <model-id>");
    expect(codex?.next).not.toContain(">>");
  });

  it("runs a toy review on review-codex without passing a model flag", async () => {
    stub(["codex"], LOGGED_IN);
    await runInit([], makeSink());
    const store = new Store();
    expect(store.getAgent("review-codex").modelId).toBe("default");
    expect(store.getCouncil("pr-jury").reporterAgentId).toBe(store.getAgent("review-codex").id);
    const calls: string[][] = [];
    const spawn: SpawnImpl = async (input: SpawnInput) => {
      calls.push(input.argv);
      const text =
        input.prompt.includes("对比汇总") || input.prompt.includes("Aggregator")
          ? "## 概览\nok\n## 共识发现\n- x\n## 独有发现\n- y\n## 分歧\nnone\n## 结论\napprove"
          : "## 发现\n- [nit] a.ts:1 — n\n## 验证\n未验证\n## 结论\ncomment";
      return {
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text },
        }),
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    };
    const sink = makeSink();
    try {
      await runReview(
        ["--council", "pr-jury", "--task", "fixture review", "--no-require-spec"],
        sink,
        { spawnImpl: spawn },
      );
    } catch (error) {
      if (!(error instanceof ReviewExit) || error.exitCode !== 0) throw error;
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv).not.toContain("-m");
      expect(argv).not.toContain("--model");
      expect(argv).not.toContain("default");
    }
    const finished = sink.finished as { reportPath?: string };
    expect(finished.reportPath ?? "").not.toHaveLength(0);
  });

  it("reviews with the printed pr-jury command when the reporter is standalone cfuse", async () => {
    stub(["cfuse", "kimi", "cursor-agent", "codex"], LOGGED_IN);
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
    const sink = makeSink();
    await runInit([], sink);
    const reviewLine = sink.human
      .split("\n")
      .find((line) => line.includes("councilkit review --council pr-jury"));
    expect(reviewLine?.trim()).toBe("councilkit review --council pr-jury --pr <url>");
    const pr = "https://github.com/acme/widget/pull/7";
    const tokens = (reviewLine ?? "").trim().split(/\s+/);
    expect(tokens.slice(0, 2)).toEqual(["councilkit", "review"]);
    const args = tokens.slice(2).map((token) => (token === "<url>" ? pr : token));
    args.push("--no-require-spec");

    const repo = join(home, "src-repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "head"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], {
      cwd: repo,
    });

    const calls: SpawnInput[] = [];
    const spawn: SpawnImpl = async (input) => {
      calls.push(input);
      const text =
        input.prompt === DRIVER_PROBE_PROMPT
          ? "ok"
          : input.prompt.includes("对比汇总") || input.prompt.includes("Aggregator")
            ? "## 概览\nok\n## 共识发现\n- x\n## 独有发现\n- y\n## 分歧\nnone\n## 结论\napprove"
            : "## 发现\n- [nit] a.ts:1 — n\n## 验证\n未验证\n## 结论\ncomment";
      if (input.driverId === "claude-stream-json") {
        return { stdout: `${text}\n`, exitCode: 0, timedOut: false, aborted: false };
      }
      if (input.driverId === "kimi-stream-json") {
        return {
          stdout: `${JSON.stringify({ role: "assistant", content: text })}\n`,
          exitCode: 0,
          timedOut: false,
          aborted: false,
        };
      }
      if (input.driverId === "codex-app-server") {
        return {
          stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`,
          exitCode: 0,
          timedOut: false,
          aborted: false,
        };
      }
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: text,
        }),
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    };

    const cwd = process.cwd();
    const reviewSink = makeSink();
    let exitCode = -1;
    try {
      process.chdir(repo);
      await runReview(args, reviewSink, { spawnImpl: spawn, worktreeRef: "HEAD" });
    } catch (error) {
      if (!(error instanceof ReviewExit)) throw error;
      exitCode = error.exitCode;
    } finally {
      process.chdir(cwd);
    }
    expect(exitCode).toBe(0);
    const finished = reviewSink.finished as { reportPath?: string; status?: string };
    expect(finished.status).toBe("completed");
    expect((finished.reportPath ?? "").length).toBeGreaterThan(0);
    expect(readFileSync(finished.reportPath ?? "", "utf8").length).toBeGreaterThan(0);
    const claudeCalls = calls.filter((call) => call.driverId === "claude-stream-json");
    expect(claudeCalls.length).toBeGreaterThan(0);
    for (const call of claudeCalls) {
      expect(basename(call.executable)).toBe("cfuse");
      expect(call.argv).toContain("-p");
      expect(call.argv).toContain("--output-format");
      expect(call.argv).toContain("text");
      expect(call.argv).toContain("--skip-update");
    }
    expect(calls.every((call) => basename(call.executable) !== "cld")).toBe(true);
  });

  it("does not advertise product-jury when fewer than two seats are ready", async () => {
    const expectExplained = async (needle: string): Promise<void> => {
      const error = await runIdeate(
        ["ship a widget", "--council", "product-jury"],
        makeSink(),
      ).then(
        () => null,
        (caught: { message?: string }) => caught,
      );
      const message = error?.message ?? "";
      expect(message).toContain("product-jury was not created");
      expect(message).toContain("at least 2 ready seats");
      expect(message).toContain(needle);
      expect(message).not.toContain("councilkit init --json");
      expect(message.split("\n").every((line) => line.length <= 80)).toBe(true);
    };

    stub(["grok"], LOGGED_IN);
    const grok = makeSink();
    await runInit([], grok);
    expect(grok.human).toBe(`init: 1 council · 3 seats ready, 6 skipped

pr-jury (reporter review-adversarial) · 2 ready, 4 skipped
  ✓ review-correctness     grok 1.2.3     logged in
  ✓ review-adversarial     grok 1.2.3     logged in
  ✗ review-security  skipped: cld not installed
      put cld on PATH, then: cld login
  ✗ review-maintainability  skipped: kimi not installed
      install kimi so it's on PATH, then: kimi login
  ✗ review-cursor  skipped: cursor-agent not installed
      curl https://cursor.com/install -fsS | bash, then: cursor-agent login
  ✗ review-codex  skipped: codex not installed
      npm install -g @openai/codex, then: codex login

product-jury · not created (needs at least 2 ready seats), 1 ready, 2 skipped
  ✓ ideate-product         grok 1.2.3     logged in
  ✗ ideate-engineering  skipped: kimi not installed
      install kimi so it's on PATH, then: kimi login
  ✗ ideate-challenger  skipped: codex not installed
      npm install -g @openai/codex, then: codex login

next:
  councilkit review --council pr-jury --pr <url>
open reports: http://127.0.0.1:43127/reports`);
    expect(grok.human.split("\n").every((line) => line.length <= 80)).toBe(true);
    expect(new Store().listCouncils().map((council) => council.name)).toEqual(["pr-jury"]);
    expect(new Store().getPendingCouncil("product-jury")?.readySeats).toEqual(["ideate-product"]);
    await expectExplained("ideate-engineering");
    await expect(
      runReview(
        ["--council", "product-jury", "--task", "fixture", "--no-require-spec"],
        makeSink(),
      ),
    ).rejects.toThrow(/product-jury was not created/);

    stub(["grok", "kimi"], LOGGED_IN);
    await runInit([], makeSink());
    expect(new Store().getCouncil("product-jury").name).toBe("product-jury");
    expect(new Store().getPendingCouncil("product-jury")).toBeNull();

    const wipe = (): void => {
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home, { recursive: true });
      rmSync(bin, { recursive: true, force: true });
      mkdirSync(bin, { recursive: true });
      rmSync(codexHome, { recursive: true, force: true });
      mkdirSync(codexHome, { recursive: true });
      process.env.COUNCILKIT_HOME = home;
      process.env.HOME = home;
      process.env.CODEX_HOME = codexHome;
      process.env.PATH = bin;
      delete process.env.CURSOR_API_KEY;
      delete process.env.GROK_HOME;
    };

    wipe();
    const loginFailed = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.161.0"; exit 0; fi
if [ "$1" = "login" ]; then echo "login failed"; exit 1; fi
exit 1
`;
    stub(["codex"], loginFailed);
    await expect(runInit([], makeSink())).rejects.toMatchObject({ exitCode: 2 });
    expect(new Store().listCouncils()).toEqual([]);
    const codexPending = new Store().getPendingCouncil("product-jury");
    expect(codexPending?.skippedSeats).toContainEqual(
      expect.objectContaining({ seat: "ideate-challenger", driver: "codex", reason: "logged-out" }),
    );
    await expectExplained("codex login");

    wipe();
    writeFileSync(join(bin, "grok"), LOGGED_IN);
    chmodSync(join(bin, "grok"), 0o755);
    process.env.PATH = bin;
    await expect(runInit([], makeSink())).rejects.toMatchObject({ exitCode: 2 });
    expect(new Store().getPendingCouncil("product-jury")?.skippedSeats).toContainEqual(
      expect.objectContaining({ seat: "ideate-product", driver: "grok", reason: "logged-out" }),
    );
    await expectExplained("grok login");

    wipe();
    stub(["cfuse"], LOGGED_IN);
    const cfuse = makeSink();
    await runInit([], cfuse);
    expect(cfuse.human.startsWith("init: 1 council ·")).toBe(true);
    expect(cfuse.human).toContain("product-jury · not created");
    expect(cfuse.human).not.toContain('councilkit ideate "<idea>"');
    expect(new Store().getCouncil("pr-jury").name).toBe("pr-jury");
    expect(() => new Store().getCouncil("product-jury")).toThrow(/no council/);
    await expectExplained("install grok");

    wipe();
    stub(["cfuse-claude"], LOGGED_IN);
    const wrapped = makeSink();
    const wrappedError = await runInit([], wrapped).then(
      () => null,
      (caught: { message?: string }) => caught,
    );
    expect(wrappedError?.message ?? "").toContain("init: 0 councils");
    expect(wrappedError?.message ?? "").toContain("review-security");
    expect(wrappedError?.message ?? "").not.toContain("CLD_CFUSE_BIN");
    expect(new Store().listCouncils()).toEqual([]);
    expect(
      new Store().getPendingCouncil("product-jury")?.skippedSeats.map((seat) => seat.seat),
    ).toEqual(["ideate-product", "ideate-engineering", "ideate-challenger"]);
    await expectExplained("ideate-product");
  });

  it("prints an overview and plain reasons when no CLI is usable", async () => {
    process.env.PATH = bin;
    delete process.env.CURSOR_API_KEY;
    const error = await runInit([], makeSink()).then(
      () => null,
      (caught: { message: string; exitCode: number; detail?: Record<string, unknown> }) => caught,
    );
    expect(error).not.toBeNull();
    const human = renderErrorHuman({
      name: "CliError",
      exitCode: error?.exitCode,
      message: error?.message ?? "",
      detail: error?.detail,
    });
    expect(human).toBe(`error[2]: no usable review CLI on PATH
init: 0 councils · 0 seats ready, 9 skipped

pr-jury · not created (needs at least 1 ready seat), 0 ready, 6 skipped
  ✗ review-security  skipped: cld not installed
      put cld on PATH, then: cld login
  ✗ 2 seats skipped: grok not installed
      review-correctness, review-adversarial
      install grok so it's on PATH, then: grok login
  ✗ review-maintainability  skipped: kimi not installed
      install kimi so it's on PATH, then: kimi login
  ✗ review-cursor  skipped: cursor-agent not installed
      curl https://cursor.com/install -fsS | bash, then: cursor-agent login
  ✗ review-codex  skipped: codex not installed
      npm install -g @openai/codex, then: codex login

product-jury · not created (needs at least 2 ready seats), 0 ready, 3 skipped
  ✗ ideate-product  skipped: grok not installed
      install grok so it's on PATH, then: grok login
  ✗ ideate-engineering  skipped: kimi not installed
      install kimi so it's on PATH, then: kimi login
  ✗ ideate-challenger  skipped: codex not installed
      npm install -g @openai/codex, then: codex login

next:
  install a logged-in CLI, then run: councilkit init`);
    expect(human).not.toContain("detail:");
    expect(human).not.toContain("{");
    for (const line of human.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    expect(error?.detail?.skippedSeats).toEqual(expect.any(Array));
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
