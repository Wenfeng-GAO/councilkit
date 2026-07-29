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
  FinalEventLineCollector,
  buildSpawnSpec,
  extractFinalOutput,
  resolveExecutable,
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

    it("codex: stdin prompt, last-message file under workspace, skip-git-repo-check", () => {
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

    it("codex: falls back to stdout when the file is absent", () => {
      expect(extractFinalOutput("codex-app-server", "from-stdout", "/missing/file.md")).toBe(
        "from-stdout",
      );
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
      const coll = new FinalEventLineCollector("kimi-stream-json", 16);
      // One physical line longer than the cap, split across feeds; its JSON-ish
      // tail must not be considered; the NEXT physical line parses normally.
      coll.feed(Buffer.from(`{"role":"assistant","content":"${"x".repeat(32)}`, "utf8"));
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
