import { describe, expect, it } from "vitest";
import { classifyDriverTerminal, isCodexReconnectDiagnostic } from "../src/auto/driver-terminal";

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
    expect(
      classifyDriverTerminal({ stdout: "", stderr: "error: 401", exitCode: 1 })?.errorClass,
    ).toBe("auth");
    expect(
      classifyDriverTerminal({ stdout: "", stderr: "status:429", exitCode: 1 })?.errorClass,
    ).toBe("rate");
    expect(
      classifyDriverTerminal({ stdout: "", stderr: "HTTP/1.1 401", exitCode: 1 })?.errorClass,
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
