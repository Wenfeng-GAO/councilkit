/**
 * cli/src/host/event-stream.ts re-exports the shared SSE reader. These tests
 * call that binding against a local fetch double — no socket and no fixed port.
 */
import { followExecutionEvents as followFromRuntime } from "@/runtime/event-stream";
import type { RuntimeEvent } from "@shared/runtime/events";
import { describe, expect, it } from "vitest";
import { followExecutionEvents } from "../src/host/event-stream";

const STARTED: RuntimeEvent = {
  type: "started",
  executionId: "exec-aaaaaaaa",
  seq: 1,
  at: "2026-07-22T00:00:00.000Z",
  requestedModel: "model-x",
};

const COMPLETED: RuntimeEvent = {
  type: "completed",
  executionId: "exec-aaaaaaaa",
  seq: 2,
  at: "2026-07-22T00:00:01.000Z",
  output: "from-sse",
  requestedModel: "model-x",
  effectiveModel: null,
  modelVerdict: "mismatch",
  toolState: "active",
  dispatchState: "accepted",
  usage: { inputTokens: 10, outputTokens: 2, costUsd: null },
  finalSeq: 2,
};

function sse(events: RuntimeEvent[]): string {
  return events.map((event) => `event: runtime\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe("host event-stream re-export", () => {
  it("is the runtime followExecutionEvents function", () => {
    expect(followExecutionEvents).toBe(followFromRuntime);
  });

  it("reads a terminal runtime event and reports every event in order", async () => {
    const seen: RuntimeEvent[] = [];
    let requestedUrl = "";
    let accept = "";
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      accept = new Headers(init?.headers).get("accept") ?? "";
      return new Response(sse([STARTED, COMPLETED]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const outcome = await followExecutionEvents({
      fetchInput: {
        url: "http://127.0.0.1/events?afterSeq=0",
        headers: { Accept: "text/event-stream", Cookie: "councilkit_session=abc" },
      },
      onEvent: (event) => {
        seen.push(event);
      },
      fetchFn: fetchFn as typeof fetch,
    });
    expect(requestedUrl).toBe("http://127.0.0.1/events?afterSeq=0");
    expect(accept).toBe("text/event-stream");
    expect(seen).toEqual([STARTED, COMPLETED]);
    expect(outcome).toEqual({ kind: "terminal", event: COMPLETED });
  });

  it("returns closed with the requested afterSeq when the body is empty", async () => {
    const fetchFn = async () => new Response("", { status: 200 });
    const outcome = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events?afterSeq=5", headers: {} },
      onEvent: () => {
        throw new Error("onEvent should not run");
      },
      fetchFn: fetchFn as typeof fetch,
    });
    expect(outcome).toEqual({ kind: "closed", lastSeq: 5 });
  });

  it("throws EventStreamError 401 when the stream is rejected", async () => {
    const fetchFn = async () => new Response("no", { status: 401 });
    let caught: unknown;
    try {
      await followExecutionEvents({
        fetchInput: { url: "http://127.0.0.1/events?afterSeq=2", headers: {} },
        onEvent: () => {},
        fetchFn: fetchFn as typeof fetch,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { status?: number };
    expect(error.name).toBe("EventStreamError");
    expect(error.status).toBe(401);
    expect(error.message).toBe("event stream HTTP 401");
  });

  it("throws EventStreamError 403 for a forbidden stream", async () => {
    const fetchFn = async () => new Response("no", { status: 403 });
    let caught: unknown;
    try {
      await followExecutionEvents({
        fetchInput: { url: "http://127.0.0.1/events?afterSeq=0", headers: {} },
        onEvent: () => {},
        fetchFn: fetchFn as typeof fetch,
      });
    } catch (error) {
      caught = error;
    }
    const error = caught as Error & { status?: number };
    expect(error.name).toBe("EventStreamError");
    expect(error.status).toBe(403);
    expect(error.message).toBe("event stream HTTP 403");
  });
});
