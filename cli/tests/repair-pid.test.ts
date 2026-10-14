import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_RUN_PIPELINE_PID_FILE } from "@shared/runtime/cli-run-progress";
import { afterEach, describe, expect, it } from "vitest";
import { readRepairPid, writeRepairPid } from "../src/auto/repair-persist";

describe("readRepairPid", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a canonical pid and rejects a prefix or decimal", () => {
    dir = mkdtempSync(join(tmpdir(), "ck-repair-pid-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CLI_RUN_PIPELINE_PID_FILE), "123abc\n");
    expect(readRepairPid(dir)).toBeNull();
    writeFileSync(join(dir, CLI_RUN_PIPELINE_PID_FILE), "1.9\n");
    expect(readRepairPid(dir)).toBeNull();
    writeRepairPid(dir, 4242);
    expect(readRepairPid(dir)).toBe(4242);
  });
});
