import { describe, expect, it } from "vitest";
import {
  classifyDriverTerminal,
  isCodexReconnectDiagnostic,
  redactDriverDiagnostic,
} from "../src/auto/driver-terminal";

describe("isCodexReconnectDiagnostic", () => {
  it("matches the Codex app-server reconnect banner", () => {
    expect(
      isCodexReconnectDiagnostic(
        "error: Reconnecting... 1/5 (stream disconnected before completion: Transport error: network error: error decoding response body)",
      ),
    ).toBe(true);
  });

  it("does not match a generic network error", () => {
    expect(isCodexReconnectDiagnostic("turn.failed: network error")).toBe(false);
  });
});

describe("classifyDriverTerminal", () => {
  it("ignores a recovered Codex reconnect when a later agent_message exists", () => {
    const terminal = classifyDriverTerminal({
      stdout: [
        JSON.stringify({
          type: "error",
          message:
            "Reconnecting... 1/5 (stream disconnected before completion: Transport error: network error: error decoding response body)",
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "done" },
        }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    expect(terminal).toBeNull();
  });

  it("ignores reconnect text on stderr after a structured success", () => {
    const terminal = classifyDriverTerminal({
      stdout: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
      stderr:
        "error: Reconnecting... 2/5 (stream disconnected before completion: Transport error: network error)",
      exitCode: 0,
    });
    expect(terminal).toBeNull();
  });

  it("does not treat a port number 502 as a transport error", () => {
    const terminal = classifyDriverTerminal({
      stdout: "",
      stderr: "listening on 127.0.0.1:502",
      exitCode: 1,
    });
    expect(terminal?.errorClass).not.toBe("transport");
  });

  it("does not treat a port, version, or glued 401 or 429 as auth or rate", () => {
    const quiet = (stderr: string) => classifyDriverTerminal({ stdout: "", stderr, exitCode: 0 });
    expect(quiet("listening on 127.0.0.1:401")).toBeNull();
    expect(quiet("listening on 127.0.0.1:429")).toBeNull();
    expect(quiet("go1.401")).toBeNull();
    expect(quiet("1401")).toBeNull();
    expect(classifyDriverTerminal({ stdout: "", stderr: "error: 401", exitCode: 1 })).toBeNull();
    expect(classifyDriverTerminal({ stdout: "", stderr: "status:429", exitCode: 1 })).toBeNull();
    expect(classifyDriverTerminal({ stdout: "", stderr: "HTTP/1.1 401", exitCode: 1 })).toBeNull();
    expect(
      classifyDriverTerminal({ stdout: "", stderr: "AUTH_REQUIRED", exitCode: 1 })?.errorClass,
    ).toBe("auth");
    expect(
      classifyDriverTerminal({ stdout: "", stderr: "not logged in", exitCode: 1 })?.errorClass,
    ).toBe("auth");
  });

  it("does not read a source location or a named port or version as a status code", () => {
    const quiet = (stderr: string) => classifyDriverTerminal({ stdout: "", stderr, exitCode: 0 });
    expect(quiet('File "app.py", line 401, in main')).toBeNull();
    expect(quiet("src/foo.ts(401,12): error TS2345")).toBeNull();
    expect(quiet("listening on port 401")).toBeNull();
    expect(quiet("client version 401")).toBeNull();
    expect(quiet('File "app.py", line 429, in fetch')).toBeNull();
    expect(quiet("listening on port 429")).toBeNull();
    expect(quiet('{"version":"401"}')).toBeNull();
    expect(quiet("listening on http://127.0.0.1:502")).toBeNull();
    expect(quiet("https://127.0.0.1:503/health")).toBeNull();
    expect(
      classifyDriverTerminal({ stdout: "", stderr: '{"status":401}', exitCode: 1 })?.errorClass,
    ).toBe("auth");
    expect(
      classifyDriverTerminal({ stdout: "", stderr: '{"status":403}', exitCode: 1 })?.errorClass,
    ).toBe("auth");
    expect(
      classifyDriverTerminal({ stdout: "", stderr: '{"status":429}', exitCode: 1 })?.errorClass,
    ).toBe("rate");
    expect(
      classifyDriverTerminal({ stdout: "", stderr: '{"status":502}', exitCode: 1 })?.errorClass,
    ).toBe("transport");
    expect(classifyDriverTerminal({ stdout: "", stderr: "HTTP/1.1 502", exitCode: 1 })).toBeNull();
    expect(classifyDriverTerminal({ stdout: "", stderr: "status: 503", exitCode: 1 })).toBeNull();
  });

  it("ignores a free-standing or parenthesized 401 in tool output", () => {
    const classified = (stderr: string) =>
      classifyDriverTerminal({ stdout: "", stderr, exitCode: 1 });
    expect(classified("HTTP status (401)")).toBeNull();
    expect(classified("request failed (401)")).toBeNull();
    expect(classified("HTTP status (429)")).toBeNull();
    expect(classified("HTTP status (502)")).toBeNull();
    expect(classified("HTTP status (503)")).toBeNull();
    expect(classified("src/foo.ts(401,12): error TS2345")).toBeNull();
    expect(classified("src/foo.ts (401,12): error TS2345")).toBeNull();
    expect(classified("src/foo.ts (401, 12): error TS2345")).toBeNull();
    expect(classified("src/foo.ts( 401,12): error TS2345")).toBeNull();
    expect(classified("src/foo.ts (429,8): error TS2345")).toBeNull();
    expect(classified("src/foo.ts (502,3): error TS2345")).toBeNull();
    expect(classified("src/foo.ts (503,1): error TS2345")).toBeNull();
    expect(classified("src/foo.ts (401)")).toBeNull();
    expect(classified('File "app.py", line 401, in main')).toBeNull();
    expect(classified("src/foo.ts(429,8): error TS2345")).toBeNull();
    expect(classified("src/foo.ts(502,3): error TS2345")).toBeNull();
    expect(classified("src/foo.ts(503,1): error TS2345")).toBeNull();
    expect(classified("M\tsrc/auth.ts\n@@ -401,7 +401,7 @@\n context")).toBeNull();
  });

  it("uses the auth phrase itself when tool output precedes it", () => {
    const stderr = `${"M\tsrc/auth.ts\n".repeat(40)}@@ -401,7 +401,7 @@\nError: not logged in`;
    const terminal = classifyDriverTerminal({ stdout: "", stderr, exitCode: 1 });
    expect(terminal).toMatchObject({
      errorClass: "auth",
      retryable: false,
      source: "stderr",
      message: "not logged in",
    });
    expect(terminal?.message).not.toContain("src/auth.ts");
    expect(terminal?.message).not.toContain("@@");
  });

  it("classifies a structured 401 or 403 without echoing a diff stuffed into the event", () => {
    const diff = "M\tsrc/auth.ts\n@@ -401,7 +401,7 @@\n";
    const terminal = classifyDriverTerminal({
      stdout: JSON.stringify({
        type: "error",
        status: 401,
        message: `${diff}authentication failed`,
      }),
      stderr: "",
      exitCode: 1,
    });
    expect(terminal?.errorClass).toBe("auth");
    expect(terminal?.source).toBe("structured");
    expect(terminal?.message).toBe("authentication failed");
    expect(terminal?.message).not.toContain("src/auth.ts");
    expect(
      classifyDriverTerminal({
        stdout: JSON.stringify({ type: "error", status: 403 }),
        stderr: "",
        exitCode: 1,
      })?.errorClass,
    ).toBe("auth");
  });

  it("still flags a later turn.failed network error", () => {
    const terminal = classifyDriverTerminal({
      stdout: [
        JSON.stringify({
          type: "error",
          message: "Reconnecting... 1/5 (stream disconnected before completion: network error)",
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "network error" } }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    expect(terminal?.errorClass).toBe("transport");
  });
});

describe("redactDriverDiagnostic", () => {
  it("does not split a surrogate pair at the 400-unit truncation boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles index 400: raw slice(0, 400) leaves a lone high surrogate
    const long = `${"a".repeat(399)}${emoji}${"x".repeat(20)}`;
    expect(long.length).toBeGreaterThan(400);

    const redacted = redactDriverDiagnostic(long);
    expect(redacted.length).toBeLessThanOrEqual(400);
    expect(redacted.includes("\uD83D")).toBe(false);
    expect(redacted.endsWith("\uD83D")).toBe(false);
    // Keep the ASCII prefix intact; drop the straddling emoji rather than split it.
    expect(redacted).toBe("a".repeat(399));
  });
});
