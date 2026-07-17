import { type RuntimeEvent, isTerminalEvent, runtimeEventSchema } from "@shared/runtime/events";

/**
 * Execution event stream (U5): SSE framing over authenticated fetch — never
 * EventSource, so the session capability travels normally. Reconnects resume
 * with `afterSeq` (replay is strictly greater-than) and never re-dispatch
 * the model. One `followExecutionEvents` call reads one connection to its
 * end; the caller (Orchestrator) decides when to reconnect.
 */

export interface EventStreamFetchInput {
  url: string;
  headers: Record<string, string>;
}

export interface FollowEventsOptions {
  fetchInput: EventStreamFetchInput;
  onEvent: (event: RuntimeEvent) => void | Promise<void>;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

export type FollowOutcome =
  | { kind: "terminal"; event: RuntimeEvent }
  | { kind: "closed"; lastSeq: number }
  | { kind: "aborted"; lastSeq: number };

class EventStreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EventStreamError";
  }
}

/**
 * Reads one SSE connection: parses `event: runtime` blocks, validates each
 * event against the shared schema, invokes onEvent in order. Resolves with
 * the terminal event, or the last seq when the connection closes first.
 */
export async function followExecutionEvents(options: FollowEventsOptions): Promise<FollowOutcome> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(options.fetchInput.url, {
    headers: options.fetchInput.headers,
    signal: options.signal ?? null,
  });
  if (!response.ok || !response.body) {
    throw new EventStreamError(response.status, `event stream HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastSeq = 0;
  let terminal: RuntimeEvent | null = null;

  const dispatchBlock = async (block: string): Promise<void> => {
    if (!block.includes("event: runtime")) return;
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) return;
    const event = runtimeEventSchema.parse(JSON.parse(dataLine.slice(6)));
    lastSeq = Math.max(lastSeq, event.seq);
    await options.onEvent(event);
    if (isTerminalEvent(event)) terminal = event;
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        await dispatchBlock(block);
        index = buffer.indexOf("\n\n");
      }
      if (terminal) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const finalTerminal: RuntimeEvent | null = terminal;
  if (finalTerminal) return { kind: "terminal", event: finalTerminal };
  if (options.signal?.aborted) return { kind: "aborted", lastSeq };
  return { kind: "closed", lastSeq };
}
