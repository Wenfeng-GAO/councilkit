/**
 * Parser unit tests (plan-a §10 AC1, command bucket). Strict parseArgs: unknown
 * flags rejected, missing values rejected, surplus positionals rejected; JSON
 * flags + positive-int flags validated via zod.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseFlags, parseIntFlag, parseJsonFlag } from "../src/commands/parse";
import { CliError } from "../src/errors";

function capture(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected an error to be thrown");
}

describe("cli parse", () => {
  it("parses declared string + boolean flags", () => {
    const { values, positionals } = parseFlags(
      {
        flags: { name: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: 1,
      },
      ["--name", "foo", "--json", "ref-1"],
    );
    expect(values.name).toBe("foo");
    expect(values.json).toBe(true);
    expect(positionals).toEqual(["ref-1"]);
  });

  it("rejects unknown flags (strict)", () => {
    const err = capture(() =>
      parseFlags({ flags: { json: { type: "boolean" } }, allowPositionals: 0 }, ["--bogus"]),
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(2);
  });

  it("rejects missing flag value", () => {
    const err = capture(() =>
      parseFlags({ flags: { name: { type: "string" } }, allowPositionals: 0 }, ["--name"]),
    );
    expect(err).toBeInstanceOf(CliError);
  });

  it("rejects surplus positionals", () => {
    const err = capture(() =>
      parseFlags({ flags: { json: { type: "boolean" } }, allowPositionals: 0 }, ["extra"]),
    );
    expect(err).toBeInstanceOf(CliError);
  });

  it("parses a JSON array flag", () => {
    const v = parseJsonFlag('["a","b"]', jsonArray(), "agents");
    expect(v).toEqual(["a", "b"]);
  });

  it("rejects malformed JSON", () => {
    const err = capture(() => parseJsonFlag("[not json", jsonArray(), "agents"));
    expect(err).toBeInstanceOf(CliError);
  });

  it("rejects a JSON value of the wrong shape", () => {
    const err = capture(() => parseJsonFlag('"not-an-array"', jsonArray(), "agents"));
    expect(err).toBeInstanceOf(CliError);
  });

  it("parses a positive integer", () => {
    expect(parseIntFlag("3", "rounds")).toBe(3);
  });

  it("rejects a non-positive integer", () => {
    expect(() => parseIntFlag("0", "rounds")).toThrow(CliError);
    expect(() => parseIntFlag("x", "rounds")).toThrow(CliError);
  });

  it("rejects trailing garbage and decimals (strict positive-integer, F9)", () => {
    expect(() => parseIntFlag("2oops", "rounds")).toThrow(CliError);
    expect(() => parseIntFlag("1.9", "rounds")).toThrow(CliError);
    expect(() => parseIntFlag("-3", "rounds")).toThrow(CliError);
    expect(() => parseIntFlag("01", "rounds")).toThrow(CliError);
    expect(() => parseIntFlag(" 3", "rounds")).toThrow(CliError);
    expect(() => parseIntFlag("3 ", "rounds")).toThrow(CliError);
    expect(() => parseIntFlag("0x3", "rounds")).toThrow(CliError);
    expect(() => parseIntFlag("1e3", "rounds")).toThrow(CliError);
  });

  it("accepts a bare decimal positive integer (strict, F9)", () => {
    expect(parseIntFlag("3", "rounds")).toBe(3);
    expect(parseIntFlag("12", "rounds")).toBe(12);
  });
});

function jsonArray() {
  return z.array(z.string().min(1));
}
