/**
 * Unit tests for the parallel runner (plan §测试). Pool/tolerate/no-retry/
 * cancel behaviour is driven by a fake `spawnImpl` (zero real processes). The
 * kill-tree semantics (timeout + abort), stdout/stderr capping (head+tail), cwd
 * isolation and stdin delivery exercise `defaultSpawn` against an injected fake
 * ChildProcess (EventEmitter + PassThrough) — never a real subprocess.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptSpec } from "../src/auto/driver-commands";
import {
  type AttemptResult,
  type SpawnImpl,
  type SpawnInput,
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

  it("EXIT failure carries the collected stderr tail in the failure message", async () => {
    const spawn: SpawnImpl = async () => ({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "x",
      }),
      stderr: "Error: boom at foo:1\n  at bar:2\n",
      exitCode: 1,
      timedOut: false,
      aborted: false,
    });
    const r = await spawnOnce(spec("0"), { spawnImpl: spawn });
    expect(r.status).toBe("failure");
    expect(r.failure?.code).toBe("EXIT");
    expect(r.failure?.message).toContain("non-zero exit 1");
    expect(r.failure?.message).toContain("boom");
  });

  it("EXIT failure trims the stderr tail to the last ≤2KB", async () => {
    const big = "E!".repeat(4000); // 8KB
    const spawn: SpawnImpl = async () => ({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x" }),
      stderr: big,
      exitCode: 2,
      timedOut: false,
      aborted: false,
    });
    const r = await spawnOnce(spec("0"), { spawnImpl: spawn });
    expect(r.failure?.code).toBe("EXIT");
    // 2KB tail + the "…" marker; far smaller than the full 8KB.
    expect(r.failure?.message.length).toBeLessThan(big.length);
    expect(r.failure?.message).toContain("…");
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

  it("onAttemptFinish throwing aborts in-flight attempts and propagates the error", async () => {
    let abortedSeen = false;
    const spawn: SpawnImpl = async (input) => {
      input.signal.addEventListener("abort", () => {
        abortedSeen = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      return claudeResultSpawn("ok")(input);
    };
    let finishedCalls = 0;
    await expect(
      runAttempts([spec("0"), spec("1")], {
        concurrency: 1,
        spawnImpl: spawn,
        onAttemptFinish: () => {
          finishedCalls++;
          if (finishedCalls === 1) throw new Error("transcript IO failed");
        },
      }),
    ).rejects.toThrow("transcript IO failed");
    // The internal abort fired, killing the in-flight spawn (no orphan).
    expect(abortedSeen).toBe(true);
  });
});

/** A fake ChildProcess for driving `defaultSpawn` with zero real subprocesses.
 * It exposes PassThrough pipes and emits `spawn`/`close`. A kill (stdin
 * `destroy()`, as opposed to a clean `end()`) is what makes it emit `close`,
 * mirroring a real child dying on SIGTERM. */
class FakeChild extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();

  constructor(pid = 999_977) {
    super();
    this.pid = pid;
    this.stdin.on("close", () => {
      // `destroy()` (kill) sets destroyed=true; a clean `end()` does not.
      if (this.stdin.destroyed) setImmediate(() => this.emit("close", null));
    });
  }

  emitSpawn(): void {
    setImmediate(() => this.emit("spawn"));
  }

  /** Echo collected stdin back on stdout, then close (exit 0) — for stdin tests. */
  echoStdinThenClose(): void {
    let data = "";
    this.stdin.on("data", (d) => {
      data += d.toString("utf8");
    });
    this.stdin.on("end", () => {
      this.stdout.write(data);
      this.stdout.end();
      setImmediate(() => this.emit("close", 0));
    });
  }
}

