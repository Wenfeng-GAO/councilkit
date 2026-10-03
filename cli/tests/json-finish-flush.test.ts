import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCouncilCmd } from "../src/commands/council";
import { createOutput } from "../src/output";

describe("json finish flush", () => {
  const homes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalHome = process.env.COUNCILKIT_HOME;

  afterEach(() => {
    process.stdout.write = originalWrite;
    if (originalHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = originalHome;
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    homes.length = 0;
  });

  it("council list --json resolves only after stdout flushes", async () => {
    const home = mkdtempSync(join(tmpdir(), "ck-json-flush-"));
    homes.push(home);
    process.env.COUNCILKIT_HOME = home;
    let release: (() => void) | undefined;
    process.stdout.write = ((
      _chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void,
    ) => {
      const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      release = () => done?.();
      return false;
    }) as typeof process.stdout.write;

    let settled = false;
    const pending = runCouncilCmd(["list"], createOutput(true)).then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await pending;
    expect(settled).toBe(true);
  });
});
