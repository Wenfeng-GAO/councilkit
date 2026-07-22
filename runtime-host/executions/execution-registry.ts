import { LIMITS } from "@shared/runtime/contracts";
import type { AckDisposition, ExecutionState } from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";
import { type RuntimeEvent, isTerminalEvent, runtimeEventSchema } from "@shared/runtime/events";
import type { DriverEvent } from "../drivers/types";
import type { Logger } from "../logging";

/**
 * Execution registry: the Host-side temporary fact store for Model
 * Executions. Assigns strictly increasing `seq` per execution, bounds the
 * event buffer (coalescing early deltas into an `output.snapshot` under
 * pressure while always keeping the terminal event and its full output),
 * supports `afterSeq` resume (strictly greater-than), and keeps lightweight
 * ACK tombstones after payloads are released. A Host restart loses this
 * store by design — callers then converge to `expired`, never re-execute.
 */

export interface ExecutionRecord {
  executionId: string;
  participantId: string;
  scopeId: string;
  state: ExecutionState;
  events: RuntimeEvent[];
  lastSeq: number;
  bufferedBytes: number;
  ackState: "pending" | "acknowledged";
  disposition: AckDisposition | null;
  /** True once an ACK released the payload; repeats return the same outcome. */
  tombstone: boolean;
  terminal: RuntimeEvent | null;
  createdAt: string;
}

export type EventListener = (event: RuntimeEvent) => void;

export interface ExecutionRegistry {
  /** Idempotent: an existing id returns the same record, never re-dispatches. */
  begin(
    executionId: string,
    participantId: string,
    scopeId: string,
  ): { record: ExecutionRecord; created: boolean };
  get(executionId: string): ExecutionRecord | null;
  emit(executionId: string, proto: DriverEvent): RuntimeEvent | null;
  /** Replay seq > afterSeq, then follow live. Returns an unsubscribe fn. */
  follow(executionId: string, afterSeq: number, listener: EventListener): (() => void) | null;
  ack(
    executionId: string,
    finalSeq: number,
    disposition: AckDisposition,
  ): {
    outcome: "acknowledged" | "expired" | "conflict";
    disposition: AckDisposition | null;
    error?: RuntimeError;
  };
  runningCount(): number;
  eventConnectionCount(): number;
  releaseScope(scopeId: string): void;
  reset(): void;
}

