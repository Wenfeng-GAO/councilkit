import { delimiter, join } from "node:path";
import {
  defaultDriverWellKnownBinDirs,
  vendorDriverBinDirs,
  withDriverWellKnownPath,
} from "@shared/runtime/driver-bins";
import { describe, expect, it } from "vitest";

describe("vendor driver bin dirs", () => {
  it("puts kimi-code and grok homes after the usual macOS bins", () => {
    const home = "/tmp/ck-home";
    expect(vendorDriverBinDirs(home)).toEqual([
      join(home, ".kimi-code", "bin"),
      join(home, ".grok", "bin"),
    ]);
    expect(defaultDriverWellKnownBinDirs({ HOME: home })).toEqual([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      join(home, ".local", "bin"),
      join(home, "bin"),
      join(home, ".kimi-code", "bin"),
      join(home, ".grok", "bin"),
    ]);
  });

  it("appends vendor bins to a stripped launchd PATH without duplicating", () => {
    const home = "/Users/example";
    const launchd = "/usr/bin:/bin:/Users/example/.local/bin:/Users/example/bin";
    const next = withDriverWellKnownPath({ HOME: home, PATH: launchd });
    expect(next.PATH?.split(delimiter)).toEqual([
      "/usr/bin",
      "/bin",
      "/Users/example/.local/bin",
      "/Users/example/bin",
      "/Users/example/.kimi-code/bin",
      "/Users/example/.grok/bin",
    ]);
    const again = withDriverWellKnownPath(next);
    expect(again.PATH).toBe(next.PATH);
  });
});
