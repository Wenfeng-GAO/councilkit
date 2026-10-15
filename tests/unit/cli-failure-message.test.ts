import { cliFailureMessage } from "@shared/runtime/cli-failure-message";
import { describe, expect, it } from "vitest";

describe("cliFailureMessage", () => {
  it("reads a trimmed error.message from CLI JSON stdout", () => {
    const stdout = Buffer.from(' {"error":{"message":"  councils.json is not valid JSON  "}} ');
    expect(cliFailureMessage({ stdout })).toBe("councils.json is not valid JSON");
  });

  it.each([
    null,
    "nope",
    {},
    { stdout: "" },
    { stdout: "   " },
    { stdout: "not json" },
    { stdout: "null" },
    { stdout: "[]" },
    { stdout: "{}" },
    { stdout: '{"error":{}}' },
    { stdout: '{"error":{"message":1}}' },
    { stdout: '{"error":{"message":"   "}}' },
    { stderr: "boom" },
  ])("returns null for %j", (error) => {
    expect(cliFailureMessage(error)).toBeNull();
  });
});
