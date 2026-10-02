import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDetailChunk, readSourceWindow } from "@host/repair-observation/source-reader";
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
    const lineA = `${JSON.stringify({ type: "text", text: "a" })}\n`;
    const lineB = `${JSON.stringify({ type: "text", text: "b" })}\n`;
    expect(Buffer.byteLength(lineA)).toBe(Buffer.byteLength(lineB));
    writeFileSync(path, lineA);
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
    expect(first.nextOffset).toBe(Buffer.byteLength(lineA));

    writeFileSync(path, lineB);
    const overwritten = readSourceWindow({
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
    expect(overwritten.generation).toBe(first.generation);
    expect(overwritten.reset).toBe(false);

    const aside = `${path}.aside`;
    renameSync(path, aside);
    writeFileSync(path, lineB);
    expect(statSync(path).ino).not.toBe(statSync(aside).ino);
    expect(statSync(path).size).toBe(first.nextOffset);
    const replaced = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: first.generation,
      fromOffset: first.nextOffset,
      receivedAt: "t3",
      limitRecords: 10,
      direction: "forward",
    });
    expect(replaced.generation).not.toBe(first.generation);
    expect(replaced.reset).toBe(true);
    expect(replaced.records[0]?.text).toBe("b");
  });

  it("pages forward by utf-8 byte offsets", () => {
    const path = join(dir, "utf8.jsonl");
    const line1 = `${JSON.stringify({ type: "text", text: "中文" })}\n`;
    const line2 = `${JSON.stringify({ type: "text", text: "next" })}\n`;
    const line3 = `${JSON.stringify({ type: "text", text: "tail" })}\n`;
    writeFileSync(path, `${line1}${line2}${line3}`);
    const page = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: null,
      fromOffset: 0,
      receivedAt: "t",
      limitRecords: 1,
      direction: "forward",
    });
    expect(page.records.map((row) => row.text)).toEqual(["中文"]);
    expect(page.records[0]?.byteOffset).toBe(0);
    expect(page.nextOffset).toBe(Buffer.byteLength(line1));
    expect(page.exhausted).toBe(false);

    const rest = readSourceWindow({
      path,
      sourceId: "s",
      executionRef: "e#1.1",
      round: 1,
      roleKey: "builder",
      expectedGeneration: page.generation,
      fromOffset: page.nextOffset,
      receivedAt: "t2",
      limitRecords: 10,
      direction: "forward",
    });
    expect(rest.reset).toBe(false);
    expect(rest.records.map((row) => row.text)).toEqual(["next", "tail"]);
    expect(rest.records[0]?.byteOffset).toBe(Buffer.byteLength(line1));
    expect(rest.records[1]?.byteOffset).toBe(Buffer.byteLength(`${line1}${line2}`));
    expect(rest.nextOffset).toBe(Buffer.byteLength(`${line1}${line2}${line3}`));
    expect(rest.exhausted).toBe(true);
  });

  it("keeps an event detail chunk inside its own line", () => {
    const path = join(dir, "detail.jsonl");
    const line = `${JSON.stringify({ type: "tool.completed", output: "ONLY_THIS" })}\n`;
    const next = `${JSON.stringify({ type: "tool.completed", output: "ONLY_NEXT" })}\n`;
    writeFileSync(path, `${line}${next}`);
    const chunk = readDetailChunk({
      path,
      byteOffset: 0,
      cursorOffset: 0,
      chunkSize: 64 * 1024,
    });
    expect(chunk).toEqual({
      body: line.slice(0, -1),
      nextCursor: null,
      truncated: false,
    });
  });

  it("pages a long event line without reading the following event", () => {
    const path = join(dir, "long-detail.jsonl");
    const payload = "0123456789";
    const line = `${payload}\n`;
    const next = "NEXT\n";
    writeFileSync(path, `${line}${next}`);
    const first = readDetailChunk({ path, byteOffset: 0, cursorOffset: 0, chunkSize: 4 });
    expect(first).toEqual({ body: "0123", nextCursor: "4", truncated: true });
    const second = readDetailChunk({ path, byteOffset: 0, cursorOffset: 4, chunkSize: 4 });
    expect(second).toEqual({ body: "4567", nextCursor: "8", truncated: true });
    const third = readDetailChunk({ path, byteOffset: 0, cursorOffset: 8, chunkSize: 4 });
    expect(third).toEqual({ body: "89", nextCursor: null, truncated: false });
  });

  it("pages earlier records nearest the cursor without a gap", () => {
    const path = join(dir, "earlier.jsonl");
    const lines = Array.from({ length: 30 }, (_, index) =>
      JSON.stringify({ type: "text", text: `row-${index}` }),
    );
    writeFileSync(path, `${lines.join("\n")}\n`);
    const readEarlier = (fromOffset: number, limitRecords: number) =>
      readSourceWindow({
        path,
        sourceId: "s",
        executionRef: "e#1.1",
        round: 1,
        roleKey: "builder",
        expectedGeneration: null,
        fromOffset,
        receivedAt: "t",
        limitRecords,
        direction: "earlier",
      });
    const end = statSync(path).size;
    const newest = readEarlier(end, 10);
    expect(newest.records.map((row) => row.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `row-${index + 20}`),
    );
    const middle = readEarlier(newest.nextOffset, 10);
    expect(middle.records.map((row) => row.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `row-${index + 10}`),
    );
    const oldest = readEarlier(middle.nextOffset, 10);
    expect(oldest.records.map((row) => row.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `row-${index}`),
    );
    expect(oldest.nextOffset).toBe(0);
  });

  it("keeps a row that sits between an isolated line and the earlier cursor", () => {
    const path = join(dir, "isolated-gap.jsonl");
    const prefix = `${JSON.stringify({ type: "text", text: "prefix-0" })}\n`;
    const gap = `${"x".repeat(2 * 1024 * 1024 - 1)}\n`;
    const suffix0 = `${JSON.stringify({ type: "text", text: "suffix-0" })}\n`;
    const suffix1 = `${JSON.stringify({ type: "text", text: "suffix-1" })}\n`;
    const suffix2 = `${JSON.stringify({ type: "text", text: "suffix-2" })}\n`;
    writeFileSync(path, `${prefix}${gap}${suffix0}${suffix1}${suffix2}`);
    const readEarlier = (fromOffset: number) =>
      readSourceWindow({
        path,
        sourceId: "s",
        executionRef: "e#1.1",
        round: 1,
        roleKey: "builder",
        expectedGeneration: null,
        fromOffset,
        receivedAt: "t",
        limitRecords: 1,
        direction: "earlier",
      });
    const end = Buffer.byteLength(`${prefix}${gap}${suffix0}${suffix1}`);
    const nearest = readEarlier(end);
    expect(nearest.records.map((row) => row.text)).toEqual(["suffix-1"]);
    expect(nearest.earlierOffset).toBe(Buffer.byteLength(`${prefix}${gap}${suffix0}`));
    const older = readEarlier(nearest.earlierOffset ?? 0);
    expect(older.records.map((row) => row.text)).toEqual(["suffix-0"]);
    const seen = new Set<string>(["suffix-1", "suffix-0"]);
    let cursor = older.earlierOffset;
    for (let guard = 0; cursor && guard < 8; guard += 1) {
      const page = readEarlier(cursor);
      for (const row of page.records) {
        if (row.text) seen.add(row.text);
      }
      cursor = page.earlierOffset;
    }
    expect(seen).toEqual(new Set(["prefix-0", "suffix-0", "suffix-1"]));
  });

  it("pages a multibyte event line without splitting a character", () => {
    const path = join(dir, "utf8-detail.jsonl");
    const payload = "中中中";
    writeFileSync(path, `${payload}\nNEXT\n`);
    const first = readDetailChunk({ path, byteOffset: 0, cursorOffset: 0, chunkSize: 4 });
    expect(first).toEqual({ body: "中", nextCursor: "3", truncated: true });
    const second = readDetailChunk({ path, byteOffset: 0, cursorOffset: 3, chunkSize: 4 });
    expect(second).toEqual({ body: "中", nextCursor: "6", truncated: true });
    const third = readDetailChunk({ path, byteOffset: 0, cursorOffset: 6, chunkSize: 4 });
    expect(third).toEqual({ body: "中", nextCursor: null, truncated: false });
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
