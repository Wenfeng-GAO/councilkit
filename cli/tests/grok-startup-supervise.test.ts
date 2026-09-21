import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { GROK_PROBE_TIMEOUT_MS, GROK_SESSION_WAIT_MS } from "../src/auto/driver-commands";
import { parseGrokSessionId, superviseOrchestrator } from "../src/auto/squadctl-bridge";

const SESSION_LINE = `${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "native-session-1",
})}\n`;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  children.length = 0;
});

function spawnNode(script: string): { child: ChildProcess; stdoutBuf: { text: string } } {
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const stdoutBuf = { text: "" };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf.text += chunk.toString("utf8");
  });
  return { child, stdoutBuf };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
}

function waitForSession(buf: { text: string }, sessionId: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (parseGrokSessionId(buf.text) === sessionId) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`session ${sessionId} did not arrive: ${buf.text}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("superviseOrchestrator grok startup", () => {
  it("keeps the production session wait aligned to GROK_PROBE_TIMEOUT_MS", () => {
    expect(GROK_SESSION_WAIT_MS).toBe(GROK_PROBE_TIMEOUT_MS);
    expect(GROK_SESSION_WAIT_MS).toBe(180_000);
    expect(GROK_SESSION_WAIT_MS).toBeGreaterThan(4_000);
  });

  it("accepts a real child that emits a native session after 4 seconds using the production budget", async () => {
    const started = Date.now();
    const { child, stdoutBuf } = spawnNode(`
      setTimeout(() => {
        process.stdout.write(${JSON.stringify(SESSION_LINE.replace("native-session-1", "late-session"))});
      }, 4500);
      setInterval(() => {}, 1000);
    `);
    const result = await superviseOrchestrator(child, GROK_SESSION_WAIT_MS, stdoutBuf);
    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: true, sessionId: "late-session" });
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(20_000);
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBeNull();
  }, 20_000);

  it("fails a timeout with an explicit short override instead of lowering the production default", async () => {
    expect(GROK_SESSION_WAIT_MS).toBe(180_000);
    const { child, stdoutBuf } = spawnNode("setInterval(() => {}, 1000)");
    const started = Date.now();
    const result = await superviseOrchestrator(child, 80, stdoutBuf);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected timeout");
    expect(result.reason).toBe("orchestrator produced no native session_id");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(GROK_SESSION_WAIT_MS).toBe(GROK_PROBE_TIMEOUT_MS);
  }, 8_000);

  it("returns an already-buffered stdout session without a ReferenceError", async () => {
    const { child, stdoutBuf } = spawnNode(`
      process.stdout.write(${JSON.stringify(SESSION_LINE)});
      setInterval(() => {}, 1000);
    `);
    await waitForSession(stdoutBuf, "native-session-1");
    const started = Date.now();
    const result = await superviseOrchestrator(child, GROK_SESSION_WAIT_MS, stdoutBuf);
    expect(result).toEqual({ ok: true, sessionId: "native-session-1" });
    expect(Date.now() - started).toBeLessThan(2000);
  }, 8_000);

  it("returns the exit result for an already-exited child without a ReferenceError", async () => {
    const { child, stdoutBuf } = spawnNode("process.exit(17)");
    const code = await waitForExit(child);
    expect(code).toBe(17);
    expect(child.exitCode).toBe(17);
    const started = Date.now();
    const result = await superviseOrchestrator(child, GROK_SESSION_WAIT_MS, stdoutBuf);
    expect(result).toEqual({
      ok: false,
      reason: "orchestrator exited before native session (17)",
      exitCode: 17,
    });
    expect(Date.now() - started).toBeLessThan(2000);
  }, 8_000);

  it("prefers a session already on stdout of an exited child", async () => {
    const { child, stdoutBuf } = spawnNode(`
      process.stdout.write(${JSON.stringify(SESSION_LINE)});
      process.exit(0);
    `);
    await waitForExit(child);
    await waitForSession(stdoutBuf, "native-session-1");
    const result = await superviseOrchestrator(child, GROK_SESSION_WAIT_MS, stdoutBuf);
    expect(result).toEqual({ ok: true, sessionId: "native-session-1" });
  }, 8_000);

  it("surfaces a spawn error without waiting the production deadline", async () => {
    const child = spawn("/no/such/councilkit-grok-missing-bin", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const started = Date.now();
    const result = await superviseOrchestrator(child, GROK_SESSION_WAIT_MS, { text: "" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected spawn error");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 8_000);
});
