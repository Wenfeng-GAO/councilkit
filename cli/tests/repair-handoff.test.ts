import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepairHandoff } from "../src/auto/repair-handoff";
import { CliError } from "../src/errors";

const RUN_ID = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";

describe("repair handoff", () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-repair-handoff-"));
    previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
    mkdirSync(join(home, "runs"), { recursive: true });
  });

  afterEach(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
    else process.env.COUNCILKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("creates an exclusive file outside runs/ and returns hash plus generation", () => {
    const first = createRepairHandoff({
      runId: RUN_ID,
      cycle: 1,
      body: { hello: "world" },
    });
    expect(first.generation).toBe(1);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.path.includes(`${join("runs", "")}`)).toBe(false);
    expect(() =>
      createRepairHandoff({
        runId: RUN_ID,
        cycle: 1,
        body: { hello: "again" },
      }),
    ).toThrow(CliError);
    const second = createRepairHandoff({
      runId: RUN_ID,
      cycle: 2,
      body: { hello: "next" },
    });
    expect(second.generation).toBe(2);
    expect(second.path).not.toBe(first.path);
  });

  it("refuses a handoff parent that is a symlink or lives under runs/", () => {
    const runsFile = join(home, "runs", "trap.json");
    expect(() => {
      writeFileSync(runsFile, "{}\n", { flag: "wx" });
      createRepairHandoff({
        runId: RUN_ID,
        cycle: 1,
        body: {},
        directory: join(home, "runs"),
      });
    }).toThrow(/runs history|handoff/i);

    const real = join(home, "real-handoff");
    const link = join(home, "link-handoff");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    expect(() =>
      createRepairHandoff({
        runId: RUN_ID,
        cycle: 1,
        body: {},
        directory: link,
      }),
    ).toThrow(/symlink/i);
  });
});
