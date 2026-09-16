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
