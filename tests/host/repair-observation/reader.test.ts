import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceWindow } from "@host/repair-observation/source-reader";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ck-obs-reader-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("source-reader bounded reads (U06/U07)", () => {
  it("does not advance past an incomplete trailing line", () => {
    const path = join(dir, "a.jsonl");
    const line1 = `${JSON.stringify({ type: "text", text: "one" })}\n`;
    writeFileSync(path, `${line1}{"type":"text","text":"半`);
    const first = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: null,
      fromOffset: 0,
      receivedAt: "2026-09-22T06:00:00Z",
      limitRecords: 200,
      direction: "forward",
    });
    expect(first.records).toHaveLength(1);
    expect(first.incompleteTail).toBe(true);
    expect(first.nextOffset).toBe(Buffer.byteLength(line1, "utf8"));

    const second = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: first.generation,
      fromOffset: first.nextOffset,
      receivedAt: "2026-09-22T06:00:01Z",
      limitRecords: 200,
      direction: "forward",
    });
    expect(second.records).toHaveLength(0);
    expect(second.nextOffset).toBe(first.nextOffset);

    const line2 = `${JSON.stringify({ type: "text", text: "完整中文" })}\n`;
    writeFileSync(path, `${line1}${line2}`);
    const third = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: null,
      fromOffset: first.nextOffset,
      receivedAt: "2026-09-22T06:00:02Z",
      limitRecords: 200,
      direction: "forward",
    });
    expect(third.records).toHaveLength(1);
    expect(third.records[0]?.text).toBe("完整中文");
  });

  it("skips bad lines and isolates oversize lines", () => {
    const path = join(dir, "b.jsonl");
    // Keep total size under the cold-tail window so the whole file is scanned.
    writeFileSync(
      path,
      `not-json\n${"y".repeat(1_100_000)}\n${JSON.stringify({ type: "text", text: "ok" })}\n`,
    );
    const read = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: null,
      fromOffset: 0,
      receivedAt: "2026-09-22T06:00:00Z",
      limitRecords: 200,
      direction: "forward",
    });
    expect(read.partialBadLines).toBeGreaterThan(0);
    expect(read.isolatedOversize).toBeGreaterThan(0);
    expect(read.records.some((r) => r.text === "ok")).toBe(true);
  });

  it("detects generation reset when file is replaced", () => {
    const path = join(dir, "c.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "text", text: "a" })}\n`);
    const first = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: null,
      fromOffset: 0,
      receivedAt: "t",
      limitRecords: 10,
      direction: "forward",
    });
    writeFileSync(path, `${JSON.stringify({ type: "text", text: "b" })}\n`);
    const second = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: first.generation,
      fromOffset: first.nextOffset,
      receivedAt: "t2",
      limitRecords: 10,
      direction: "forward",
    });
    expect(second.reset).toBe(true);
  });
});

describe("resolver trusted roots", () => {
  it("loads only registered task sources", async () => {
    const { mkdirSync } = await import("node:fs");
    const { resolveTrustedSources } = await import("@host/repair-observation/resolver");
    const home = mkdtempSync(join(tmpdir(), "ck-obs-resolve-"));
    const old = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
    try {
      const runId = "ck-repair-00000000-0000-4000-8000-000000000199";
      const taskDir = join(home, "squad-tasks", "t1");
      mkdirSync(join(home, "runs", runId), { recursive: true });
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "orchestrator.log"), "{}\n");
      writeFileSync(
        join(home, "runs", runId, "repair.json"),
        JSON.stringify({
          version: 1,
          casVersion: 0,
          sourceRunId: "ck-review-00000000-0000-4000-8000-000000000002",
          profileName: "default",
          outerUsed: 0,
          outerMax: 3,
          timeoutMs: null,
          businessResult: null,
          reasonCode: null,
          cycles: [{ n: 1, phase: "active", squadTaskId: "t1", squadTaskDir: taskDir }],
        }),
      );
      const resolved = resolveTrustedSources(runId, "current");
      expect(resolved.sources.some((s) => s.path.endsWith("orchestrator.log"))).toBe(true);
      expect(resolved.state?.sourceRunId).toContain("ck-review-");
    } finally {
      if (old === undefined) process.env.COUNCILKIT_HOME = undefined;
      else process.env.COUNCILKIT_HOME = old;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
