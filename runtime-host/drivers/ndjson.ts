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
  let buffer = "";
  let overflow = false;

  stream.on("data", (chunk: Buffer | string) => {
    if (overflow) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > LIMITS.ndjsonLineBytes) {
        overflow = true;
        consumer.onLimitExceeded();
        return;
      }
      if (line.trim().length > 0) {
        consumer.onLine(line);
      }
      index = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer, "utf8") > LIMITS.ndjsonLineBytes) {
      overflow = true;
      consumer.onLimitExceeded();
    }
  });

  stream.on("end", () => {
    if (!overflow) {
      const tail = buffer.trim();
      if (tail.length > 0) consumer.onLine(buffer);
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
