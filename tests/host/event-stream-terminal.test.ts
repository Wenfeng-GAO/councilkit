import type { DriverEvent } from "@host/drivers/types";
import type { ExecutionRegistry } from "@host/executions/execution-registry";
import { createExecutionRegistry } from "@host/executions/execution-registry";
import { scopeRoutes } from "@host/routes/scopes";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "./helpers";

/**
 * A finished execution has no future events. The SSE response must end after
 * replay (including a cursor that is already caught up, and a tombstone whose
 * buffer was released). A follower that waits for the body otherwise blocks
 * until its own deadline — the discussion orchestrator has none.
 */

let host: TestHost | null = null;
let registry: ExecutionRegistry | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
  registry = null;
});

const COMPLETED: DriverEvent = {
  type: "completed",
  output: "done",
  requestedModel: "model-a",
  effectiveModel: "model-a",
  modelVerdict: "match",
  toolState: "none",
  dispatchState: "accepted",
  usage: null,
  finalSeq: 1,
};

async function boot(): Promise<void> {
  host = await createTestHost({
    routesFactory: (services) => {
      registry = createExecutionRegistry({ logger: services.logger });
      services.executionRegistry = registry;
      return scopeRoutes(services);
    },
  });
}

function eventsUrl(executionId: string, afterSeq: number): string {
  if (!host) throw new Error("host not booted");
  return `${host.baseUrl}/api/v1/scopes/scope-1/executions/${executionId}/events?afterSeq=${afterSeq}`;
}

async function readBody(
  res: Response,
  timeoutMs: number,
): Promise<{ done: boolean; text: string }> {
  if (!res.body) throw new Error("no SSE body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), remaining);
        }),
      ]);
      if (chunk === "timeout") return { done: false, text };
      text += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      if (chunk.done) return { done: true, text };
    }
    return { done: false, text };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

describe("finished execution event streams", () => {
  it("ends when the cursor is already past the terminal event", async () => {
    await boot();
    const reg = registry as ExecutionRegistry;
    reg.begin("exec-caught-up", "p-1", "scope-1");
    const terminal = reg.emit("exec-caught-up", COMPLETED);
    if (!terminal) throw new Error("expected a terminal event");
    const res = await fetch(eventsUrl("exec-caught-up", terminal.seq), {
      headers: authedHeaders(host as TestHost),
    });
    expect(res.status).toBe(200);
    const body = await readBody(res, 500);
    expect(body.done).toBe(true);
    expect(body.text).not.toContain("event: runtime");
    expect(reg.eventConnectionCount()).toBe(0);
  });

  it("ends after ACK releases the buffer, even from afterSeq 0", async () => {
    await boot();
    const reg = registry as ExecutionRegistry;
    reg.begin("exec-tombstone", "p-1", "scope-1");
    const terminal = reg.emit("exec-tombstone", COMPLETED);
    if (!terminal) throw new Error("expected a terminal event");
    expect(reg.ack("exec-tombstone", terminal.seq, "committed").outcome).toBe("acknowledged");
    const res = await fetch(eventsUrl("exec-tombstone", 0), {
      headers: authedHeaders(host as TestHost),
    });
    expect(res.status).toBe(200);
    const body = await readBody(res, 500);
    expect(body.done).toBe(true);
    expect(body.text).not.toContain("event: runtime");
    expect(reg.eventConnectionCount()).toBe(0);
  });

  it("ends a live stream once the terminal event is written", async () => {
    await boot();
    const reg = registry as ExecutionRegistry;
    reg.begin("exec-live", "p-1", "scope-1");
    reg.emit("exec-live", { type: "started", requestedModel: "model-a" });
    const pending = (async () => {
      const res = await fetch(eventsUrl("exec-live", 0), {
        headers: authedHeaders(host as TestHost),
      });
      expect(res.status).toBe(200);
      return readBody(res, 1_000);
    })();
    const started = Date.now();
    while (reg.eventConnectionCount() === 0 && Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(reg.eventConnectionCount()).toBe(1);
    reg.emit("exec-live", COMPLETED);
    const body = await pending;
    expect(body.done).toBe(true);
    expect(body.text).toContain('"type":"completed"');
    expect(reg.eventConnectionCount()).toBe(0);
  });

  it("keeps a running execution open", async () => {
    await boot();
    const reg = registry as ExecutionRegistry;
    reg.begin("exec-running", "p-1", "scope-1");
    reg.emit("exec-running", { type: "started", requestedModel: "model-a" });
    const res = await fetch(eventsUrl("exec-running", 0), {
      headers: authedHeaders(host as TestHost),
    });
    expect(res.status).toBe(200);
    const body = await readBody(res, 200);
    expect(body.done).toBe(false);
    expect(body.text).toContain('"type":"started"');
    expect(reg.eventConnectionCount()).toBe(1);
  });
});
