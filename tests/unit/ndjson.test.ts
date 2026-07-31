/**
 * NDJSON splitter must decode driver stdout as a single cross-chunk UTF-8
 * stream: a multi-byte char split across two pipe chunks must be reassembled,
 * not replaced by U+FFFD. Mirrors the StringDecoder precedent in
 * cli/src/auto/driver-commands.ts (FinalEventLineCollector).
 */
import { PassThrough } from "node:stream";
import { LIMITS } from "@shared/runtime/contracts";
import { describe, expect, it } from "vitest";
import { attachNdjsonSplitter } from "../../runtime-host/drivers/ndjson";

interface Captured {
  lines: string[];
  limitExceeded: number;
  ended: number;
}

function runSplitter(chunks: Buffer[]): Promise<Captured> {
  return new Promise((resolve) => {
    const captured: Captured = { lines: [], limitExceeded: 0, ended: 0 };
    const stream = new PassThrough();
    attachNdjsonSplitter(stream, {
      onLine: (line) => captured.lines.push(line),
      onLimitExceeded: () => {
        captured.limitExceeded += 1;
      },
      onEnd: () => {
        captured.ended += 1;
      },
    });
    // Resolve once the stream has fully ended (the 'end' event still fires in the
    // overflow case — attachNdjsonSplitter just suppresses onEnd under overflow).
    stream.on("end", () => resolve(captured));
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
}

describe("attachNdjsonSplitter — cross-chunk UTF-8", () => {
  it("a 3-byte CJK char split across chunks decodes without U+FFFD", async () => {
    const obj = { content: "你" }; // 你 = E4 BD A0
    const line = `${JSON.stringify(obj)}\n`;
    const buf = Buffer.from(line, "utf8");
    const e4 = buf.indexOf(0xe4);
    expect(e4).toBeGreaterThan(0);
    // chunk1 ends with the first byte (E4) of 你; chunk2 starts with BD A0.
    const captured = await runSplitter([buf.subarray(0, e4 + 1), buf.subarray(e4 + 1)]);

    expect(captured.limitExceeded).toBe(0);
    expect(captured.ended).toBe(1);
    expect(captured.lines).toHaveLength(1);
    const received = captured.lines[0];
    expect(received).toBe(line.replace("\n", ""));
    expect(received).not.toContain("�");
    expect(JSON.parse(received)).toEqual(obj);
  });

  it("a 4-byte emoji split across chunks decodes without U+FFFD (no trailing newline)", async () => {
    const obj = { content: "review 🎉 done" }; // 🎉 = F0 9F 8E 89
    const line = JSON.stringify(obj);
    const buf = Buffer.from(line, "utf8");
    const f0 = buf.indexOf(0xf0);
    expect(f0).toBeGreaterThan(0);
    // split 2+2 across chunks, no trailing newline.
    const captured = await runSplitter([buf.subarray(0, f0 + 2), buf.subarray(f0 + 2)]);

    expect(captured.limitExceeded).toBe(0);
    expect(captured.ended).toBe(1);
    expect(captured.lines).toHaveLength(1);
    const received = captured.lines[0];
    expect(received).toBe(line);
    expect(received).not.toContain("�");
    expect(JSON.parse(received)).toEqual(obj);
  });

  it("skips empty and whitespace-only lines, passes real lines verbatim", async () => {
    const captured = await runSplitter([Buffer.from("\n  \nreal\n", "utf8")]);

    expect(captured.limitExceeded).toBe(0);
    expect(captured.ended).toBe(1);
    expect(captured.lines).toEqual(["real"]);
  });

  it("a single line exceeding the byte limit triggers onLimitExceeded once, no onLine/onEnd", async () => {
    // LIMITS.ndjsonLineBytes + 1 bytes, single line, no newline.
    const over = Buffer.alloc(LIMITS.ndjsonLineBytes + 1, 0x61 /* "a" */);
    const captured = await runSplitter([over]);

    expect(captured.limitExceeded).toBe(1);
    expect(captured.lines).toHaveLength(0);
    expect(captured.ended).toBe(0);
  });
});
