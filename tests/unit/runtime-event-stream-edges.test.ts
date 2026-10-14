import { EventStreamError, followExecutionEvents } from "@/runtime/event-stream";
import type { RuntimeEvent } from "@shared/runtime/events";
import { afterEach, describe, expect, it, vi } from "vitest";

const EXECUTION_ID = "exec-1";
const AT = "2026-10-06T00:00:00.000Z";

function delta(seq: number, text: string): RuntimeEvent {
  return { type: "output.delta", executionId: EXECUTION_ID, seq, at: AT, text };
}

function completed(seq: number): RuntimeEvent {
  return {
    type: "completed",
    executionId: EXECUTION_ID,
    seq,
    at: AT,
    output: "done",
    requestedModel: "gpt-5",
    effectiveModel: "gpt-5",
    modelVerdict: "match",
    toolState: "none",
    dispatchState: "accepted",
    usage: null,
    finalSeq: seq,
  };
}

function frame(event: RuntimeEvent): string {
  return `event: runtime\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamResponse(
  chunks: string[],
  options?: { status?: number; cancelError?: Error; onPull?: () => void },
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      options?.onPull?.();
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index] ?? ""));
      index += 1;
      if (index >= chunks.length) controller.close();
    },
    cancel() {
      if (options?.cancelError) return Promise.reject(options.cancelError);
    },
  });
  return new Response(stream, { status: options?.status ?? 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("followExecutionEvents", () => {
  it("uses global fetch, reassembles a split frame, and ignores non-runtime blocks", async () => {
    const payload = frame(delta(1, "Hello"));
    const mid = 8;
    const seen: RuntimeEvent[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(`: hb\n\n${payload.slice(0, mid)}`));
              controller.enqueue(encoder.encode(payload.slice(mid)));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await followExecutionEvents({
      fetchInput: {
        url: "http://127.0.0.1/events?foo=1&afterSeq=0",
        headers: { Accept: "text/event-stream" },
      },
      onEvent: async (event) => {
        await Promise.resolve();
        seen.push(event);
      },
    });

    expect(fetchMock.mock.calls).toEqual([
      [
        "http://127.0.0.1/events?foo=1&afterSeq=0",
        {
          headers: { Accept: "text/event-stream" },
          signal: null,
        },
      ],
    ]);
    expect(seen).toEqual([delta(1, "Hello")]);
    expect(outcome).toEqual({ kind: "closed", lastSeq: 1 });
  });

  it("returns the terminal event and does not read the following chunk", async () => {
    let pulls = 0;
    const fetchFn: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            const encoder = new TextEncoder();
            if (pulls === 1) {
              controller.enqueue(encoder.encode(frame(completed(2))));
              return;
            }
            controller.enqueue(encoder.encode(frame(delta(3, "late"))));
            controller.close();
          },
        }),
        { status: 200 },
      );
    const seen: string[] = [];

    const outcome = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events?afterSeq=1#tail", headers: {} },
      fetchFn,
      onEvent: (event) => {
        seen.push(event.type);
      },
    });

    expect(seen).toEqual(["completed"]);
    expect(outcome).toEqual({ kind: "terminal", event: completed(2) });
  });

  it("keeps the afterSeq cursor when the only event has a lower seq", async () => {
    const seen: number[] = [];
    const outcome = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events?afterSeq=5", headers: {} },
      fetchFn: async () => streamResponse([frame(delta(1, "old"))]),
      onEvent: (event) => {
        seen.push(event.seq);
      },
    });

    expect(seen).toEqual([1]);
    expect(outcome).toEqual({ kind: "closed", lastSeq: 5 });
  });

  it("treats a missing, empty, or non-canonical afterSeq as 0", async () => {
    const urls = [
      "http://127.0.0.1/events",
      "http://127.0.0.1/events?foo=1",
      "http://127.0.0.1/events?afterSeq=",
      "http://127.0.0.1/events?afterSeq=2abc",
      "http://127.0.0.1/events?afterSeq=08",
      "http://127.0.0.1/events?afterSeq=9007199254740993",
    ];
    const outcomes = [];
    for (const url of urls) {
      outcomes.push(
        await followExecutionEvents({
          fetchInput: { url, headers: {} },
          fetchFn: async () => streamResponse([": hb\n\n", "event: runtime\n\n"]),
          onEvent: () => {
            throw new Error(`onEvent should not run for ${url}`);
          },
        }),
      );
    }

    expect(outcomes).toEqual([
      { kind: "closed", lastSeq: 0 },
      { kind: "closed", lastSeq: 0 },
      { kind: "closed", lastSeq: 0 },
      { kind: "closed", lastSeq: 0 },
      { kind: "closed", lastSeq: 0 },
      { kind: "closed", lastSeq: 0 },
    ]);
  });

  it("returns aborted when the signal is already aborted and the stream ends", async () => {
    const controller = new AbortController();
    controller.abort();
    let seenSignal: AbortSignal | null = null;

    const outcome = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events?afterSeq=7", headers: {} },
      signal: controller.signal,
      fetchFn: async (_input, init) => {
        seenSignal = (init?.signal as AbortSignal | null) ?? null;
        return streamResponse([""]);
      },
      onEvent: () => {
        throw new Error("onEvent should not run");
      },
    });

    expect(seenSignal).toBe(controller.signal);
    expect(outcome).toEqual({ kind: "aborted", lastSeq: 7 });
  });

  it("prefers a terminal event over an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events?afterSeq=1", headers: {} },
      signal: controller.signal,
      fetchFn: async () => streamResponse([frame(completed(4))]),
      onEvent: () => undefined,
    });

    expect(outcome).toEqual({ kind: "terminal", event: completed(4) });
  });

  it("rethrows AbortError from fetch and from the reader", async () => {
    const fetchAbort = new Error("The operation was aborted");
    fetchAbort.name = "AbortError";
    const readAbort = new Error("The operation was aborted");
    readAbort.name = "AbortError";

    const fetchError = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events", headers: {} },
      fetchFn: async () => {
        throw fetchAbort;
      },
      onEvent: () => undefined,
    }).catch((error: unknown) => error);

    const readError = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events", headers: {} },
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            pull() {
              throw readAbort;
            },
          }),
          { status: 200 },
        ),
      onEvent: () => undefined,
    }).catch((error: unknown) => error);

    expect(fetchError).toBe(fetchAbort);
    expect(readError).toBe(readAbort);
  });

  it("wraps fetch and read failures in EventStreamError", async () => {
    const hungUp = new Error("socket hang up");
    const blank = new Error("");
    const cases: Array<{ label: string; run: () => Promise<unknown> }> = [
      {
        label: "fetch message",
        run: () =>
          followExecutionEvents({
            fetchInput: { url: "http://127.0.0.1/events", headers: {} },
            fetchFn: async () => {
              throw hungUp;
            },
            onEvent: () => undefined,
          }),
      },
      {
        label: "fetch non-error",
        run: () =>
          followExecutionEvents({
            fetchInput: { url: "http://127.0.0.1/events", headers: {} },
            fetchFn: async () => {
              throw "offline";
            },
            onEvent: () => undefined,
          }),
      },
      {
        label: "http",
        run: () =>
          followExecutionEvents({
            fetchInput: { url: "http://127.0.0.1/events", headers: {} },
            fetchFn: async () => new Response("nope", { status: 503 }),
            onEvent: () => undefined,
          }),
      },
      {
        label: "missing body",
        run: () =>
          followExecutionEvents({
            fetchInput: { url: "http://127.0.0.1/events", headers: {} },
            fetchFn: async () => ({ ok: true, status: 200, body: null }) as unknown as Response,
            onEvent: () => undefined,
          }),
      },
      {
        label: "read message",
        run: () =>
          followExecutionEvents({
            fetchInput: { url: "http://127.0.0.1/events", headers: {} },
            fetchFn: async () =>
              new Response(
                new ReadableStream({
                  pull() {
                    throw blank;
                  },
                }),
                { status: 200 },
              ),
            onEvent: () => undefined,
          }),
      },
      {
        label: "read non-error",
        run: () =>
          followExecutionEvents({
            fetchInput: { url: "http://127.0.0.1/events", headers: {} },
            fetchFn: async () =>
              new Response(
                new ReadableStream({
                  pull() {
                    throw "read-boom";
                  },
                }),
                { status: 200 },
              ),
            onEvent: () => undefined,
          }),
      },
    ];

    const results = [];
    for (const item of cases) {
      const error = await item.run().catch((caught: unknown) => caught);
      results.push({
        label: item.label,
        name: error instanceof Error ? error.name : "",
        status: error instanceof EventStreamError ? error.status : -1,
        message: error instanceof Error ? error.message : "",
      });
    }

    expect(results).toEqual([
      { label: "fetch message", name: "EventStreamError", status: 0, message: "socket hang up" },
      {
        label: "fetch non-error",
        name: "EventStreamError",
        status: 0,
        message: "event stream fetch failed",
      },
      { label: "http", name: "EventStreamError", status: 503, message: "event stream HTTP 503" },
      {
        label: "missing body",
        name: "EventStreamError",
        status: 200,
        message: "event stream HTTP 200",
      },
      {
        label: "read message",
        name: "EventStreamError",
        status: 0,
        message: "event stream read failed",
      },
      {
        label: "read non-error",
        name: "EventStreamError",
        status: 0,
        message: "event stream read failed",
      },
    ]);
  });

  it("still resolves when cancelling the reader rejects", async () => {
    const outcome = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events?afterSeq=2", headers: {} },
      fetchFn: async () =>
        streamResponse([frame(delta(3, "ok"))], { cancelError: new Error("cancel-failed") }),
      onEvent: () => undefined,
    });

    expect(outcome).toEqual({ kind: "closed", lastSeq: 3 });
  });

  it("rejects an invalid runtime payload", async () => {
    const error = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events", headers: {} },
      fetchFn: async () => streamResponse(['event: runtime\ndata: {"type":"nope"}\n\n']),
      onEvent: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ZodError");
  });
});
