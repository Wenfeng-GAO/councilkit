import type { Readable } from "node:stream";
import { LIMITS } from "@shared/runtime/contracts";

/**
 * Bounded NDJSON splitter for driver stdio. A single line may not exceed
 * LIMITS.ndjsonLineBytes; a violation terminates only the owning Participant's
 * stream with a structured protocol failure — never the Host.
 */
export interface NdjsonConsumer {
  onLine(line: string): void;
  onLimitExceeded(): void;
  onEnd(): void;
}

export function attachNdjsonSplitter(stream: Readable, consumer: NdjsonConsumer): void {
  // Raw byte accumulator. Decoding each chunk independently with toString("utf8")
  // would replace a multi-byte character split across pipe chunks with U+FFFD.
  // Byte 0x0a (ASCII newline) never appears inside a multi-byte UTF-8 sequence,
  // so splitting on it at the byte level is safe; each COMPLETE line is decoded
  // once with toString("utf8") so split characters reassemble correctly. See the
  // StringDecoder precedent in cli/src/auto/driver-commands.ts.
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let overflow = false;

  stream.on("data", (chunk: Buffer | string) => {
    if (overflow) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
    let index = buffer.indexOf(0x0a);
    while (index !== -1) {
      const lineBuf = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (lineBuf.length > LIMITS.ndjsonLineBytes) {
        overflow = true;
        consumer.onLimitExceeded();
        return;
      }
      const line = lineBuf.toString("utf8");
      if (line.trim().length > 0) {
        consumer.onLine(line);
      }
      index = buffer.indexOf(0x0a);
    }
    if (buffer.length > LIMITS.ndjsonLineBytes) {
      overflow = true;
      consumer.onLimitExceeded();
    }
  });

  stream.on("end", () => {
    if (!overflow) {
      const tail = buffer.toString("utf8").trim();
      if (tail.length > 0) consumer.onLine(buffer.toString("utf8"));
      consumer.onEnd();
    }
  });
}

/** Race a promise against a bounded deadline. */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}