function eventBytes(event: RuntimeEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export function createExecutionRegistry(_deps: { logger: Logger }): ExecutionRegistry {
  const records = new Map<string, ExecutionRecord>();
  const listeners = new Map<string, Set<EventListener>>();

  function notify(executionId: string, event: RuntimeEvent) {
    const set = listeners.get(executionId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // a broken listener must not affect the execution
      }
    }
  }

  function bufferEvent(record: ExecutionRecord, event: RuntimeEvent) {
    const size = eventBytes(event);
    const terminal = isTerminalEvent(event);

    if (!terminal && record.bufferedBytes + size > LIMITS.executionBufferBytes) {
      // Coalesce all buffered delta/snapshot previews into one snapshot.
      const kept: RuntimeEvent[] = [];
      let preview = "";
      let firstDeltaSeq: number | null = null;
      let firstDeltaIndex: number | null = null;
      for (const existing of record.events) {
        if (existing.type === "output.delta" || existing.type === "output.snapshot") {
          if (firstDeltaSeq === null) {
            // `kept` currently holds only the non-delta events that precede
            // this delta — exactly the index that preserves seq order.
            firstDeltaIndex = kept.length;
            firstDeltaSeq = existing.seq;
          }
          preview += existing.text;
          record.bufferedBytes -= eventBytes(existing);
        } else {
          kept.push(existing);
        }
      }
      if (firstDeltaSeq !== null) {
        const snapshot: RuntimeEvent = {
          executionId: record.executionId,
          seq: firstDeltaSeq,
          at: new Date().toISOString(),
          type: "output.snapshot",
          text: preview,
        };
        kept.splice(firstDeltaIndex ?? 0, 0, snapshot);
        record.bufferedBytes += eventBytes(snapshot);
      }
      record.events = kept;
      // Invariant: after coalescing, record.events must be in non-decreasing
      // seq order so follow() can replay in storage order. Splice places the
      // consolidated snapshot at the first replaced delta's position; verify.
      for (let i = 1; i < record.events.length; i++) {
        if (record.events[i].seq < record.events[i - 1].seq) {
          throw new Error(
            `ExecutionRegistry coalesce invariant violated: seq ${record.events[i - 1].seq} precedes seq ${record.events[i].seq}`,
          );
        }
      }
      // If even after coalescing the new delta cannot fit, drop the delta
      // itself — the terminal event always carries the authoritative output.
      // The dropped event already consumed a seq (allocated in emit before
      // bufferEvent was called); advance lastSeq here so the next emit
      // allocates strictly-next seq and live listeners observe no duplicates.
      if (record.bufferedBytes + size > LIMITS.executionBufferBytes) {
        record.lastSeq = event.seq;
        return;
      }
    }

    record.events.push(event);
    record.bufferedBytes += size;
    record.lastSeq = event.seq;
  }

  return {
    begin(executionId, participantId, scopeId) {
      const existing = records.get(executionId);
      if (existing) {
        return { record: existing, created: false };
      }
      const record: ExecutionRecord = {
        executionId,
        participantId,
        scopeId,
        state: "running",
        events: [],
        lastSeq: 0,
        bufferedBytes: 0,
        ackState: "pending",
        disposition: null,
        tombstone: false,
        terminal: null,
        createdAt: new Date().toISOString(),
      };
      records.set(executionId, record);
      return { record, created: true };
    },

    get(executionId) {
      return records.get(executionId) ?? null;
    },

    emit(executionId, proto) {
      const record = records.get(executionId);
      if (!record || record.tombstone) return null;
      const stamped = {
        ...proto,
        executionId,
        seq: record.lastSeq + 1,
        at: new Date().toISOString(),
      } as RuntimeEvent;
      if (stamped.type === "completed") {
        stamped.finalSeq = stamped.seq;
      }
      const parsed = runtimeEventSchema.safeParse(stamped);
      if (!parsed.success) {
        // Drivers must only emit the known event set; a violation here is a
        // Host-side bug, so fail the execution rather than corrupt the stream.
        const fallback: RuntimeEvent = {
          executionId,
          seq: record.lastSeq + 1,
          at: new Date().toISOString(),
          type: "failed",
          error: makeError("PROTOCOL_VIOLATION", "stream", "driver emitted an invalid event"),
          dispatchState: "unknown",
          toolState: "unknown",
          retryable: false,
        };
        record.state = "failed";
        record.terminal = fallback;
        bufferEvent(record, fallback);
        notify(executionId, fallback);
        return fallback;
      }
      const event = parsed.data;
      if (isTerminalEvent(event)) {
        record.state =
          event.type === "completed"
            ? "completed"
            : event.type === "failed"
              ? "failed"
              : "interrupted";
        record.terminal = event;
      }
      bufferEvent(record, event);
      notify(executionId, event);
      return event;
    },

    follow(executionId, afterSeq, listener) {
      const record = records.get(executionId);
      if (!record) return null;
      for (const event of record.events) {
        if (event.seq > afterSeq) listener(event);
      }
      // Tombstoned or terminal executions have no future events.
      if (record.tombstone || record.terminal) {
        return () => undefined;
      }
      let set = listeners.get(executionId);
      if (!set) {
        set = new Set();
        listeners.set(executionId, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },

    ack(executionId, finalSeq, disposition) {
      const record = records.get(executionId);
      if (!record) {
        // Host restarted or the execution never existed here: converge to
        // expired without ever re-executing.
        return { outcome: "expired", disposition: null };
      }
      if (record.tombstone || record.ackState === "acknowledged") {
        // Repeat ACK after a lost response returns the same terminal outcome.
        if (record.disposition === disposition) {
          return { outcome: "acknowledged", disposition: record.disposition };
        }
        return {
          outcome: "conflict",
          disposition: record.disposition,
          error: makeError(
            "EXECUTION_CONFLICT",
            "commit",
            "ACK disposition differs from the recorded terminal disposition.",
            { executionId },
          ),
        };
      }
      if (!record.terminal) {
        return {
          outcome: "conflict",
          disposition: null,
          error: makeError("EXECUTION_CONFLICT", "commit", "ACK before a terminal event.", {
            executionId,
          }),
        };
      }
      if (record.terminal.seq !== finalSeq) {
        return {
          outcome: "conflict",
          disposition: null,
          error: makeError(
            "EXECUTION_CONFLICT",
            "commit",
            "ACK finalSeq does not match the terminal event.",
            { executionId },
          ),
        };
      }
      record.ackState = "acknowledged";
      record.disposition = disposition;
      // Release the payload, keep the lightweight tombstone.
      record.events = [];
      record.bufferedBytes = 0;
      record.tombstone = true;
      listeners.delete(executionId);
      return { outcome: "acknowledged", disposition };
    },

    runningCount() {
      let count = 0;
      for (const record of records.values()) {
        if (record.state === "running") count += 1;
      }
      return count;
    },

    eventConnectionCount() {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },

    releaseScope(scopeId) {
      for (const [executionId, record] of records) {
        if (record.scopeId === scopeId) {
          records.delete(executionId);
          listeners.delete(executionId);
        }
      }
    },

    reset() {
      records.clear();
      listeners.clear();
    },
  };
}