function fakeSpawnFn(child: FakeChild): typeof import("node:child_process").spawn {
  return (() => {
    child.emitSpawn();
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

function asSpawn(
  fn: (exe: string, argv: string[], opts: { cwd?: string }) => FakeChild,
): typeof import("node:child_process").spawn {
  return fn as unknown as typeof import("node:child_process").spawn;
}

const NEVER_ABORT = new AbortController().signal;

describe("cli auto runner — defaultSpawn (fake ChildProcess, zero real processes)", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "ck-runner-fake-"));
  });
  afterEach(() => {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("forwards the isolated cwd to spawn (each child sees its own workspace)", async () => {
    const seen: string[] = [];
    const spawnFn = asSpawn((_exe, _argv, opts) => {
      seen.push(opts.cwd ?? "");
      const c = new FakeChild();
      c.emitSpawn();
      setImmediate(() => c.emit("close", 0));
      return c;
    });
    const oa = await defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: ws,
        prompt: "",
        promptStdin: false,
        timeoutMs: 5000,
        signal: NEVER_ABORT,
      },
      spawnFn,
    );
    expect(oa.exitCode).toBe(0);
    expect(seen).toEqual([ws]);
  });

  it("kills the group on timeout: SIGTERM then SIGKILL to -pid, then resolves timedOut", async () => {
    const child = new FakeChild();
    const kills: Array<{ target: number; signal: string }> = [];
    const killFn = (target: number, signal: NodeJS.Signals): void => {
      kills.push({ target, signal: String(signal) });
    };
    const start = Date.now();
    const out = await defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: ws,
        prompt: "",
        promptStdin: false,
        timeoutMs: 50,
        signal: NEVER_ABORT,
      },
      fakeSpawnFn(child),
      killFn,
    );
    const elapsed = Date.now() - start;
    expect(out.timedOut).toBe(true);
    // The SIGKILL upgrade window was awaited before resolving (fire-and-forget
    // would have let process.exit cancel the 2s timer).
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(5000);
    // Both signals reached the whole process group (negative pid), in order,
    // without ever calling the real process.kill.
    expect(kills).toEqual([
      { target: -child.pid, signal: "SIGTERM" },
      { target: -child.pid, signal: "SIGKILL" },
    ]);
  });

  it("kills the group on abort (SIGINT): SIGTERM then SIGKILL to -pid, resolves aborted", async () => {
    const ac = new AbortController();
    const child = new FakeChild();
    const kills: Array<{ target: number; signal: string }> = [];
    const killFn = (target: number, signal: NodeJS.Signals): void => {
      kills.push({ target, signal: String(signal) });
    };
    const p = defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: ws,
        prompt: "",
        promptStdin: false,
        timeoutMs: 60000,
        signal: ac.signal,
      },
      fakeSpawnFn(child),
      killFn,
    );
    setTimeout(() => ac.abort(), 30);
    const start = Date.now();
    const out = await p;
    const elapsed = Date.now() - start;
    expect(out.aborted).toBe(true);
    expect(elapsed).toBeLessThan(5000);
    expect(kills).toEqual([
      { target: -child.pid, signal: "SIGTERM" },
      { target: -child.pid, signal: "SIGKILL" },
    ]);
  });

  it("truncates stdout past the 8MB cap keeping head + tail with a marker", async () => {
    const child = new FakeChild();
    child.emitSpawn();
    setImmediate(() => {
      child.stdout.write(Buffer.alloc(9 * 1024 * 1024, 0x61)); // 9MB of 'a'
      child.stdout.end();
      setImmediate(() => child.emit("close", 0));
    });
    const out = await defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: ws,
        prompt: "",
        promptStdin: false,
        timeoutMs: 30000,
        signal: NEVER_ABORT,
      },
      fakeSpawnFn(child),
    );
    expect(out.stdout).toContain("[truncated ");
    expect(out.stdout).toContain(" bytes]");
    // The tail (last bytes) is retained, so the marker is in the middle.
    expect(out.stdout.endsWith("a")).toBe(true);
    expect(out.stdout.length).toBeLessThan(9 * 1024 * 1024);
  });

  it("drains stderr into a capped field (never leaves the pipe unread)", async () => {
    const child = new FakeChild();
    child.emitSpawn();
    const err = "E!".repeat(40);
    setImmediate(() => {
      child.stderr.write(err);
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    const out = await defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: ws,
        prompt: "",
        promptStdin: false,
        timeoutMs: 5000,
        signal: NEVER_ABORT,
      },
      fakeSpawnFn(child),
    );
    expect(out.stderr).toContain("E!");
  });

  it("a stream error kills the process group (SIGTERM→SIGKILL) before settling", async () => {
    const child = new FakeChild();
    const kills: Array<{ target: number; signal: string }> = [];
    const killFn = (target: number, signal: NodeJS.Signals): void => {
      kills.push({ target, signal: String(signal) });
    };
    const p = defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: ws,
        prompt: "",
        promptStdin: false,
        timeoutMs: 60000,
        signal: NEVER_ABORT,
      },
      fakeSpawnFn(child),
      killFn,
    );
    // Emit a stream error on stdout while the child is still "running" (no
    // close yet) — the pipe is gone but the process group must be killed.
    setImmediate(() => child.stdout.emit("error", new Error("read ECONNRESET")));
    const start = Date.now();
    const out = await p;
    const elapsed = Date.now() - start;
    expect(out.error).toContain("ECONNRESET");
    expect(out.timedOut).toBe(false);
    expect(out.aborted).toBe(false);
    // The TERM→grace→KILL upgrade window was awaited before resolving so the
    // group is actually signaled (orphan prevention), not left running.
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(5000);
    expect(kills).toEqual([
      { target: -child.pid, signal: "SIGTERM" },
      { target: -child.pid, signal: "SIGKILL" },
    ]);
  });

  it("captures an oversized final-event line whole despite the stdout head+tail cap", async () => {
    const child = new FakeChild();
    child.emitSpawn();
    // A single claude result line (~5MB) preceded by ~4.8MB of junk pushes total
    // stdout past the 8MB cap, so head+tail splits the event line and neither
    // half is valid JSON. The streaming collector must capture the event whole.
    const resultText = "x".repeat(5 * 1024 * 1024);
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: resultText,
    });
    const prefix = "junk-prefix-line\n".repeat(280 * 1024); // ~4.8MB
    setImmediate(() => {
      child.stdout.write(prefix);
      child.stdout.write(envelope);
      child.stdout.write("\n");
      child.stdout.end();
      setImmediate(() => child.emit("close", 0));
    });
    const out = await defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: ws,
        prompt: "",
        promptStdin: false,
        timeoutMs: 30000,
        signal: NEVER_ABORT,
        driverId: "claude-stream-json",
      },
      fakeSpawnFn(child),
    );
    // The head+tail stdout is truncated and the event line is destroyed there.
    expect(out.stdout).toContain("[truncated ");
    // ...but the streaming-captured line survived, so the extractor recovers it
    // (no spurious NO_OUTPUT).
    expect(out.finalEventLine).not.toBeNull();
    const r: AttemptResult = await spawnOnce(
      { ...spec("0", ws), driverId: "claude-stream-json" },
      {
        spawnImpl: async () => ({
          stdout: out.stdout,
          finalEventLine: out.finalEventLine,
          exitCode: 0,
          timedOut: false,
          aborted: false,
        }),
      },
    );
    expect(r.status).toBe("success");
    expect(r.output).toBe(resultText);
  });

  it("delivers the prompt via stdin when promptStdin", async () => {
    const child = new FakeChild();
    child.emitSpawn();
    child.echoStdinThenClose();
    const out = await defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: ws,
        prompt: "PROMPT-BODY",
        promptStdin: true,
        timeoutMs: 5000,
        signal: NEVER_ABORT,
      },
      fakeSpawnFn(child),
    );
    expect(out.stdout).toBe("PROMPT-BODY");
  });

  it("AttemptResult carries duration and workspace (extraction through spawnOnce)", async () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hi",
    });
    const r: AttemptResult = await spawnOnce(spec("0", ws), {
      spawnImpl: async () => ({ stdout: envelope, exitCode: 0, timedOut: false, aborted: false }),
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.workspace).toBe(ws);
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
