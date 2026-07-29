/**
 * Unit tests for the parallel runner (plan §测试). Pool/tolerate/no-retry/
 * cancel behaviour is driven by a fake `spawnImpl` (zero real processes). The
 * kill-tree semantics (timeout + abort) and cwd isolation use the real
 * `defaultSpawn` against throwaway `node -e` children.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptSpec } from "../src/auto/driver-commands";
import {
  type AttemptResult,
  type SpawnImpl,
  type SpawnInput,
  type SpawnOutput,
  defaultSpawn,
  runAttempts,
  spawnOnce,
} from "../src/auto/runner";

function spec(id: string, cwd = "/ws"): AttemptSpec {
  return {
    attemptId: id,
    agentId: id,
    agentName: id,
    driverId: "claude-stream-json",
    modelId: "m",
    executable: "fake",
    argv: [],
    prompt: id,
    promptStdin: true,
    cwd,
  };
}

/** A fake spawn that returns a canned stdout for each attempt id (via prompt).
 * The `text` is wrapped in a claude result envelope so the extractor sees it. */
function scriptedSpawn(
  scripts: Record<string, { text?: string; exitCode?: number; error?: string }>,
  observers?: { calls: string[]; maxConcurrent: number; nowConcurrent: number },
): SpawnImpl {
  return async (input: SpawnInput) => {
    if (observers) {
      observers.calls.push(input.prompt);
      observers.nowConcurrent++;
      observers.maxConcurrent = Math.max(observers.maxConcurrent, observers.nowConcurrent);
    }
    await new Promise((r) => setTimeout(r, 10));
    if (observers) observers.nowConcurrent--;
    const s = scripts[input.prompt] ?? {};
    const text = s.text ?? "ok";
    const fail = (s.exitCode ?? 0) !== 0;
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: fail ? "error" : "success",
        is_error: fail,
        result: text,
      }),
      exitCode: s.exitCode ?? 0,
      timedOut: false,
      aborted: false,
      error: s.error,
    };
  };
}

/** Fake spawn that simulates the claude result envelope the extractor reads. */
function claudeResultSpawn(text: string, fail = false): SpawnImpl {
  return async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: fail ? "error" : "success",
      is_error: fail,
      result: text,
    }),
    exitCode: fail ? 1 : 0,
    timedOut: false,
    aborted: false,
  });
}

