/**
 * ideate command: restricted probes, shared run deadline, and no auth
 * leftovers in retained report/workspace artifacts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_PROBE_PROMPT } from "../src/auto/driver-commands";
import { IDEATE_AUTH_BASENAMES } from "../src/auto/ideate-policy";
import { IDEATE_REPORT_HEADINGS } from "../src/auto/templates/ideate";
import type { RunnerTimers, SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { IdeateExit, runIdeate } from "../src/commands/ideate";
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

function envelope(driverId: string, text: string): SpawnOutput {
  if (driverId === "kimi-stream-json") {
    return {
      stdout: JSON.stringify({ role: "assistant", content: text }),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    };
  }
  if (driverId === "grok-stream-json") {
    return {
      stdout: JSON.stringify({ type: "result", result: text }),
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

function decisionBody(): string {
  return IDEATE_REPORT_HEADINGS.map((heading) => `${heading}\nbody`).join("\n\n");
}

function collectAuthHits(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if ((IDEATE_AUTH_BASENAMES as readonly string[]).includes(name)) hits.push(path);
      try {
        if (statSync(path).isDirectory()) walk(path);
      } catch {
        // ignore
      }
    }
  };
  walk(root);
  return hits;
}

describe("councilkit ideate", () => {
  let home: string;
  let bin: string;
  let poisoned: string;
  let oldHome: string | undefined;
  let oldPath: string | undefined;
  let oldKimi: string | undefined;
  let oldGrok: string | undefined;
  let oldUserHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-ideate-cmd-"));
    bin = mkdtempSync(join(tmpdir(), "ck-ideate-bin-"));
    poisoned = mkdtempSync(join(tmpdir(), "ck-ideate-poison-"));
    mkdirSync(join(poisoned, ".kimi-code", "credentials"), { recursive: true });
    mkdirSync(join(poisoned, ".grok"), { recursive: true });
    writeFileSync(join(poisoned, ".kimi-code", "server.token"), "kimi-secret-token\n", { mode: 0o600 });
    writeFileSync(join(poisoned, ".kimi-code", "credentials", "token"), "kimi-cred\n", { mode: 0o600 });
    writeFileSync(join(poisoned, ".grok", "auth.json"), '{"token":"grok-secret"}\n', { mode: 0o600 });
    for (const name of ["cld", "kimi", "codex", "grok", "cursor-agent"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    oldHome = process.env.COUNCILKIT_HOME;
    oldPath = process.env.PATH;
    oldKimi = process.env.KIMI_CODE_HOME;
    oldGrok = process.env.GROK_HOME;
    oldUserHome = process.env.HOME;
    process.env.COUNCILKIT_HOME = home;
    process.env.PATH = bin;
    process.env.HOME = poisoned;
    process.env.KIMI_CODE_HOME = join(poisoned, ".kimi-code");
    process.env.GROK_HOME = join(poisoned, ".grok");
  });

  afterEach(() => {
    process.env.COUNCILKIT_HOME = oldHome;
    process.env.PATH = oldPath;
    process.env.KIMI_CODE_HOME = oldKimi;
    process.env.GROK_HOME = oldGrok;
    process.env.HOME = oldUserHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(poisoned, { recursive: true, force: true });
  });

  function seedRoster(): { product: string; engineering: string } {
    const store = new Store();
    const product = store.createAgent({
      name: "ideate-product",
      personaPrompt: "product",
      modelId: "grok-4.6",
      color: "#38bdf8",
      driverSelection: { driverId: "grok-stream-json", options: {} },
    });
    const engineering = store.createAgent({
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
      agentIds: [product.id, engineering.id],
      rounds: 1,
      reporterAgentId: product.id,
    });
    return { product: product.id, engineering: engineering.id };
  }

  it("keeps report and workspace artifacts free of copied auth files", async () => {
    seedRoster();
    const seen: SpawnInput[] = [];
    const spawnImpl: SpawnImpl = async (input) => {
      seen.push(input);
      if (input.prompt.includes(DRIVER_PROBE_PROMPT)) {
        expect(input.argv).not.toContain("--always-approve");
        expect(input.argv).not.toContain("--auto");
        expect(input.argv).not.toContain("-y");
        if (input.driverId === "grok-stream-json") {
          expect(input.argv).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
        }
        if (input.driverId === "kimi-stream-json") {
          expect(input.argv).toContain("-p");
          expect(input.argv).toContain("--agent-file");
          expect(input.argv).not.toContain("--plan");
        }
        return envelope(input.driverId ?? "", "ok");
      }
      if (input.prompt.includes("中立决策 Aggregator")) {
        return envelope(input.driverId ?? "", decisionBody());
      }
      return envelope(input.driverId ?? "", `proposal from ${input.cwd}`);
    };
    const sink = makeSink();
    try {
      await runIdeate(["a local weekly feedback tool", "--debate-rounds", "0", "--json"], sink, {
        spawnImpl,
      });
    } catch (error) {
      if (!(error instanceof IdeateExit) || error.exitCode !== 0) throw error;
    }
    const out = sink.finished as { runId: string; reportPath: string; status: string };
    expect(out.status).toBe("completed");
    expect(collectAuthHits(out.reportPath)).toEqual([]);
    expect(readFileSync(out.reportPath, "utf8")).not.toContain("kimi-secret-token");
    expect(readFileSync(out.reportPath, "utf8")).not.toContain("grok-secret");
    const runDir = resolvePaths().runDir(out.runId);
    expect(collectAuthHits(runDir)).toEqual([]);
    expect(existsSync(runDir)).toBe(true);
    expect(seen.some((row) => row.prompt.includes(DRIVER_PROBE_PROMPT))).toBe(true);
    expect(seen.some((row) => row.argv.includes("--always-approve"))).toBe(false);
  });

  it("aborts in-flight proposals when the shared run deadline expires", async () => {
    seedRoster();
    let proposalsStarted = 0;
    const spawnImpl: SpawnImpl = async (input) => {
      if (input.prompt.includes(DRIVER_PROBE_PROMPT)) {
        return envelope(input.driverId ?? "", "ok");
      }
      proposalsStarted += 1;
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        stdout: "",
        exitCode: null,
        timedOut: false,
        aborted: true,
      };
    };
    const sink = makeSink();
    try {
      await runIdeate(
        ["deadline idea", "--debate-rounds", "0", "--run-timeout", "200ms", "--timeout", "30s"],
        sink,
        { spawnImpl },
      );
    } catch (error) {
      if (!(error instanceof IdeateExit)) throw error;
      expect(error.exitCode).toBe(130);
    }
    const out = sink.finished as { status: string; failure?: { code: string } };
    expect(out.status).toBe("interrupted");
    expect(proposalsStarted).toBeGreaterThan(0);
  });

  it("completes a one-round run with blind proposals and serial debate", async () => {
    seedRoster();
    const seen: SpawnInput[] = [];
    const spawnImpl: SpawnImpl = async (input) => {
      seen.push(input);
      if (input.prompt.includes(DRIVER_PROBE_PROMPT)) return envelope(input.driverId ?? "", "ok");
      if (input.prompt.includes("中立决策 Aggregator")) {
        expect(input.prompt).toContain("PRODUCT_UNIQUE_PROPOSAL");
        expect(input.prompt).toContain("ENGINEERING_UNIQUE_PROPOSAL");
        expect(input.prompt).toContain("DEBATE_R1_PRODUCT");
        expect(input.prompt).toContain("DEBATE_R1_ENGINEERING");
        return envelope(input.driverId ?? "", decisionBody());
      }
      if (input.prompt.includes("独立提出产品方案")) {
        expect(input.prompt).toContain("你看不到其他席位的提案");
        if (input.prompt.includes("ideate-product")) {
          expect(input.prompt).not.toContain("ENGINEERING_UNIQUE_PROPOSAL");
          return envelope(input.driverId ?? "", "PRODUCT_UNIQUE_PROPOSAL\n\nproduct body");
        }
        expect(input.prompt).not.toContain("PRODUCT_UNIQUE_PROPOSAL");
        return envelope(input.driverId ?? "", "ENGINEERING_UNIQUE_PROPOSAL\n\neng body");
      }
      if (input.prompt.includes("第 1/1 轮串行辩论")) {
        expect(input.prompt).toContain("PRODUCT_UNIQUE_PROPOSAL");
        expect(input.prompt).toContain("ENGINEERING_UNIQUE_PROPOSAL");
        if (input.prompt.includes("ideate-engineering")) {
          expect(input.prompt).toContain("DEBATE_R1_PRODUCT");
        }
        return envelope(
          input.driverId ?? "",
          input.prompt.includes("ideate-product") ? "DEBATE_R1_PRODUCT" : "DEBATE_R1_ENGINEERING",
        );
      }
      throw new Error(`unexpected prompt: ${input.prompt.slice(0, 80)}`);
    };
    const sink = makeSink();
    try {
      await runIdeate(["weekly feedback sorter", "--debate-rounds", "1", "--json"], sink, {
        spawnImpl,
      });
    } catch (error) {
      if (!(error instanceof IdeateExit) || error.exitCode !== 0) throw error;
    }
    const out = sink.finished as {
      status: string;
      incomplete: boolean;
      integrity: {
        successfulProposals: number;
        plannedProposals: number;
        successfulDebates: number;
        plannedDebates: number;
        failedSeats: unknown[];
      };
      reportPath: string;
    };
    expect(out.status).toBe("completed");
    expect(out.incomplete).toBe(false);
    expect(out.integrity).toMatchObject({
      successfulProposals: 2,
      plannedProposals: 2,
      successfulDebates: 2,
      plannedDebates: 2,
      failedSeats: [],
    });
    const report = readFileSync(out.reportPath, "utf8");
    for (const heading of IDEATE_REPORT_HEADINGS) expect(report).toContain(heading);
    expect(report).toContain("PRODUCT_UNIQUE_PROPOSAL");
    expect(report).toContain("ENGINEERING_UNIQUE_PROPOSAL");
    expect(seen.filter((row) => row.prompt.includes("独立提出产品方案"))).toHaveLength(2);
    expect(seen.filter((row) => row.prompt.includes("串行辩论"))).toHaveLength(2);
  });

  it("completes a two-round run and feeds prior debates into later turns", async () => {
    seedRoster();
    const debates: string[] = [];
    const spawnImpl: SpawnImpl = async (input) => {
      if (input.prompt.includes(DRIVER_PROBE_PROMPT)) return envelope(input.driverId ?? "", "ok");
      if (input.prompt.includes("中立决策 Aggregator")) {
        expect(input.prompt).toContain("DEBATE_R2_ENGINEERING");
        expect(input.prompt).toContain("DEBATE_R2_PRODUCT");
        return envelope(input.driverId ?? "", decisionBody());
      }
      if (input.prompt.includes("独立提出产品方案")) {
        return envelope(
          input.driverId ?? "",
          input.prompt.includes("ideate-product") ? "P1" : "P2",
        );
      }
      const round = input.prompt.includes("第 2/2 轮") ? 2 : 1;
      const who = input.prompt.includes("ideate-product") ? "PRODUCT" : "ENGINEERING";
      const text = `DEBATE_R${round}_${who}`;
      if (round === 2) {
        expect(input.prompt).toContain("DEBATE_R1_PRODUCT");
        expect(input.prompt).toContain("DEBATE_R1_ENGINEERING");
      }
      if (round === 2 && who === "PRODUCT") {
        expect(input.prompt).toContain("DEBATE_R2_ENGINEERING");
      }
      debates.push(`${round}:${who}`);
      return envelope(input.driverId ?? "", text);
    };
    const sink = makeSink();
    try {
      await runIdeate(["two-round idea", "--debate-rounds", "2", "--json"], sink, { spawnImpl });
    } catch (error) {
      if (!(error instanceof IdeateExit) || error.exitCode !== 0) throw error;
    }
    const out = sink.finished as {
      status: string;
      integrity: { successfulDebates: number; plannedDebates: number };
    };
    expect(out.status).toBe("completed");
    expect(out.integrity.successfulDebates).toBe(4);
    expect(out.integrity.plannedDebates).toBe(4);
    expect(debates).toEqual(["1:PRODUCT", "1:ENGINEERING", "2:ENGINEERING", "2:PRODUCT"]);
  });

  it("keeps physical retries in transcript but uses the final logical result", async () => {
    seedRoster();
    const proposalTries = new Map<string, number>();
    const retryChecks: Array<{
      cwd: string;
      agentFile: string | undefined;
      kimiHome: string | undefined;
    }> = [];
    const spawnImpl: SpawnImpl = async (input) => {
      if (input.prompt.includes(DRIVER_PROBE_PROMPT)) return envelope(input.driverId ?? "", "ok");
      if (input.prompt.includes("中立决策 Aggregator")) {
        expect(input.prompt).toContain("RECOVERED_PROPOSAL");
        expect(input.prompt).not.toContain("failed: EXIT");
        return envelope(input.driverId ?? "", decisionBody());
      }
      if (input.prompt.includes("独立提出产品方案")) {
        const n = (proposalTries.get(input.cwd) ?? 0) + 1;
        proposalTries.set(input.cwd, n);
        if (input.driverId === "kimi-stream-json" && n === 1) {
          return { stdout: "", exitCode: 7, timedOut: false, aborted: false };
        }
        if (n === 2) {
          const agentFile = input.argv.includes("--agent-file")
            ? (input.argv[input.argv.indexOf("--agent-file") + 1] as string)
            : undefined;
          retryChecks.push({
            cwd: input.cwd,
            agentFile,
            kimiHome: input.envOverlay?.KIMI_CODE_HOME,
          });
          expect(existsSync(join(input.cwd, ".councilkit-ideate-policy"))).toBe(true);
          expect(agentFile !== undefined && existsSync(agentFile)).toBe(true);
          expect(input.envOverlay?.KIMI_CODE_HOME).toMatch(/ck-ideate-kimi-/);
          expect(input.envOverlay?.KIMI_CODE_HOME?.startsWith(input.cwd)).toBe(false);
          expect(existsSync(input.envOverlay?.KIMI_CODE_HOME ?? "")).toBe(true);
          expect(existsSync(join(input.cwd, ".ideate-os-home"))).toBe(true);
        }
        return envelope(
          input.driverId ?? "",
          input.driverId === "kimi-stream-json"
            ? "RECOVERED_PROPOSAL\n\nretry body"
            : "STABLE_PROPOSAL\n\nfirst body",
        );
      }
      return envelope(input.driverId ?? "", "debate ok");
    };
    const sink = makeSink();
    try {
      await runIdeate(["retry idea", "--debate-rounds", "0", "--json"], sink, { spawnImpl });
    } catch (error) {
      if (!(error instanceof IdeateExit) || error.exitCode !== 0) throw error;
    }
    const out = sink.finished as {
      status: string;
      incomplete: boolean;
      integrity: { successfulProposals: number; failedSeats: Array<{ attemptId: string }> };
      reportPath: string;
      transcriptPath: string;
      runId: string;
    };
    expect(out.status).toBe("completed");
    expect(out.incomplete).toBe(false);
    expect(out.integrity.successfulProposals).toBe(2);
    expect(out.integrity.failedSeats.map((row) => row.attemptId)).not.toContain("proposal-seat2");
    const report = readFileSync(out.reportPath, "utf8");
    expect(report).toContain("RECOVERED_PROPOSAL");
    expect(report).not.toMatch(/proposal-seat2[\s\S]*failed: EXIT/);
    const records = readFileSync(out.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const physical = records.filter(
      (row) => row.kind === "attempt.finished" && row.attemptId === "proposal-seat2",
    );
    expect(physical).toHaveLength(2);
    expect(physical[0]).toMatchObject({ status: "failure", attemptNumber: 1, willRetry: true });
    expect(physical[1]).toMatchObject({ status: "success", attemptNumber: 2, retryOf: 1 });
    expect(retryChecks).toHaveLength(1);
    expect(collectAuthHits(resolvePaths().runDir(out.runId))).toEqual([]);
  });

  it("marks aggregator cancellation as interrupted with exit 130", async () => {
    seedRoster();
    const controller = new AbortController();
    const spawnImpl: SpawnImpl = async (input) => {
      if (input.prompt.includes(DRIVER_PROBE_PROMPT)) return envelope(input.driverId ?? "", "ok");
      if (input.prompt.includes("独立提出产品方案")) {
        return envelope(input.driverId ?? "", `proposal ${input.cwd}`);
      }
      if (input.prompt.includes("中立决策 Aggregator")) {
        controller.abort("SIGINT");
        return { stdout: "", exitCode: null, timedOut: false, aborted: true };
      }
      throw new Error("debate should not run");
    };
    const sink = makeSink();
    try {
      await runIdeate(["cancel during aggregate", "--debate-rounds", "0"], sink, {
        spawnImpl,
        abortController: controller,
      });
    } catch (error) {
      if (!(error instanceof IdeateExit)) throw error;
      expect(error.exitCode).toBe(130);
    }
    const out = sink.finished as { status: string; exitCode: number; failure?: { code: string } };
    expect(out.status).toBe("interrupted");
    expect(out.exitCode).toBe(130);
    expect(out.failure?.code).toBe("INTERRUPTED");
  });

  it("refuses aggregation when every proposal fails", async () => {
    seedRoster();
    const spawnImpl: SpawnImpl = async (input) => {
      if (input.prompt.includes(DRIVER_PROBE_PROMPT)) {
        return envelope(input.driverId ?? "", "ok");
      }
      if (input.prompt.includes("中立决策 Aggregator")) {
        throw new Error("aggregator must not spawn");
      }
      return { stdout: "", exitCode: 1, timedOut: false, aborted: false };
    };
    const sink = makeSink();
    try {
      await runIdeate(["zero proposal idea", "--debate-rounds", "1"], sink, { spawnImpl });
    } catch (error) {
      if (!(error instanceof IdeateExit)) throw error;
      expect(error.exitCode).toBe(4);
    }
    const out = sink.finished as { status: string; failure?: { code: string } };
    expect(out.status).toBe("failed");
    expect(out.failure?.code).toBe("NO_PROPOSALS");
  });

  it("marks an in-flight proposal running in status.json and leaves the rest queued", async () => {
    seedRoster();
    const fake = makeFakeTimers();
    let mid:
      | {
          runStatus: string;
          proposals: Array<{ attemptId: string; status: string; durationMs: number | null; lastActivity: string | null }>;
          aggregator: { status: string; durationMs: number | null };
        }
      | undefined;
    const spawnImpl: SpawnImpl = async (input) => {
      if (input.prompt.includes(DRIVER_PROBE_PROMPT)) return envelope(input.driverId ?? "", "ok");
      if (input.prompt.includes("独立提出产品方案")) {
        if (mid === undefined) {
          input.onActivity?.("reading idea brief");
          fake.advance(30_000);
          fake.fire();
          const runs = readdirSync(join(home, "runs"));
          const live = JSON.parse(readFileSync(join(home, "runs", runs[0], "status.json"), "utf8")) as {
            status: string;
            progress: {
              attempts: Array<{
                attemptId: string;
                status: string;
                durationMs: number | null;
                lastActivity: string | null;
              }>;
            };
          };
          mid = {
            runStatus: live.status,
            proposals: live.progress.attempts.filter((row) => row.attemptId.startsWith("proposal-")),
            aggregator: live.progress.attempts.find((row) => row.attemptId === "aggregate-final") ?? {
              status: "missing",
              durationMs: null,
            },
          };
        }
        return envelope(input.driverId ?? "", `proposal from ${input.cwd}`);
      }
      if (input.prompt.includes("中立决策 Aggregator")) {
        return envelope(input.driverId ?? "", decisionBody());
      }
      throw new Error("debate should not run");
    };
    const sink = makeSink();
    try {
      await runIdeate(["status heartbeat idea", "--debate-rounds", "0", "--concurrency", "1", "--json"], sink, {
        spawnImpl,
        timers: fake.timers,
        heartbeatIntervalMs: 30_000,
      });
    } catch (error) {
      if (!(error instanceof IdeateExit) || error.exitCode !== 0) throw error;
    }
    expect(mid).toBeDefined();
    expect(mid?.runStatus).toBe("running");
    expect(mid?.proposals.map((row) => row.status)).toEqual(["running", "queued"]);
    expect(mid?.proposals[0]).toMatchObject({
      durationMs: 30_000,
      lastActivity: "reading idea brief",
    });
    expect(mid?.proposals[1]).toMatchObject({
      durationMs: null,
      lastActivity: null,
    });
    expect(mid?.aggregator.status).toBe("pending");
    const out = sink.finished as { runId: string; status: string };
    const finalLive = JSON.parse(
      readFileSync(join(resolvePaths().runDir(out.runId), "status.json"), "utf8"),
    ) as {
      status: string;
      progress: { attempts: Array<{ attemptId: string; status: string; lastActivity: string | null }> };
    };
    expect(finalLive.status).toBe("completed");
    expect(finalLive.progress.attempts.filter((row) => row.attemptId.startsWith("proposal-")).map((row) => row.status)).toEqual([
      "success",
      "success",
    ]);
    expect(finalLive.progress.attempts.find((row) => row.attemptId === "aggregate-final")?.status).toBe("success");
    expect(fake.activeCount()).toBe(0);
  });
});

function makeFakeTimers(): {
  timers: RunnerTimers;
  advance: (ms: number) => void;
  fire: () => void;
  activeCount: () => number;
} {
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
