/**
 * Unit tests for the parallel runner (plan §测试). Pool/tolerate/no-retry/
 * cancel behaviour is driven by a fake `spawnImpl` (zero real processes). The
 * kill-tree semantics (timeout + abort), stdout/stderr capping (head+tail), cwd
 * isolation and stdin delivery exercise `defaultSpawn` against an injected fake
 * ChildProcess (EventEmitter + PassThrough) — never a real subprocess.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptSpec } from "../src/auto/driver-commands";
import type { RawLiveEvent } from "../src/auto/live-events";
import {
  type AttemptResult,
  type RunnerTimers,
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

  it("tolerates a single EXIT failure, retrying it once (transient <120s, non-zero)", async () => {
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
    // "1" exits non-zero under 120s → retried once (4 total spawns); the retry
    // also fails, so the result stays a failure and there is no third try.
    expect(calls).toBe(4);
    expect(results[0].status).toBe("success");
    expect(results[1].status).toBe("failure");
    expect(results[1].failure?.code).toBe("EXIT");
    // The final result carries the retry chain (attemptNumber 2, retryOf 1).
    expect(results[1].attemptNumber).toBe(2);
    expect(results[1].retryOf).toBe(1);
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

  it("codex probe: protocol-only JSONL (thread.started/turn.completed, no agent_message) is NO_OUTPUT", async () => {
    // Reviewer finding: a codex --json event stream without an agent_message
    // must judge the probe/attempt FAILED — the stream itself is not output.
    const codexSpec: AttemptSpec = {
      ...spec("probe-codex"),
      driverId: "codex-app-server",
      lastMessageFile: "/missing/last-message.md",
    };
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "ls" },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");
    const r = await spawnOnce(codexSpec, {
      spawnImpl: async () => ({ stdout, exitCode: 0, timedOut: false, aborted: false }),
    });
    expect(r.status).toBe("failure");
    expect(r.failure?.code).toBe("NO_OUTPUT");
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

describe("cli auto runner — transient EXIT retry (fake spawn, step clock)", () => {
  /** A clock that returns the next step value on each `now()` call, then the
   * last value forever — so `durationMs` for an execution is
   * `steps[1] - steps[0]` (and 0 for any subsequent execution). */
  function stepClock(steps: number[]): RunnerTimers {
    let i = 0;
    const intervals = new Map<number, () => void>();
    let nextId = 1;
    return {
      now: () => (i < steps.length ? steps[i++] : steps[steps.length - 1]),
      setInterval: (cb: () => void) => {
        const id = nextId++;
        intervals.set(id, cb);
        return id;
      },
      clearInterval: (handle: unknown) => intervals.delete(handle as number),
    };
  }

  /** A spawn that always fails with a non-zero EXIT (claude error envelope). */
  function exitFailSpawn(): { spawn: SpawnImpl; calls: () => number } {
    let calls = 0;
    const spawn: SpawnImpl = async () => {
      calls++;
      return {
        stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "" }),
        exitCode: 1,
        timedOut: false,
        aborted: false,
      };
    };
    return { spawn, calls: () => calls };
  }

  it("retries once when an EXIT failure takes <120s, fires two callbacks with retryOf", async () => {
    const { spawn, calls } = exitFailSpawn();
    const finishes: AttemptResult[] = [];
    const { results } = await runAttempts([spec("0")], {
      spawnImpl: spawn,
      timers: stepClock([0, 119_999]),
      onAttemptFinish: (r) => finishes.push(r),
    });
    expect(calls()).toBe(2); // first try + one retry, no third
    expect(results[0].status).toBe("failure");
    expect(results[0].attemptNumber).toBe(2);
    expect(results[0].retryOf).toBe(1);
    expect(finishes).toHaveLength(2);
    expect(finishes[0].attemptNumber).toBe(1);
    expect(finishes[0].retryOf).toBeUndefined();
    expect(finishes[1].attemptNumber).toBe(2);
    expect(finishes[1].retryOf).toBe(1);
  });

  it("does NOT retry when the EXIT failure takes exactly 120000ms (boundary)", async () => {
    const { spawn, calls } = exitFailSpawn();
    const { results } = await runAttempts([spec("0")], {
      spawnImpl: spawn,
      timers: stepClock([0, 120_000]),
    });
    expect(calls()).toBe(1);
    expect(results[0].attemptNumber).toBe(1);
    expect(results[0].retryOf).toBeUndefined();
  });

  it("does NOT retry a TIMEOUT failure", async () => {
    let calls = 0;
    const spawn: SpawnImpl = async () => {
      calls++;
      return { stdout: "", exitCode: null, timedOut: true, aborted: false };
    };
    const { results } = await runAttempts([spec("0")], {
      spawnImpl: spawn,
      timers: stepClock([0, 60_000]),
    });
    expect(calls).toBe(1);
    expect(results[0].failure?.code).toBe("TIMEOUT");
    expect(results[0].retryOf).toBeUndefined();
  });

  it("does NOT retry a NO_OUTPUT failure (exit 0, empty)", async () => {
    let calls = 0;
    const spawn: SpawnImpl = async () => {
      calls++;
      return { stdout: "", exitCode: 0, timedOut: false, aborted: false };
    };
    const { results } = await runAttempts([spec("0")], {
      spawnImpl: spawn,
      timers: stepClock([0, 5_000]),
    });
    expect(calls).toBe(1);
    expect(results[0].failure?.code).toBe("NO_OUTPUT");
    expect(results[0].retryOf).toBeUndefined();
  });

  it("does NOT retry once the run has aborted (signal aborts after the first try)", async () => {
    const ac = new AbortController();
    const { spawn, calls } = exitFailSpawn();
    const { results } = await runAttempts([spec("0")], {
      spawnImpl: spawn,
      signal: ac.signal,
      timers: stepClock([0, 5_000]),
      onAttemptFinish: (r) => {
        if (r.attemptNumber === 1) ac.abort();
      },
    });
    expect(calls()).toBe(1);
    expect(results[0].retryOf).toBeUndefined();
  });

  it("rebuilds the workspace before the retry spawn (no leftover .last-message.md)", async () => {
    // Reviewer finding: the retry reused the first try's dirty cwd, so a codex
    // leftover `.last-message.md` could be read as the second try's deliverable
    // even when it produced no new output. The `rebuildWorkspaceBeforeRetry`
    // hook must fire between the failed first spawn and the retry, handing the
    // retry a pristine EMPTY workspace.
    const ws = mkdtempSync(join(tmpdir(), "ck-runner-retry-"));
    try {
      // Seed a stale codex last-message file from the failed first attempt.
      writeFileSync(join(ws, ".last-message.md"), "STALE-FIRST-ATTEMPT");
      let calls = 0;
      const seenContents: string[] = [];
      const spawn: SpawnImpl = async (input) => {
        calls++;
        seenContents.push(readdirSync(input.cwd).sort().join(",") || "(empty)");
        const fail = calls === 1; // first try: non-zero EXIT under 120s → retry
        return {
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
          }),
          exitCode: fail ? 1 : 0,
          timedOut: false,
          aborted: false,
        };
      };
      let rebuildCalls = 0;
      const rebuiltCwds: string[] = [];
      const { results } = await runAttempts([spec("0", ws)], {
        spawnImpl: spawn,
        timers: stepClock([0, 5_000]),
        rebuildWorkspaceBeforeRetry: (s) => {
          rebuildCalls++;
          rebuiltCwds.push(s.cwd);
          // Simulate the fs-safe delete-then-recreate: empty the dir before the
          // retry spawn lands in it.
          rmSync(s.cwd, { recursive: true, force: true });
          mkdirSync(s.cwd, { recursive: true });
        },
      });
      expect(calls).toBe(2);
      expect(rebuildCalls).toBe(1);
      expect(rebuiltCwds).toEqual([ws]);
      // The first spawn saw the stale residue in its cwd.
      expect(seenContents[0]).toContain(".last-message.md");
      // The retry spawn saw an EMPTY workspace (rebuilt before the retry).
      expect(seenContents[1]).toBe("(empty)");
      expect(results[0].status).toBe("success");
      // The stale file did not survive into the retry.
      expect(existsSync(join(ws, ".last-message.md"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("does NOT call rebuildWorkspaceBeforeRetry when no retry happens (success first try)", async () => {
    let rebuildCalls = 0;
    const spawn: SpawnImpl = async () => ({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    });
    await runAttempts([spec("0")], {
      spawnImpl: spawn,
      timers: stepClock([0, 5_000]),
      rebuildWorkspaceBeforeRetry: () => {
        rebuildCalls++;
      },
    });
    expect(rebuildCalls).toBe(0);
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

  it("skips the SIGKILL upgrade when SIGTERM reports ESRCH (group already gone)", async () => {
    const child = new FakeChild();
    const kills: Array<{ target: number; signal: string }> = [];
    const killFn = (target: number, signal: NodeJS.Signals): void => {
      kills.push({ target, signal: String(signal) });
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
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
    // No 2s grace wait and no SIGKILL to a possibly-reused PGID.
    expect(elapsed).toBeLessThan(1500);
    expect(kills).toEqual([{ target: -child.pid, signal: "SIGTERM" }]);
  });

  it("redacts secrets and strips control chars in the EXIT failure stderr tail", async () => {
    const spawnImpl: SpawnImpl = async () => ({
      stdout: "",
      stderr:
        "boom \u0007\u001b[31m councilkit_session=secret-token-xyz \u001b[0m \u001b]8;;http://evil.example\u0007hyperlink",
      exitCode: 1,
      timedOut: false,
      aborted: false,
    });
    const { results } = await runAttempts([spec("redact")], { spawnImpl });
    const message = results[0]?.failure?.message ?? "";
    expect(results[0]?.failure?.code).toBe("EXIT");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("secret-token-xyz");
    // No ANSI escape introducer or C0 control chars survive into the message.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are stripped
    expect(message).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1b\x7f]/);
    expect(message).not.toContain("evil.example");
    expect(message).not.toContain("hyperlink");
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

describe("cli auto runner — process-group cleanup on natural close", () => {
  it("best-effort TERMs the detached group when the leader closes naturally", async () => {
    const child = new FakeChild();
    child.echoStdinThenClose();
    const kills: Array<{ target: number; signal: string }> = [];
    const killFn = (target: number, signal: NodeJS.Signals): void => {
      kills.push({ target, signal: String(signal) });
    };
    const start = Date.now();
    const out = await defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: "/tmp/ck-fake-ws",
        prompt: "hi",
        promptStdin: true,
        timeoutMs: 60000,
        signal: NEVER_ABORT,
      },
      fakeSpawnFn(child),
      killFn,
    );
    const elapsed = Date.now() - start;
    expect(out.exitCode).toBe(0);
    // TERM→grace→KILL is awaited before resolving (retry isolation).
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(kills).toEqual([
      { target: -child.pid, signal: "SIGTERM" },
      { target: -child.pid, signal: "SIGKILL" },
    ]);
  });
});

describe("cli auto runner — onLiveEvent wiring", () => {
  it("forwards fake spawnImpl live events with the attemptId", async () => {
    const seen: Array<{ id: string; events: RawLiveEvent[] }> = [];
    const spawn: SpawnImpl = async (input) => {
      input.onLiveEvent?.([{ type: "text.delta", text: "hi" }]);
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
        }),
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    };
    await runAttempts([spec("attempt-0")], {
      spawnImpl: spawn,
      onLiveEvent: (id, events) => seen.push({ id, events }),
    });
    expect(seen).toEqual([{ id: "attempt-0", events: [{ type: "text.delta", text: "hi" }] }]);
  });

  it("defaultSpawn feeds LiveEventCollector from stdout chunks", async () => {
    const child = new FakeChild();
    child.emitSpawn();
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "chunk" } },
    });
    setImmediate(() => {
      child.stdout.write(`${line}\n`);
      child.stdout.end();
      setImmediate(() => child.emit("close", 0));
    });
    const seen: RawLiveEvent[][] = [];
    await defaultSpawn(
      {
        executable: "x",
        argv: [],
        cwd: "/tmp",
        prompt: "",
        promptStdin: false,
        timeoutMs: 5000,
        signal: NEVER_ABORT,
        driverId: "claude-stream-json",
        onLiveEvent: (events) => seen.push(events),
      },
      fakeSpawnFn(child),
    );
    expect(seen.flat()).toEqual([{ type: "text.delta", text: "chunk" }]);
  });
});

describe("cli auto runner — fast SPAWN_ERROR is NOT retried (frozen brief)", () => {
  it("does not retry a stream-error failure (retry is EXIT-only per the brief)", async () => {
    let calls = 0;
    const spawnImpl: SpawnImpl = async () => {
      calls++;
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        aborted: false,
        error: "EPIPE",
      };
    };
    const { results } = await runAttempts([spec("no-retry-spawn")], { spawnImpl });
    expect(calls).toBe(1);
    expect(results[0]?.status).toBe("failure");
    expect(results[0]?.failure?.code).toBe("SPAWN_ERROR");
  });
});