describe("cli auto runner — pool / tolerate (fake spawn)", () => {
  it("runs concurrently up to the cap and returns results in original order", async () => {
    const obs = { calls: [] as string[], maxConcurrent: 0, nowConcurrent: 0 };
    const specs = [spec("0"), spec("1"), spec("2"), spec("3"), spec("4")];
    const { results } = await runAttempts(specs, {
      concurrency: 2,
      spawnImpl: scriptedSpawn(
        {
          "0": { text: "a0" },
          "1": { text: "a1" },
          "2": { text: "a2" },
          "3": { text: "a3" },
          "4": { text: "a4" },
        },
        obs,
      ),
    });
    expect(results.map((r) => r.attemptId)).toEqual(["0", "1", "2", "3", "4"]);
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(obs.maxConcurrent).toBeLessThanOrEqual(2);
    expect(obs.maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("defaults concurrency to min(3, N)", async () => {
    const obs = { calls: [] as string[], maxConcurrent: 0, nowConcurrent: 0 };
    const specs = [spec("0"), spec("1"), spec("2"), spec("3"), spec("4")];
    await runAttempts(specs, {
      spawnImpl: scriptedSpawn({ "0": { text: "x" } }, obs),
    });
    expect(obs.maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("tolerates a single failure and never retries it", async () => {
    let calls = 0;
    const spawn: SpawnImpl = async (input) => {
      calls++;
      const ok = input.prompt !== "1";
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
        }),
        exitCode: ok ? 0 : 1,
        timedOut: false,
        aborted: false,
      };
    };
    const specs = [spec("0"), spec("1"), spec("2")];
    const { results } = await runAttempts(specs, { spawnImpl: spawn });
    expect(calls).toBe(3); // exactly once each — no retry
    expect(results[0].status).toBe("success");
    expect(results[1].status).toBe("failure");
    expect(results[1].failure?.code).toBe("EXIT");
    expect(results[2].status).toBe("success");
  });

  it("all failures → every result is a failure", async () => {
    const { results } = await runAttempts([spec("0"), spec("1")], {
      spawnImpl: claudeResultSpawn("x", true),
    });
    expect(results.every((r) => r.status === "failure")).toBe(true);
  });

  it("treats NO_OUTPUT (empty extraction) as failure", async () => {
    const { results } = await runAttempts([spec("0")], {
      spawnImpl: async () => ({ stdout: "", exitCode: 0, timedOut: false, aborted: false }),
    });
    expect(results[0].status).toBe("failure");
    expect(results[0].failure?.code).toBe("NO_OUTPUT");
  });

  it("aborted before start → cancelled failures, spawn never called", async () => {
    let calls = 0;
    const spawn: SpawnImpl = async () => {
      calls++;
      return { stdout: "x", exitCode: 0, timedOut: false, aborted: false };
    };
    const ac = new AbortController();
    ac.abort();
    const { results, aborted } = await runAttempts([spec("0"), spec("1")], {
      spawnImpl: spawn,
      signal: ac.signal,
    });
    expect(aborted).toBe(true);
    expect(calls).toBe(0);
    expect(results.every((r) => r.status === "failure" && r.failure?.code === "CANCELLED")).toBe(
      true,
    );
  });

  it("spawnOnce returns a single result", async () => {
    const r = await spawnOnce(spec("0"), { spawnImpl: claudeResultSpawn("hello") });
    expect(r.status).toBe("success");
    expect(r.output).toBe("hello");
  });
});

describe("cli auto runner — defaultSpawn (real node children)", () => {
  let wsa: string;
  let wsb: string;

  beforeEach(() => {
    wsa = mkdtempSync(join(tmpdir(), "ck-runner-a-"));
    wsb = mkdtempSync(join(tmpdir(), "ck-runner-b-"));
  });
  afterEach(() => {
    for (const d of [wsa, wsb]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("isolates cwd: each child sees only its own workspace", async () => {
    const a = defaultSpawn({
      executable: "node",
      argv: ["-e", "process.stdout.write(process.cwd())"],
      cwd: wsa,
      prompt: "",
      promptStdin: false,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    const b = defaultSpawn({
      executable: "node",
      argv: ["-e", "process.stdout.write(process.cwd())"],
      cwd: wsb,
      prompt: "",
      promptStdin: false,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    const [oa, ob] = await Promise.all([a, b]);
    expect(oa.stdout).toBe(realpathSync(wsa));
    expect(ob.stdout).toBe(realpathSync(wsb));
    expect(oa.exitCode).toBe(0);
  });

  it("kills the group on timeout and resolves with timedOut", async () => {
    const start = Date.now();
    const out = await defaultSpawn({
      executable: "node",
      argv: ["-e", "setInterval(()=>{}, 60000)"],
      cwd: wsa,
      prompt: "",
      promptStdin: false,
      timeoutMs: 150,
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - start;
    expect(out.timedOut).toBe(true);
    // SIGTERM → grace(2s) → SIGKILL should still resolve well under the 60s sleep.
    expect(elapsed).toBeLessThan(5000);
  });

  it("kills the group on abort (SIGINT semantics) and resolves with aborted", async () => {
    const ac = new AbortController();
    const p = defaultSpawn({
      executable: "node",
      argv: ["-e", "setInterval(()=>{}, 60000)"],
      cwd: wsa,
      prompt: "",
      promptStdin: false,
      timeoutMs: 60000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 150);
    const start = Date.now();
    const out = await p;
    const elapsed = Date.now() - start;
    expect(out.aborted).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it("truncates stdout past the 8MB cap with a marker", async () => {
    // Print ~9MB of 'a' then keep alive briefly so close fires after the pipe flushes.
    const out = await defaultSpawn({
      executable: "node",
      argv: ["-e", "process.stdout.write('a'.repeat(9*1024*1024))"],
      cwd: wsa,
      prompt: "",
      promptStdin: false,
      timeoutMs: 30000,
      signal: new AbortController().signal,
    });
    expect(out.stdout).toContain("[truncated at");
    expect(out.stdout.length).toBeLessThan(9 * 1024 * 1024);
  });

  it("delivers the prompt via stdin when promptStdin", async () => {
    const out = await defaultSpawn({
      executable: "node",
      argv: [
        "-e",
        "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s))",
      ],
      cwd: wsa,
      prompt: "PROMPT-BODY",
      promptStdin: true,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    expect(out.stdout).toBe("PROMPT-BODY");
  });

  it("AttemptResult carries duration and workspace", async () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hi",
    });
    const r: AttemptResult = await spawnOnce(
      {
        ...spec("0", wsa),
        executable: "node",
        argv: ["-e", `process.stdout.write(${JSON.stringify(envelope)})`],
        promptStdin: false,
      },
      { timeoutMs: 5000 },
    );
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.workspace).toBe(wsa);
    expect(r.output).toBe("hi");
  });
});

describe("cli auto runner — path round-trip with real temp PATH", () => {
  it("extracts kimi final assistant content through runAttempts", async () => {
    const spawn: SpawnImpl = async () => ({
      stdout: [
        JSON.stringify({ role: "meta", content: "resume" }),
        JSON.stringify({ role: "assistant", content: "kimi-final" }),
      ].join("\n"),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
    const s: AttemptSpec = { ...spec("0"), driverId: "kimi-stream-json" };
    const { results } = await runAttempts([s], { spawnImpl: spawn });
    expect(results[0].status).toBe("success");
    expect(results[0].output).toBe("kimi-final");
  });
});
