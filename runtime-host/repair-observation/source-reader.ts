/**
 * Bounded JSONL source reader for repair observation.
 * Tail/range reads, incomplete trailing lines held back, bad lines skipped.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  REPAIR_OBS_LINE_ISOLATE,
  fingerprintSource,
  parsePublicSourceLine,
  type RawSourceRecord,
  redactObservationText,
} from "@shared/runtime/repair-observation";

export type SourceReadResult = {
  records: RawSourceRecord[];
  generation: string;
  nextOffset: number;
  exhausted: boolean;
  partialBadLines: number;
  isolatedOversize: number;
  reset: boolean;
  incompleteTail: boolean;
  unreadable: boolean;
};

const INITIAL_TAIL_BYTES = 512 * 1024;

export function readSourceWindow(input: {
  path: string;
  sourceId: string;
  executionRef: string;
  round: number;
  roleKey: string;
  expectedGeneration: string | null;
  fromOffset: number | null;
  receivedAt: string;
  limitRecords: number;
  direction: "forward" | "earlier";
}): SourceReadResult {
  let st;
  try {
    st = statSync(input.path);
  } catch {
    return {
      records: [],
      generation: input.expectedGeneration ?? "missing",
      nextOffset: input.fromOffset ?? 0,
      exhausted: true,
      partialBadLines: 0,
      isolatedOversize: 0,
      reset: false,
      incompleteTail: false,
      unreadable: false,
    };
  }
  const generation = fingerprintSource({
    size: st.size,
    mtimeMs: st.mtimeMs,
    ino: typeof st.ino === "number" ? st.ino : null,
  });
  let reset = false;
  if (input.expectedGeneration && input.expectedGeneration !== generation) {
    reset = true;
  }
  if (input.fromOffset !== null && input.fromOffset > st.size) {
    reset = true;
  }

  const records: RawSourceRecord[] = [];
  let partialBadLines = 0;
  let isolatedOversize = 0;
  let incompleteTail = false;
  let nextOffset = 0;

  let fd: number;
  try {
    fd = openSync(input.path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      records: [],
      generation,
      nextOffset: input.fromOffset ?? 0,
      exhausted: true,
      partialBadLines: 0,
      isolatedOversize: 0,
      reset,
      incompleteTail: false,
      unreadable: code === "EACCES" || code === "EPERM",
    };
  }
  try {
    if (input.direction === "forward") {
      const coldTail = reset || input.fromOffset === null;
      const start = coldTail
        ? Math.max(0, st.size - INITIAL_TAIL_BYTES)
        : input.fromOffset!;
      // Cold mid-file tails may start inside a line; committed cursors are
      // always on a line boundary and must not drop the next complete record.
      const dropPartialFirst = coldTail && start > 0;
      const result = readForward(fd, start, st.size, input, dropPartialFirst);
      records.push(...result.records);
      partialBadLines += result.partialBadLines;
      isolatedOversize += result.isolatedOversize;
      incompleteTail = result.incompleteTail;
      nextOffset = result.nextOffset;
    } else {
      const end = input.fromOffset ?? st.size;
      const start = Math.max(0, end - INITIAL_TAIL_BYTES);
      const result = readForward(fd, start, end, input, start > 0);
      records.push(...result.records);
      partialBadLines += result.partialBadLines;
      isolatedOversize += result.isolatedOversize;
      incompleteTail = false;
      nextOffset = start;
    }
  } finally {
    closeSync(fd);
  }

  return {
    records: records.slice(0, input.limitRecords),
    generation,
    nextOffset,
    exhausted: nextOffset >= st.size && !incompleteTail,
    partialBadLines,
    isolatedOversize,
    reset,
    incompleteTail,
    unreadable: false,
  };
}

function readForward(
  fd: number,
  start: number,
  end: number,
  meta: {
    sourceId: string;
    executionRef: string;
    round: number;
    roleKey: string;
    receivedAt: string;
  },
  dropPartialFirst: boolean,
): {
  records: RawSourceRecord[];
  nextOffset: number;
  partialBadLines: number;
  isolatedOversize: number;
  incompleteTail: boolean;
} {
  const length = Math.max(0, end - start);
  const buf = Buffer.alloc(length);
  const bytesRead = readSync(fd, buf, 0, length, start);
  const slice = buf.subarray(0, bytesRead);
  const text = slice.toString("utf8");
  const records: RawSourceRecord[] = [];
  let partialBadLines = 0;
  let isolatedOversize = 0;
  let incompleteTail = false;
  let committed = 0;

  let searchFrom = 0;
  if (dropPartialFirst && start > 0) {
    const firstNl = text.indexOf("\n");
    if (firstNl === -1) {
      return {
        records: [],
        nextOffset: start,
        partialBadLines: 0,
        isolatedOversize: 0,
        incompleteTail: true,
      };
    }
    searchFrom = firstNl + 1;
    committed = searchFrom;
  }

  let lineStart = searchFrom;
  while (lineStart < text.length) {
    const nl = text.indexOf("\n", lineStart);
    if (nl === -1) {
      incompleteTail = true;
      break;
    }
    const line = text.slice(lineStart, nl);
    const absoluteOffset = start + lineStart;
    const lineBytes = Buffer.byteLength(line, "utf8");
    committed = nl + 1;
    lineStart = nl + 1;

    if (lineBytes > REPAIR_OBS_LINE_ISOLATE) {
      isolatedOversize += 1;
      continue;
    }
    const parsed = parsePublicSourceLine(line, {
      sourceId: meta.sourceId,
      sourceGeneration: "pending",
      executionRef: meta.executionRef,
      round: meta.round,
      roleKey: meta.roleKey,
      byteOffset: absoluteOffset,
      receivedAt: meta.receivedAt,
    });
    if (parsed === "skip") continue;
    if (parsed === "bad") {
      partialBadLines += 1;
      continue;
    }
    if (parsed.text) parsed.text = redactObservationText(parsed.text);
    if (parsed.summary) parsed.summary = redactObservationText(parsed.summary);
    if (parsed.detail) parsed.detail = redactObservationText(parsed.detail);
    if (parsed.path) parsed.path = redactObservationText(parsed.path);
    records.push(parsed);
  }

  return {
    records,
    nextOffset: start + committed,
    partialBadLines,
    isolatedOversize,
    incompleteTail,
  };
}

export function readDetailChunk(input: {
  path: string;
  byteOffset: number;
  cursorOffset: number;
  chunkSize: number;
}): { body: string; nextCursor: string | null; truncated: boolean } {
  const fd = openSync(input.path, "r");
  try {
    const st = statSync(input.path);
    const start = input.byteOffset + input.cursorOffset;
    if (start >= st.size) return { body: "", nextCursor: null, truncated: false };
    const size = Math.min(input.chunkSize, st.size - start);
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, start);
    const body = redactObservationText(buf.subarray(0, n).toString("utf8"));
    const next = start + n;
    const truncated = next < st.size;
    return {
      body,
      nextCursor: truncated ? String(input.cursorOffset + n) : null,
      truncated,
    };
  } finally {
    closeSync(fd);
  }
}
