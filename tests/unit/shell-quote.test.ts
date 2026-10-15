import { shellSingleQuote } from "@shared/runtime/shell-quote";
import { describe, expect, it } from "vitest";

describe("shellSingleQuote", () => {
  it("quotes plain tokens, dollars, and apostrophes", () => {
    expect(shellSingleQuote("the-task")).toBe("'the-task'");
    expect(shellSingleQuote("task $HOME")).toBe("'task $HOME'");
    expect(shellSingleQuote("don't leak")).toBe("'don'\\''t leak'");
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
    expect(shellSingleQuote("")).toBe("''");
  });
});
