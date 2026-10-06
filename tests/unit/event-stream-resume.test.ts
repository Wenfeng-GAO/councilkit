import { followExecutionEvents } from "@/runtime/event-stream";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import type { RuntimeEvent } from "@shared/runtime/events";
import { afterEach, describe, expect, it } from "vitest";

const EXECUTION_ID = "exec-1";

function frame(event: RuntimeEvent): string {
  return `event: runtime\ndata: ${JSON.stringify(event)}\n\n`;
}

function delta(seq: number, text: string): RuntimeEvent {
  return {
    type: "output.delta",
    executionId: EXECUTION_ID,
    seq,
    at: "2026-10-06T00:00:00.000Z",
    text,
  };
}

function sse(body: string): typeof fetch {
  return async () => new Response(body, { status: 200 });
}

describe("followExecutionEvents resume cursor", () => {
  afterEach(() => {
    useRuntimeDiscussionStore.setState({ previewByExecution: {} });
  });

  it("does not repeat earlier preview text after a heartbeat-only reconnect", async () => {
    const apply = (event: RuntimeEvent) => {
      useRuntimeDiscussionStore.getState().applyPreview("room-1", event);
    };

    await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events?afterSeq=0", headers: {} },
      fetchFn: sse(frame(delta(1, "Hello"))),
      onEvent: apply,
    });
    expect(useRuntimeDiscussionStore.getState().previewByExecution[EXECUTION_ID]).toBe("Hello");

    const quiet = await followExecutionEvents({
      fetchInput: { url: "http://127.0.0.1/events?afterSeq=1", headers: {} },
      fetchFn: sse(": hb\n\n"),
      onEvent: apply,
    });
    const resumeAt = quiet.kind === "closed" ? quiet.lastSeq : 0;
    const replay = [delta(1, "Hello"), delta(2, "!")]
      .filter((event) => event.seq > resumeAt)
      .map((event) => frame(event))
      .join("");
    await followExecutionEvents({
      fetchInput: { url: `http://127.0.0.1/events?afterSeq=${resumeAt}`, headers: {} },
      fetchFn: sse(replay),
      onEvent: apply,
    });

    expect(useRuntimeDiscussionStore.getState().previewByExecution[EXECUTION_ID]).toBe("Hello!");
  });
});
