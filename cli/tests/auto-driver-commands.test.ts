/**
 * Unit tests for driver-commands (plan §测试). No real subprocesses: argv
 * construction is checked structurally, output extraction against canned
 * stream-json fixtures, executable resolution against a temp PATH dir.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AttemptSpec,
  DRIVER_PROBE_PROMPT,
  DriverActivityCollector,
  FinalEventLineCollector,
  buildProbeSpec,
  buildSpawnSpec,
  extractFinalOutput,
  resolveExecutable,
  stripProxyPrefix,
} from "../src/auto/driver-commands";
import type { CliError } from "../src/errors";
import type { AgentRecord } from "../src/store/schemas";

function agent(driverSelection: AgentRecord["driverSelection"], modelId = "model-x"): AgentRecord {
  return {
    id: "a-1",
    name: "A",
    personaPrompt: "persona",
    modelId,
    color: "#aabbcc",
    enabled: true,
    driverSelection,
  };
}

const CLAUDE_CFUSE = {
  driverId: "claude-stream-json" as const,
  options: { route: "cfuse" as const },
};
const KIMI = { driverId: "kimi-stream-json" as const, options: {} };
const CODEX = { driverId: "codex-app-server" as const, options: {} };

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected an error");
}

describe("cli auto driver-commands", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "councilkit-dc-"));
    // Put a fake `cld`, `kimi`, `codex` on a temp PATH.
    for (const name of ["cld", "kimi", "codex"]) {
      const p = join(tmp, name);
      writeFileSync(p, "#!/bin/sh\necho hi\n");
      chmodSync(p, 0o755);
    }
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // sandboxed FS cleanup
    }
  });

  const env = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, PATH: dir });

  describe("resolveExecutable", () => {
    it("finds a bare name on PATH and returns its absolute path", () => {
      const exe = resolveExecutable("cld", env(tmp));
      expect(exe).toBe(join(tmp, "cld"));
    });

    it("throws a usage error when the executable is missing", () => {
      const err = captureError(() => resolveExecutable("nope-nope", env(tmp)));
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain("nope-nope");
    });

    it("resolves an absolute path directly", () => {
      const abs = join(tmp, "cld");
      expect(resolveExecutable(abs, env(tmp))).toBe(abs);
    });

    it("treats an empty PATH entry as the current directory (POSIX)", () => {
      const dir = mkdtempSync(join(tmpdir(), "councilkit-dc-cwd-"));
      try {
        const p = join(dir, "cld");
        writeFileSync(p, "#!/bin/sh\necho hi\n");
        chmodSync(p, 0o755);
        const oldCwd = process.cwd();
        try {
          process.chdir(dir);
          const exe = resolveExecutable("cld", { PATH: "" });
          expect(exe).toBe(realpathSync(join(dir, "cld")));
        } finally {
          process.chdir(oldCwd);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("absolutizes a relative PATH entry rather than returning a relative path", () => {
      const dir = mkdtempSync(join(tmpdir(), "councilkit-dc-rel-"));
      try {
        mkdirSync(join(dir, "bin"));
        const p = join(dir, "bin", "cld");
        writeFileSync(p, "#!/bin/sh\necho hi\n");
        chmodSync(p, 0o755);
        const oldCwd = process.cwd();
        try {
          process.chdir(dir);
          const exe = resolveExecutable("cld", { PATH: "bin" });
          expect(exe).toBe(realpathSync(join(dir, "bin", "cld")));
          expect(exe.startsWith("/")).toBe(true);
        } finally {
          process.chdir(oldCwd);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("buildSpawnSpec argv", () => {
    it("claude cfuse: prompt via stdin, fixed flags, no model", () => {
      const spec = buildSpawnSpec(agent(CLAUDE_CFUSE), {
        attemptId: "attempt-0",
        workspace: "/ws",
        prompt: "do it",
        env: env(tmp),
      });
      expect(spec.promptStdin).toBe(true);
      expect(spec.argv).toEqual([
        "cfuse",
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ]);
      expect(spec.executable).toBe(join(tmp, "cld"));
    });

    it("kimi: prompt embedded in argv via -p, no --auto/-y", () => {
      const spec = buildSpawnSpec(agent(KIMI, "kimi-code/k3"), {
        attemptId: "attempt-0",
        workspace: "/ws",
        prompt: "review this",
        env: env(tmp),
      }) as AttemptSpec;
      expect(spec.promptStdin).toBe(false);
      expect(spec.argv).toEqual([
        "-m",
        "kimi-code/k3",
        "-p",
        "review this",
        "--output-format",
        "stream-json",
      ]);
      expect(spec.argv.some((a) => a === "--auto" || a === "-y")).toBe(false);
      expect(spec.executable).toBe(join(tmp, "kimi"));
    });

    it("codex: stdin prompt, last-message file under workspace, skip-git-repo-check, --json", () => {
      const spec = buildSpawnSpec(agent(CODEX, "gpt-5"), {
        attemptId: "attempt-0",
        workspace: "/ws",
        prompt: "review",
        env: env(tmp),
      }) as AttemptSpec;
      expect(spec.promptStdin).toBe(true);
      expect(spec.lastMessageFile).toBe(join("/ws", ".last-message.md"));
      expect(spec.argv).toEqual([
        "exec",
        "-s",
        "workspace-write",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--json",
        "-m",
        "gpt-5",
        "-o",
        join("/ws", ".last-message.md"),
        "-",
      ]);
    });

    it("claude non-cfuse route → usage error before spawn", () => {
      const badRoute = {
        driverId: "claude-stream-json" as const,
        options: { route: "moonshot" as const },
      };
      const err = captureError(() =>
        buildSpawnSpec(agent(badRoute), {
          attemptId: "attempt-0",
          workspace: "/ws",
          prompt: "x",
          env: env(tmp),
        }),
      );
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain("cfuse");
    });

    it("missing executable → usage error before spawn", () => {
      const err = captureError(() =>
        buildSpawnSpec(agent(KIMI), {
          attemptId: "attempt-0",
          workspace: "/ws",
          prompt: "x",
          env: { ...process.env, PATH: "/nonexistent-dir-xyz" },
        }),
      );
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain("kimi");
    });

    it("kimi: rejects an argv prompt over ARG_MAX with a readable usage error", () => {
      const huge = "x".repeat(1024 * 1024 + 100);
      const err = captureError(() =>
        buildSpawnSpec(agent(KIMI), {
          attemptId: "attempt-0",
          workspace: "/ws",
          prompt: huge,
          env: env(tmp),
        }),
      );
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain("argv");
    });
  });

  describe("buildProbeSpec argv (P1-1)", () => {
    const probeOpts = (prompt = DRIVER_PROBE_PROMPT) => ({
      probeId: "probe-x",
      cwd: "/probe-cwd",
      prompt,
      env: env(tmp),
    });

    it("claude: same base argv as review but WITHOUT --dangerously-skip-permissions", () => {
      const spec = buildProbeSpec(agent(CLAUDE_CFUSE), probeOpts());
      expect(spec.argv).toEqual([
        "cfuse",
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
      ]);
      expect(spec.promptStdin).toBe(true);
      expect(spec.cwd).toBe("/probe-cwd");
      expect(spec.executable).toBe(join(tmp, "cld"));
    });

    it("kimi: same argv shape as review (prompt delivered via -p)", () => {
      const spec = buildProbeSpec(agent(KIMI, "kimi-code/k3"), probeOpts());
      expect(spec.argv).toEqual([
        "-m",
        "kimi-code/k3",
        "-p",
        DRIVER_PROBE_PROMPT,
        "--output-format",
        "stream-json",
      ]);
      expect(spec.promptStdin).toBe(false);
    });

    it("codex: minimal exec argv — no sandbox-write, no bypass, no -o", () => {
      const spec = buildProbeSpec(agent(CODEX, "gpt-5"), probeOpts());
      expect(spec.argv).toEqual(["exec", "--skip-git-repo-check", "-m", "gpt-5", "--json", "-"]);
      expect(spec.promptStdin).toBe(true);
      expect(spec.lastMessageFile).toBeUndefined();
    });

    it("claude non-cfuse route → usage error", () => {
      const badRoute = {
        driverId: "claude-stream-json" as const,
        options: { route: "moonshot" as const },
      };
      const err = captureError(() => buildProbeSpec(agent(badRoute), probeOpts()));
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain("cfuse");
    });
  });

  describe("codex --json output extraction", () => {
    it("falls back to the last item.completed agent_message when no -o file exists", () => {
      const stdout = [
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "ls" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "first answer" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "final answer" },
        }),
      ].join("\n");
      expect(extractFinalOutput("codex-app-server", stdout, "/missing/file.md")).toBe(
        "final answer",
      );
    });

    it("the -o file still wins over the JSONL stream", () => {
      const dir = mkdtempSync(join(tmpdir(), "councilkit-codex-json-"));
      try {
        const file = join(dir, ".last-message.md");
        writeFileSync(file, "from-file");
        const stdout = JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "from-stream" },
        });
        expect(extractFinalOutput("codex-app-server", stdout, file)).toBe("from-file");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("DriverActivityCollector (P2-1)", () => {
    function feedLines(coll: DriverActivityCollector, payload: string, splitAt?: number): void {
      const buf = Buffer.from(payload, "utf8");
      if (splitAt === undefined) {
        coll.feed(buf);
      } else {
        coll.feed(buf.subarray(0, splitAt));
        coll.feed(buf.subarray(splitAt));
      }
      coll.end();
    }

    it("claude: counts tool_use blocks of complete assistant messages only (no stream_event double count)", () => {
      const lines = [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_start", content_block: { type: "tool_use" } },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "checking" },
              { type: "tool_use", name: "Bash", input: { command: "git log --oneline" } },
              { type: "tool_use", name: "Bash", input: { cmd: "pnpm test" } },
            ],
          },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "done" }),
      ].join("\n");
      const coll = new DriverActivityCollector("claude-stream-json");
      feedLines(coll, `${lines}\n`);
      expect(coll.summary()).toEqual({
        toolCalls: 2,
        commands: ["git log --oneline", "pnpm test"],
      });
    });

    it("claude: decodes a multibyte command split across chunks", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "grep 审查 src" } }],
        },
      });
      const coll = new DriverActivityCollector("claude-stream-json");
      const buf = Buffer.from(`${line}\n`, "utf8");
      const mid = Math.floor(buf.length / 2);
      feedLines(coll, "", undefined);
      const coll2 = new DriverActivityCollector("claude-stream-json");
      coll2.feed(buf.subarray(0, mid));
      coll2.feed(buf.subarray(mid));
      coll2.end();
      expect(coll2.summary()?.commands).toEqual(["grep 审查 src"]);
    });

    it("kimi: counts assistant tool_calls, ignores role:tool results and decorative lines", () => {
      const lines = [
        "• thinking…",
        JSON.stringify({ role: "meta", content: "resume" }),
        JSON.stringify({
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { arguments: JSON.stringify({ command: "antcode pr diff 1" }) } },
            { args: { cmd: "ls -la" } },
          ],
        }),
        JSON.stringify({ role: "tool", content: "result of the call" }),
      ].join("\n");
      const coll = new DriverActivityCollector("kimi-stream-json");
      feedLines(coll, `${lines}\n`);
      expect(coll.summary()).toEqual({
        toolCalls: 2,
        commands: ["antcode pr diff 1", "ls -la"],
      });
    });

    it("codex: counts item.completed tool items only (no started/completed double count)", () => {
      const lines = [
        JSON.stringify({
          type: "item.started",
          item: { type: "command_execution", command: "ls" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "ls" },
        }),
        JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call" } }),
        JSON.stringify({ type: "item.completed", item: { type: "web_search" } }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
      ].join("\n");
      const coll = new DriverActivityCollector("codex-app-server");
      feedLines(coll, `${lines}\n`);
      expect(coll.summary()).toEqual({ toolCalls: 3, commands: ["ls"] });
    });

    it("recognized stream without tool calls → { toolCalls: 0, commands: [] }", () => {
      const coll = new DriverActivityCollector("claude-stream-json");
      feedLines(coll, `${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`);
      expect(coll.summary()).toEqual({ toolCalls: 0, commands: [] });
    });

    it("completely unrecognized output → undefined (无过程数据), never an error", () => {
      const coll = new DriverActivityCollector("claude-stream-json");
      feedLines(coll, "plain text output\nnot json at all\n");
      expect(coll.summary()).toBeUndefined();
    });

    it("bad JSON lines between valid events are ignored", () => {
      const lines = [
        "{broken json",
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
          },
        }),
      ].join("\n");
      const coll = new DriverActivityCollector("claude-stream-json");
      feedLines(coll, `${lines}\n`);
      expect(coll.summary()).toEqual({ toolCalls: 1, commands: ["ls"] });
    });

    it("claude: only Bash/Shell tools contribute representative commands (toolCalls unchanged)", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "git status" } },
            { type: "tool_use", name: "Edit", input: { command: "not-a-shell-command" } },
            { type: "tool_use", input: { command: "unnamed-tool" } },
          ],
        },
      });
      const coll = new DriverActivityCollector("claude-stream-json");
      feedLines(coll, `${line}\n`);
      expect(coll.summary()).toEqual({ toolCalls: 3, commands: ["git status"] });
    });

    it("claude: JSON events of unknown shape (any `type`) do not count as recognized", () => {
      const coll = new DriverActivityCollector("claude-stream-json");
      feedLines(
        coll,
        `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({ type: "weird" })}\n`,
      );
      expect(coll.summary()).toBeUndefined();
    });

    it("kimi: an unknown role does not count as recognized", () => {
      const coll = new DriverActivityCollector("kimi-stream-json");
      feedLines(coll, `${JSON.stringify({ role: "user", content: "hi" })}\n`);
      expect(coll.summary()).toBeUndefined();
    });

    it("codex: protocol events (thread.started/turn.completed) do not count as recognized", () => {
      const coll = new DriverActivityCollector("codex-app-server");
      feedLines(
        coll,
        `${JSON.stringify({ type: "thread.started", thread_id: "t" })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`,
      );
      expect(coll.summary()).toBeUndefined();
    });

    it("keeps at most 10 commands but counts every tool call", () => {
      const content = Array.from({ length: 12 }, (_, i) => ({
        type: "tool_use",
        name: "Bash",
        input: { command: `cmd-${i}` },
      }));
      const line = JSON.stringify({ type: "assistant", message: { content } });
      const coll = new DriverActivityCollector("claude-stream-json");
      feedLines(coll, `${line}\n`);
      const summary = coll.summary();
      expect(summary?.toolCalls).toBe(12);
      expect(summary?.commands).toHaveLength(10);
      expect(summary?.commands[0]).toBe("cmd-0");
      expect(summary?.commands[9]).toBe("cmd-9");
    });

    it("folds whitespace and truncates a command to 80 characters", () => {
      const long = `echo ${"x".repeat(200)}\nwith newline`;
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: long } }] },
      });
      const coll = new DriverActivityCollector("claude-stream-json");
      feedLines(coll, `${line}\n`);
      const cmd = coll.summary()?.commands[0] ?? "";
      expect(Array.from(cmd).length).toBe(80);
      expect(cmd).not.toContain("\n");
    });
  });

  describe("extractFinalOutput", () => {
    it("claude: last success result .result, skipping error results", () => {
      const stdout = [
        JSON.stringify({ type: "assistant", message: "thinking" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "first" }),
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          result: "bad",
        }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "final" }),
      ].join("\n");
      expect(extractFinalOutput("claude-stream-json", stdout)).toBe("final");
    });

    it("claude: returns null when only error results present", () => {
      const stdout = JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "x",
      });
      expect(extractFinalOutput("claude-stream-json", stdout)).toBeNull();
    });

    it("kimi: last assistant content, skipping role:meta resume lines + non-JSON", () => {
      const stdout = [
        "• decorative resume line",
        JSON.stringify({ role: "meta", content: "resume hint" }),
        JSON.stringify({ role: "assistant", content: "first answer" }),
        JSON.stringify({ role: "assistant", content: "second answer" }),
      ].join("\n");
      expect(extractFinalOutput("kimi-stream-json", stdout)).toBe("second answer");
    });

    it("kimi: handles array content blocks", () => {
      const stdout = JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "block answer" }],
      });
      expect(extractFinalOutput("kimi-stream-json", stdout)).toBe("block answer");
    });

    it("codex: prefers the last-message file over stdout", () => {
      const dir = mkdtempSync(join(tmpdir(), "councilkit-codex-"));
      try {
        const file = join(dir, ".last-message.md");
        writeFileSync(file, "from-file");
        expect(extractFinalOutput("codex-app-server", "from-stdout", file)).toBe("from-file");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("codex: plain-text stdout is NOT a deliverable when the file is absent", () => {
      // No raw-stdout fallback (reviewer finding): codex always runs with
      // --json, so stdout is an event stream — never the deliverable itself.
      expect(extractFinalOutput("codex-app-server", "from-stdout", "/missing/file.md")).toBeNull();
    });

    it("codex: protocol-only JSONL events are never a deliverable (NO_OUTPUT)", () => {
      const stdout = [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "ls" },
        }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ].join("\n");
      expect(extractFinalOutput("codex-app-server", stdout, "/missing/file.md")).toBeNull();
    });

    it("codex: returns null when both file and stdout are empty", () => {
      expect(extractFinalOutput("codex-app-server", "   ")).toBeNull();
    });

    it("unknown driver → null", () => {
      expect(extractFinalOutput("unknown-driver", "anything")).toBeNull();
    });
  });

  describe("FinalEventLineCollector — incremental UTF-8 across chunk boundaries", () => {
    it("a 3-byte CJK char split across chunks decodes without U+FFFD", () => {
      const text = "中"; // E4 B8 AD
      const line = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
      });
      const buf = Buffer.from(`${line}\n`, "utf8");
      const e4 = buf.indexOf(0xe4);
      expect(e4).toBeGreaterThan(0);
      const coll = new FinalEventLineCollector("claude-stream-json");
      coll.feed(buf.subarray(0, e4 + 1)); // only the first byte of 中
      coll.feed(buf.subarray(e4 + 1)); // remaining two bytes + newline
      expect(coll.lastLine).not.toBeNull();
      expect(extractFinalOutput("claude-stream-json", "", undefined, coll.lastLine)).toBe(text);
    });

    it("a 4-byte emoji split across chunks decodes without U+FFFD", () => {
      const text = "🎉"; // F0 9F 8E 89
      const line = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: `review ${text} done`,
      });
      const buf = Buffer.from(`${line}\n`, "utf8");
      const f0 = buf.indexOf(0xf0);
      expect(f0).toBeGreaterThan(0);
      const coll = new FinalEventLineCollector("claude-stream-json");
      coll.feed(buf.subarray(0, f0 + 2)); // two bytes of the 4-byte emoji
      coll.feed(buf.subarray(f0 + 2)); // remaining two bytes + rest
      expect(coll.lastLine).not.toBeNull();
      expect(extractFinalOutput("claude-stream-json", "", undefined, coll.lastLine)).toBe(
        `review ${text} done`,
      );
    });

    it("feeding the whole buffer at once still works (no regression)", () => {
      const text = "结论：通过";
      const line = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
      });
      const coll = new FinalEventLineCollector("claude-stream-json");
      coll.feed(Buffer.from(`${line}\n`, "utf8"));
      expect(coll.lastLine).not.toBeNull();
      expect(extractFinalOutput("claude-stream-json", "", undefined, coll.lastLine)).toBe(text);
    });

    it("end() flushes a trailing final line that has no newline", () => {
      const first = JSON.stringify({ role: "assistant", content: "first" });
      const last = JSON.stringify({ role: "assistant", content: "final" });
      const coll = new FinalEventLineCollector("kimi-stream-json");
      coll.feed(Buffer.from(`${first}\n${last}`, "utf8")); // no trailing newline
      expect(coll.lastLine).toBe(first);
      coll.end();
      expect(coll.lastLine).toBe(last);
      expect(extractFinalOutput("kimi-stream-json", "", undefined, coll.lastLine)).toBe("final");
    });

    it("an over-cap physical line's tail is discarded, not parsed as a new event", () => {
      const valid = JSON.stringify({ role: "assistant", content: "valid" });
      const coll = new FinalEventLineCollector("kimi-stream-json", 64);
      // One physical line longer than the cap, split across feeds; its JSON-ish
      // tail must not be considered; the NEXT physical line parses normally.
      coll.feed(Buffer.from(`{"role":"assistant","content":"${"x".repeat(80)}`, "utf8"));
      coll.feed(Buffer.from(`trailer"}\n${valid}\n`, "utf8"));
      expect(coll.lastLine).toBe(valid);
    });

    it("a kimi assistant line with multibyte content split mid-buffer", () => {
      const text = "审查通过 ✓";
      const line = JSON.stringify({ role: "assistant", content: text });
      const buf = Buffer.from(`${line}\n`, "utf8");
      const mid = Math.floor(buf.length / 2);
      const coll = new FinalEventLineCollector("kimi-stream-json");
      coll.feed(buf.subarray(0, mid));
      coll.feed(buf.subarray(mid));
      expect(coll.lastLine).not.toBeNull();
      expect(extractFinalOutput("kimi-stream-json", "", undefined, coll.lastLine)).toBe(text);
    });
  });

  it("ignores a non-file entry on PATH (directory named like the executable)", () => {
    const dir = mkdtempSync(join(tmpdir(), "councilkit-dc2-"));
    try {
      mkdirSync(join(dir, "cld"));
      const err = captureError(() => resolveExecutable("cld", env(dir)));
      expect(err.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stripProxyPrefix — assignment-only vs env-prefix+command", () => {
  it("reverts when the remainder is entirely assignments", () => {
    expect(stripProxyPrefix("NO_PROXY='1' HTTPS_PROXY='2'").text).toBe(
      "NO_PROXY='1' HTTPS_PROXY='2'",
    );
  });
  it("strips only the proxy assignment when a real command follows another assignment", () => {
    const r = stripProxyPrefix("NO_PROXY='*' FOO='1' antcode pr diff 1");
    expect(r.text).toBe("FOO='1' antcode pr diff 1");
    expect(r.stripped).toBe(true);
  });
});
