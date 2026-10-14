/**
 * Global flags are stripped before the leaf parser runs. A token that is the
 * value of a long option, or that follows `--`, is not a global flag.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/commands/parse";
import { COMMAND_BOOLEAN_FLAGS, partitionGlobalArgs } from "../src/global-args";

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/commands");

function booleanFlagsDeclaredOnCommands(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(COMMANDS_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(COMMANDS_DIR, file), "utf8");
    for (const match of text.matchAll(/["']?([a-z0-9-]+)["']?\s*:\s*\{\s*type:\s*"boolean"/g)) {
      if (match[1] !== "json") names.add(`--${match[1]}`);
    }
  }
  return [...names].sort();
}

describe("partitionGlobalArgs", () => {
  it("strips --json before or after the command", () => {
    expect(partitionGlobalArgs(["review", "URL", "--json"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "review",
      rest: ["URL"],
    });
    expect(partitionGlobalArgs(["--json", "review", "URL"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "review",
      rest: ["URL"],
    });
  });

  it("keeps --json, --help, -h, and --version after --", () => {
    for (const token of ["--json", "--help", "-h", "--version"]) {
      expect(partitionGlobalArgs(["ideate", "--", token])).toEqual({
        json: false,
        help: false,
        version: false,
        command: "ideate",
        rest: ["--", token],
      });
    }
    expect(partitionGlobalArgs(["--json", "ideate", "--", "--help"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "ideate",
      rest: ["--", "--help"],
    });
  });

  it("keeps a dashed token that is the value of a string option", () => {
    expect(partitionGlobalArgs(["ideate", "idea", "--background", "--json"])).toEqual({
      json: false,
      help: false,
      version: false,
      command: "ideate",
      rest: ["idea", "--background", "--json"],
    });
    expect(
      partitionGlobalArgs(["findings", "accept", "--reason", "-h", "--run", "id", "--id", "f"]),
    ).toEqual({
      json: false,
      help: false,
      version: false,
      command: "findings",
      rest: ["accept", "--reason", "-h", "--run", "id", "--id", "f"],
    });
    expect(partitionGlobalArgs(["ideate", "--background", "--", "--help"])).toEqual({
      json: false,
      help: false,
      version: false,
      command: "ideate",
      rest: ["--background", "--", "--help"],
    });
  });

  it("still strips --json that follows a boolean flag or an attached value", () => {
    expect(partitionGlobalArgs(["review", "URL", "--require-spec", "--json"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "review",
      rest: ["URL", "--require-spec"],
    });
    expect(partitionGlobalArgs(["review", "URL", "--no-require-spec", "--json"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "review",
      rest: ["URL", "--no-require-spec"],
    });
    expect(partitionGlobalArgs(["runs", "gc", "--all", "--json"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "runs",
      rest: ["gc", "--all"],
    });
    expect(partitionGlobalArgs(["runs", "gc", "--dry-run", "--json"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "runs",
      rest: ["gc", "--dry-run"],
    });
    expect(partitionGlobalArgs(["runs", "gc", "--keep", "7", "--json"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "runs",
      rest: ["gc", "--keep", "7"],
    });
    expect(partitionGlobalArgs(["review", "URL", "--timeout=30m", "--json"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "review",
      rest: ["URL", "--timeout=30m"],
    });
    expect(partitionGlobalArgs(["init", "--force", "--json"])).toEqual({
      json: true,
      help: false,
      version: false,
      command: "init",
      rest: ["--force"],
    });
  });

  it("recognizes help and version when they are their own flags", () => {
    expect(partitionGlobalArgs(["--help"])).toEqual({
      json: false,
      help: true,
      version: false,
      command: undefined,
      rest: [],
    });
    expect(partitionGlobalArgs(["review", "--help"])).toEqual({
      json: false,
      help: true,
      version: false,
      command: "review",
      rest: [],
    });
    expect(partitionGlobalArgs(["--version"])).toEqual({
      json: false,
      help: false,
      version: true,
      command: undefined,
      rest: [],
    });
    expect(partitionGlobalArgs(["--json", "--help", "review", "URL"])).toEqual({
      json: true,
      help: true,
      version: false,
      command: "review",
      rest: ["URL"],
    });
  });

  it("leaves the host ideate idea after -- for the leaf parser", () => {
    const idea = "--help";
    const partitioned = partitionGlobalArgs([
      "ideate",
      "--run-id",
      "ck-ideate-018f0b3e-7c3a-7a1e-8c1a-6d5e4f3a2b10",
      "--debate-rounds",
      "1",
      "--background",
      "solo builder, two weeks",
      "--",
      idea,
    ]);
    expect(partitioned).toEqual({
      json: false,
      help: false,
      version: false,
      command: "ideate",
      rest: [
        "--run-id",
        "ck-ideate-018f0b3e-7c3a-7a1e-8c1a-6d5e4f3a2b10",
        "--debate-rounds",
        "1",
        "--background",
        "solo builder, two weeks",
        "--",
        "--help",
      ],
    });
    const parsed = parseFlags(
      {
        flags: {
          json: { type: "boolean" },
          background: { type: "string" },
          "debate-rounds": { type: "string" },
          "run-id": { type: "string" },
        },
        allowPositionals: 1,
      },
      partitioned.rest,
    );
    expect(parsed.positionals).toEqual(["--help"]);
    expect(parsed.values.background).toBe("solo builder, two weeks");
    expect(parsed.values["run-id"]).toBe("ck-ideate-018f0b3e-7c3a-7a1e-8c1a-6d5e4f3a2b10");
    expect(parsed.values["debate-rounds"]).toBe("1");
    expect(parsed.values.json).toBeUndefined();
  });

  it("keeps every command boolean from swallowing the next --json", () => {
    expect(booleanFlagsDeclaredOnCommands()).toEqual([...COMMAND_BOOLEAN_FLAGS].sort());
    for (const flag of COMMAND_BOOLEAN_FLAGS) {
      expect(partitionGlobalArgs(["cmd", "pos", flag, "--json"])).toEqual({
        json: true,
        help: false,
        version: false,
        command: "cmd",
        rest: ["pos", flag],
      });
    }
  });
});
