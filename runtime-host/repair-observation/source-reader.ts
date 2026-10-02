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
  earlierOffset: number | null;
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
      earlierOffset: null,
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
  let scanStart = 0;
  let windowAligned = true;

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
      earlierOffset: null,
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
      scanStart = start;
      const result = readForward(fd, start, st.size, input, dropPartialFirst, input.limitRecords);
      records.push(...result.records);
      partialBadLines += result.partialBadLines;
      isolatedOversize += result.isolatedOversize;
      incompleteTail = result.incompleteTail;
      nextOffset = result.nextOffset;
    } else {
      const end = input.fromOffset ?? st.size;
      const window = earlierWindowStart(fd, end);
      const start = window.start;
      windowAligned = window.aligned;
      scanStart = start;
      const result = readForward(fd, start, end, input, !window.aligned, Number.POSITIVE_INFINITY);
      records.push(...result.records);
      partialBadLines += result.partialBadLines;
      isolatedOversize += result.isolatedOversize;
      incompleteTail = false;
      nextOffset = start;
    }
  } finally {
    closeSync(fd);
  }

  const page =
    input.direction === "earlier"
      ? records.slice(Math.max(0, records.length - input.limitRecords))
      : records.slice(0, input.limitRecords);
  if (input.direction === "earlier" && page[0]) {
    nextOffset = page[0].byteOffset;
  }
  const first = page[0];
  const droppedEarlierRecords = input.direction === "earlier" && records.length > page.length;
  const openedOnIsolatedLine = records.length === 0 && isolatedOversize > 0;
  const isolatedLineResume =
    scanStart > 0 && (!windowAligned || openedOnIsolatedLine) ? scanStart : null;
  const earlierOffset =
    isolatedLineResume ??
    (first && first.byteOffset > 0 && (scanStart > 0 || droppedEarlierRecords)
      ? first.byteOffset
      : null);

  return {
    records: page,
    generation,
    nextOffset,
    exhausted: nextOffset >= st.size && !incompleteTail,
    partialBadLines,
    isolatedOversize,
    reset,
    incompleteTail,
    unreadable: false,
    earlierOffset,
  };
}

const READ_CHUNK = 64 * 1024;

