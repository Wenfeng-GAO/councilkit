/**
 * #381: a line number 401 inside normal tool output must not become an auth
 * failure, and a real auth failure must still name the login command.
 */
import { describe, expect, it } from "vitest";
import type { AttemptSpec } from "../src/auto/driver-commands";
import { type SpawnImpl, spawnOnce } from "../src/auto/runner";
import { loginHintForDriver } from "../src/login-hint";

const DIFF = [
  "M\tsrc/auth.ts",
  "@@ -401,7 +401,7 @@ function check() {",
  " context",
  "- old",
  "+ new",
].join("\n");

const DRIVERS = [
  "claude-stream-json",
  "kimi-stream-json",
  "grok-stream-json",
  "cursor-stream-json",
  "codex-app-server",
] as const;

function attempt(driverId: string): AttemptSpec {
  return {
    attemptId: driverId,
    agentId: driverId,
    agentName: driverId,
    driverId,
    modelId: "m",
    executable: "fake",
    argv: [],
    prompt: "review",
    promptStdin: true,
    cwd: "/ws",
  };
}

function toolStdout(driverId: string): string {
  switch (driverId) {
    case "kimi-stream-json":
      return JSON.stringify({ role: "tool", content: DIFF });
    case "codex-app-server":
      return JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "git diff --name-status",
          aggregated_output: DIFF,
        },
      });
    default:
      return JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_result", content: DIFF }] },
      });
  }
}

function successStdout(driverId: string): string {
  const report = `approve\n\n${DIFF}`;
  switch (driverId) {
    case "kimi-stream-json":
      return [toolStdout(driverId), JSON.stringify({ role: "assistant", content: report })].join(
        "\n",
      );
    case "codex-app-server":
      return [
        toolStdout(driverId),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: report },
        }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n");
    default:
      return [
        toolStdout(driverId),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: report,
        }),
      ].join("\n");
  }
}

function spawn(stdout: string, stderr: string, exitCode: number): SpawnImpl {
  return async () => ({ stdout, stderr, exitCode, timedOut: false, aborted: false });
}

describe("auth heuristic per driver (#381)", () => {
  for (const driverId of DRIVERS) {
    it(`${driverId}: exit 0 and a final result containing 401 succeeds`, async () => {
      const result = await spawnOnce(attempt(driverId), {
        spawnImpl: spawn(successStdout(driverId), DIFF, 0),
      });
      expect(result.status).toBe("success");
      expect(result.failure).toBeUndefined();
      expect(result.output).toContain("approve");
      expect(result.output).toContain("@@ -401,7 +401,7 @@");
    });

    it(`${driverId}: exit 0 with a final result ignores an auth phrase on stderr`, async () => {
      const result = await spawnOnce(attempt(driverId), {
        spawnImpl: spawn(successStdout(driverId), `${DIFF}\nError: not logged in`, 0),
      });
      expect(result.status).toBe("success");
      expect(result.failure).toBeUndefined();
      expect(result.output).toContain("approve");
    });

    it(`${driverId}: a real auth failure names the login command and skips tool output`, async () => {
      const stderr = `${`${DIFF}\n`.repeat(20)}Error: not logged in`;
      const result = await spawnOnce(attempt(driverId), {
        spawnImpl: spawn(toolStdout(driverId), stderr, 1),
      });
      const hint = loginHintForDriver(driverId);
      expect(hint).toBeTruthy();
      expect(result.status).toBe("failure");
      expect(result.failure?.errorClass).toBe("auth");
      expect(result.failure?.message).toContain(hint);
      expect(result.failure?.message).not.toContain("src/auth.ts");
      expect(result.failure?.message).not.toContain("@@ -401");
      expect(result.failure?.message).not.toContain("git diff");
    });
  }

  it("classifies a structured 403 on every driver shape as auth", async () => {
    const stdout = JSON.stringify({
      type: "error",
      status: 403,
      message: "authentication failed",
    });
    for (const driverId of DRIVERS) {
      const result = await spawnOnce(attempt(driverId), {
        spawnImpl: spawn(stdout, DIFF, 1),
      });
      expect(result.status).toBe("failure");
      expect(result.failure?.errorClass).toBe("auth");
      expect(result.failure?.message).toContain(loginHintForDriver(driverId));
      expect(result.failure?.message).not.toContain("src/auth.ts");
    }
  });
});
