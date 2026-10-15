import { describe, expect, it } from "vitest";
import { asText, parseJsonLine } from "../src/auto/driver-commands";

describe("parseJsonLine", () => {
  it("keeps objects and arrays and drops scalars, JSON null, and invalid text", () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine('  {"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine('[1,{"b":2}]')).toEqual([1, { b: 2 }]);
    expect(parseJsonLine("null")).toBeNull();
    expect(parseJsonLine("1")).toBeNull();
    expect(parseJsonLine('"x"')).toBeNull();
    expect(parseJsonLine("true")).toBeNull();
    expect(parseJsonLine("")).toBeNull();
    expect(parseJsonLine("{")).toBeNull();
    expect(parseJsonLine("not json")).toBeNull();
  });
});

describe("asText", () => {
  it("joins string blocks and prefers text over content", () => {
    expect(asText("hello")).toBe("hello");
    expect(asText("")).toBeNull();
    expect(asText(null)).toBeNull();
    expect(asText(1)).toBeNull();
    expect(asText([])).toBeNull();
    expect(
      asText([
        "a",
        "",
        { text: "b" },
        { content: "c" },
        { text: "" },
        { text: "d", content: "ignored" },
      ]),
    ).toBe("a\nb\nc\nd");
  });
});