function earlierWindowStart(fd: number, end: number): { start: number; aligned: boolean } {
  const windowStart = Math.max(0, end - INITIAL_TAIL_BYTES);
  if (windowStart === 0) return { start: 0, aligned: true };
  const prev = Buffer.alloc(1);
  if (readSync(fd, prev, 0, 1, windowStart - 1) === 1 && prev[0] === 0x0a) {
    return { start: windowStart, aligned: true };
  }
  const floor = Math.max(0, windowStart - REPAIR_OBS_LINE_ISOLATE);
  let pos = windowStart;
  while (pos > floor) {
    const chunkStart = Math.max(floor, pos - READ_CHUNK);
    const len = pos - chunkStart;
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, chunkStart);
    if (got <= 0) break;
    for (let i = got - 1; i >= 0; i -= 1) {
      if (buf[i] === 0x0a) return { start: chunkStart + i + 1, aligned: true };
    }
    pos = chunkStart;
  }
  return { start: floor, aligned: floor === 0 };
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
  limitRecords: number,
): {
  records: RawSourceRecord[];
  nextOffset: number;
  partialBadLines: number;
  isolatedOversize: number;
  incompleteTail: boolean;
} {
  const records: RawSourceRecord[] = [];
  let partialBadLines = 0;
  let isolatedOversize = 0;
  let incompleteTail = false;
  let pos = start;
  let carry = Buffer.alloc(0);
  let skippingPartial = dropPartialFirst && start > 0;
  let countedOversize = false;
  let committed = start;

  const accept = (lineBuf: Buffer, lineStart: number) => {
    if (lineBuf.length > REPAIR_OBS_LINE_ISOLATE) {
      isolatedOversize += 1;
      return;
    }
    const parsed = parsePublicSourceLine(lineBuf.toString("utf8"), {
      sourceId: meta.sourceId,
      sourceGeneration: "pending",
      executionRef: meta.executionRef,
      round: meta.round,
      roleKey: meta.roleKey,
      byteOffset: lineStart,
      receivedAt: meta.receivedAt,
    });
    if (parsed === "skip") return;
    if (parsed === "bad") {
      partialBadLines += 1;
      return;
    }
    if (parsed.text) parsed.text = redactObservationText(parsed.text);
    if (parsed.summary) parsed.summary = redactObservationText(parsed.summary);
    if (parsed.detail) parsed.detail = redactObservationText(parsed.detail);
    if (parsed.path) parsed.path = redactObservationText(parsed.path);
    records.push(parsed);
  };

  while (pos < end && records.length < limitRecords) {
    const want = Math.min(READ_CHUNK, end - pos);
    const buf = Buffer.alloc(want);
    const n = readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    const chunk = buf.subarray(0, n);
    const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    const dataStart = pos - carry.length;
    pos += n;
    carry = Buffer.alloc(0);

    let cursor = 0;
    if (skippingPartial) {
      const nl = data.indexOf(0x0a);
      if (nl === -1) {
        if (data.length > REPAIR_OBS_LINE_ISOLATE) {
          if (!countedOversize) {
            isolatedOversize += 1;
            countedOversize = true;
          }
        } else {
          carry = Buffer.from(data);
        }
        continue;
      }
      cursor = nl + 1;
      skippingPartial = false;
      countedOversize = false;
      committed = dataStart + cursor;
    }

    while (cursor < data.length && records.length < limitRecords) {
      const nl = data.indexOf(0x0a, cursor);
      if (nl === -1) break;
      accept(data.subarray(cursor, nl), dataStart + cursor);
      cursor = nl + 1;
      committed = dataStart + cursor;
    }

    if (records.length >= limitRecords) break;

    const rest = data.subarray(cursor);
    if (rest.length > REPAIR_OBS_LINE_ISOLATE) {
      if (!countedOversize) {
        isolatedOversize += 1;
        countedOversize = true;
      }
      skippingPartial = true;
    } else if (rest.length > 0) {
      carry = Buffer.from(rest);
    }
  }

  if (records.length < limitRecords && (carry.length > 0 || skippingPartial)) {
    incompleteTail = true;
  }

  return {
    records,
    nextOffset: committed,
    partialBadLines,
    isolatedOversize,
    incompleteTail,
  };
}

function incompleteUtf8Tail(buf: Buffer): number {
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && cont < 3) {
    const byte = buf[i];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    cont += 1;
    i -= 1;
  }
  if (i < 0) return 0;
  const lead = buf[i];
  if (lead === undefined) return 0;
  let need = 0;
  if ((lead & 0xe0) === 0xc0) need = 2;
  else if ((lead & 0xf0) === 0xe0) need = 3;
  else if ((lead & 0xf8) === 0xf0) need = 4;
  else return 0;
  const have = buf.length - i;
  return have < need ? have : 0;
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
    const cursorOffset = input.cursorOffset > 0 ? input.cursorOffset : 0;
    const start = input.byteOffset + cursorOffset;
    const lineEndLimit = input.byteOffset + REPAIR_OBS_LINE_ISOLATE;
    if (start >= st.size || start >= lineEndLimit) {
      return { body: "", nextCursor: null, truncated: false };
    }
    const size = Math.min(input.chunkSize, st.size - start, lineEndLimit - start);
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, start);
    const slice = buf.subarray(0, n);
    const nl = slice.indexOf(0x0a);
    const lineEnd = nl === -1 ? slice.length : nl;
    const more = nl === -1 && start + n < Math.min(st.size, lineEndLimit);
    const held = more ? incompleteUtf8Tail(slice.subarray(0, lineEnd)) : 0;
    const consumed = held > 0 && held < lineEnd ? lineEnd - held : lineEnd;
    const body = redactObservationText(slice.subarray(0, consumed).toString("utf8"));
    return {
      body,
      nextCursor: more ? String(cursorOffset + consumed) : null,
      truncated: more,
    };
  } finally {
    closeSync(fd);
  }
}
