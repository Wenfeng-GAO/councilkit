import "fake-indexeddb/auto";

import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import { createDiscussionAgent } from "@/models/discussion/factories";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Web Lock provider inside createAppRuntime, CSRF document fallback, and the
 * startup-audit failure path. Each test re-imports the module so the singleton
 * starts empty.
 */

const CSRF_SELECTOR = 'meta[name="councilkit-csrf"]';
const CSRF_MESSAGE =
  'runtime bootstrap: missing <meta name="councilkit-csrf"> content — the page must be served by the Runtime Host';

const HEALTH = {
  apiVersion: "v1",
  hostInstanceId: "host-1",
  node: { version: "v22.14.0", major: 22 },
  checkoutPath: "/tmp/ck",
  drivers: [],
};

const healthFetch: typeof fetch = async (input) => {
  if (typeof input !== "string") throw new Error("unexpected fetch input");
  return new Response(JSON.stringify({ ok: true, data: HEALTH }));
};

type LockCallback = (lock: { name: string } | null) => unknown;

interface LockCall {
  name: string;
  options: { ifAvailable?: boolean; signal?: AbortSignal };
}

function stubDocument(token: string): void {
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector === CSRF_SELECTOR ? { getAttribute: () => token } : null,
  });
}

function installLocks(
  behavior:
    | "grant"
    | "deny-then-grant"
    | "deny-then-abort"
    | "deny-then-not-allowed"
    | "reject-error"
    | "reject-string"
    | "try-abort",
  released: string[],
): LockCall[] {
  const calls: LockCall[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request(name: string, options: LockOptions, callback: LockCallback) {
        calls.push({
          name,
          options: {
            ...(options.ifAvailable ? { ifAvailable: true } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          },
        });
        const denyFirst =
          behavior === "deny-then-grant" ||
          behavior === "deny-then-abort" ||
          behavior === "deny-then-not-allowed";
        if (options.ifAvailable && denyFirst) {
          callback(null);
          return Promise.resolve(null);
        }
        if (behavior === "reject-error") return Promise.reject(new Error("locks-down"));
        if (behavior === "reject-string") return Promise.reject("locks-string");
        if (behavior === "try-abort" || behavior === "deny-then-abort") {
          return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
        }
        if (behavior === "deny-then-not-allowed") {
          return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
        }
        const held = callback({ name });
        void Promise.resolve(held).then(() => {
          released.push(name);
        });
        return Promise.resolve({ name });
      },
    },
  });
  return calls;
}

async function loadBootstrap() {
  return import("@/runtime/bootstrap");
}

describe("runtime bootstrap locks and audit", () => {
  let dbs: CouncilKitRuntimeDB[];
  let discussion: typeof import("@/stores/runtime-discussion").useRuntimeDiscussionStore;

  beforeEach(async () => {
    vi.resetModules();
    dbs = [];
    // Re-import after resetModules so assertions see the store the bootstrap wired.
    discussion = (await import("@/stores/runtime-discussion")).useRuntimeDiscussionStore;
    discussion.setState({
      controlByRoom: {},
      previewByExecution: {},
      changeTickByRoom: {},
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const db of dbs) {
      db.close();
      await db.delete();
    }
  });

  function makeDb(): CouncilKitRuntimeDB {
    const db = new CouncilKitRuntimeDB(`test-bootstrap-locks-${crypto.randomUUID()}`);
    dbs.push(db);
    return db;
  }

  it("reads the CSRF meta from document when no document is passed", async () => {
    stubDocument("csrf-from-document");
    const { readCsrfToken } = await loadBootstrap();

    expect(readCsrfToken()).toBe("csrf-from-document");
  });

  it("throws the host message when document is missing", async () => {
    vi.stubGlobal("document", undefined);
    const { readCsrfToken } = await loadBootstrap();
    const explicit = {
      querySelector: () => ({ getAttribute: () => "" }),
    } as Pick<Document, "querySelector">;

    expect(() => readCsrfToken()).toThrow(CSRF_MESSAGE);
    expect(() => readCsrfToken(explicit)).toThrow(CSRF_MESSAGE);
  });

  it("getAppRuntime ignores later deps and exposes the same-origin client", async () => {
    stubDocument("csrf-default");
    vi.stubGlobal("navigator", {});
    const { getAppRuntime } = await loadBootstrap();

    const first = getAppRuntime();
    const second = getAppRuntime({ db: makeDb() });

    expect(second).toBe(first);
    expect(first.client.eventStreamFetch({ scopeId: "s", executionId: "e", afterSeq: 0 })).toEqual({
      url: "/api/v1/scopes/s/executions/e/events?afterSeq=0",
      headers: { Accept: "text/event-stream" },
    });
  });

  it("invalidates runtime queries when a joined agent changes the room", async () => {
    stubDocument("csrf-query");
    vi.stubGlobal("navigator", {});
    const { createAppRuntime } = await loadBootstrap();
    const db = makeDb();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const runtime = createAppRuntime({ db, queryClient });
    const agent = createDiscussionAgent({
      name: "Ada",
      personaPrompt: "Be precise.",
      executionProfileId: "prof-1",
      modelId: "gpt-5",
      color: "#112233",
    });
    await db.agents.add(agent);

    const joined = await runtime.orchestrator.joinAgent("room-1", agent.id, "digest-fixed");

    expect(joined.roomId).toBe("room-1");
    expect(joined.agentId).toBe(agent.id);
    expect(joined.profileDigest).toBe("digest-fixed");
    expect(joined.personaPrompt).toBe("Be precise.");
    expect(joined.modelId).toBe("gpt-5");
    expect(joined.state).toBe("active");
    expect(joined.endedAt).toBeNull();
    expect(await db.participants.get(joined.id)).toEqual(joined);
    expect(discussion.getState().changeTickByRoom["room-1"]).toBe(1);
    expect(invalidate.mock.calls).toEqual([[{ queryKey: ["rt"] }]]);
  });

  it("holds a granted room lock and releases it from startup audit", async () => {
    stubDocument("csrf-lock");
    const released: string[] = [];
    const calls = installLocks("grant", released);
    const fetchMock = vi.fn(healthFetch);
    vi.stubGlobal("fetch", fetchMock);
    const { createAppRuntime } = await loadBootstrap();
    const db = makeDb();
    await db.runtimeBindings.add({
      id: "binding-1",
      roomId: "room-1",
      scopeRequestId: "req-12345678",
      state: "creating",
      hostInstanceId: null,
      executionScopeId: null,
      controllerId: null,
      leaseEpoch: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    });
    const runtime = createAppRuntime({ db });

    const handle = await runtime.orchestrator.controlRoom("room-1");
    expect(handle).not.toBeNull();
    handle?.release();
    await runtime.orchestrator.startupAudit();
    await vi.waitFor(() => {
      if (released.length < 2) throw new Error(`released ${released.length}`);
    });

    const stored = await db.runtimeBindings.get("binding-1");
    expect(
      calls.map((call) => ({ name: call.name, ifAvailable: call.options.ifAvailable })),
    ).toEqual([
      { name: "councilkit-room-room-1", ifAvailable: true },
      { name: "councilkit-room-room-1", ifAvailable: true },
    ]);
    expect(discussion.getState().controlByRoom["room-1"]).toBe("controlling");
    expect(stored?.state).toBe("closed");
    expect(stored?.roomId).toBe("room-1");
    expect(stored?.scopeRequestId).toBe("req-12345678");
    expect(stored?.hostInstanceId).toBeNull();
    expect(stored?.createdAt).toBe("2026-07-19T00:00:00.000Z");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/health");
    expect(released).toEqual(["councilkit-room-room-1", "councilkit-room-room-1"]);
  });

  it("acquires after a busy tryAcquire and forwards the abort signal", async () => {
    stubDocument("csrf-busy");
    const calls = installLocks("deny-then-grant", []);
    const { createAppRuntime } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });
    const controller = new AbortController();

    const handle = await runtime.orchestrator.controlRoom("room-9", controller.signal);

    expect(handle).not.toBeNull();
    expect(calls).toEqual([
      { name: "councilkit-room-room-9", options: { ifAvailable: true } },
      { name: "councilkit-room-room-9", options: { signal: controller.signal } },
    ]);
    expect(discussion.getState().controlByRoom["room-9"]).toBe("controlling");
    handle?.release();
  });

  it("returns null when acquire aborts and leaves the room observing", async () => {
    stubDocument("csrf-abort");
    installLocks("deny-then-abort", []);
    const { createAppRuntime } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });

    expect(await runtime.orchestrator.controlRoom("room-abort")).toBeNull();
    expect(discussion.getState().controlByRoom["room-abort"]).toBe("observing");
  });

  it("rejects tryAcquire AbortError because ifAvailable does not swallow it", async () => {
    stubDocument("csrf-try-abort");
    installLocks("try-abort", []);
    const { createAppRuntime } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });

    const error = await runtime.orchestrator
      .controlRoom("room-try")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(discussion.getState().controlByRoom["room-try"]).toBe("acquiring");
  });

  it("rejects a non-abort DOMException from acquire", async () => {
    stubDocument("csrf-not-allowed");
    installLocks("deny-then-not-allowed", []);
    const { createAppRuntime } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });

    const error = await runtime.orchestrator
      .controlRoom("room-na")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("NotAllowedError");
    expect((error as DOMException).message).toBe("not allowed");
  });

  it("rejects the same Error from the lock manager", async () => {
    stubDocument("csrf-error");
    installLocks("reject-error", []);
    const { createAppRuntime } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });

    const error = await runtime.orchestrator
      .controlRoom("room-err")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("locks-down");
    expect((error as Error).name).toBe("Error");
  });

  it("wraps a non-Error lock rejection", async () => {
    stubDocument("csrf-string");
    installLocks("reject-string", []);
    const { createAppRuntime } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });

    const error = await runtime.orchestrator
      .controlRoom("room-string")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("locks-string");
  });

  it("uses the no-lock fallback when navigator has no locks", async () => {
    stubDocument("csrf-nolock");
    vi.stubGlobal("navigator", {});
    const { createAppRuntime } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });

    const handle = await runtime.orchestrator.controlRoom("room-nolock");

    expect(handle).not.toBeNull();
    expect(handle?.release()).toBeUndefined();
    expect(discussion.getState().controlByRoom["room-nolock"]).toBe("controlling");
  });

  it("uses the no-lock fallback when navigator is undefined", async () => {
    stubDocument("csrf-nonav");
    vi.stubGlobal("navigator", undefined);
    const { createAppRuntime } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });

    const handle = await runtime.orchestrator.controlRoom("room-nonav");

    expect(handle).not.toBeNull();
    expect(discussion.getState().controlByRoom["room-nonav"]).toBe("controlling");
  });

  it("leaves a creating binding untouched when the room lock is busy", async () => {
    stubDocument("csrf-busy-audit");
    installLocks("deny-then-grant", []);
    vi.stubGlobal("fetch", vi.fn(healthFetch));
    const { createAppRuntime } = await loadBootstrap();
    const db = makeDb();
    await db.runtimeBindings.add({
      id: "binding-busy",
      roomId: "room-busy",
      scopeRequestId: "req-busy-1234",
      state: "creating",
      hostInstanceId: null,
      executionScopeId: null,
      controllerId: null,
      leaseEpoch: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    });
    const runtime = createAppRuntime({ db });

    await runtime.orchestrator.startupAudit();

    const stored = await db.runtimeBindings.get("binding-busy");
    expect(stored?.state).toBe("creating");
    expect(stored?.updatedAt).toBe("2026-07-19T00:00:00.000Z");
  });

  it("warns once when the startup audit rejects", async () => {
    stubDocument("csrf-audit");
    vi.stubGlobal("navigator", {});
    const { createAppRuntime, startRuntimeAudit } = await loadBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });
    vi.spyOn(runtime.orchestrator, "startupAudit").mockRejectedValue(new Error("audit-down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    startRuntimeAudit();
    startRuntimeAudit();
    await vi.waitFor(() => {
      if (warn.mock.calls.length === 0) throw new Error("waiting for warn");
    });
    await Promise.resolve();

    expect(warn.mock.calls.length).toBe(1);
    expect(warn.mock.calls[0]?.[0]).toBe("runtime startup audit failed");
    expect(warn.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect((warn.mock.calls[0]?.[1] as Error).message).toBe("audit-down");
  });

  it("runs the real startup audit once through startRuntimeAudit", async () => {
    stubDocument("csrf-once");
    vi.stubGlobal("navigator", {});
    const fetchMock = vi.fn(healthFetch);
    vi.stubGlobal("fetch", fetchMock);
    const { startRuntimeAudit } = await loadBootstrap();

    startRuntimeAudit();
    startRuntimeAudit();
    await vi.waitFor(() => {
      if (fetchMock.mock.calls.length === 0) throw new Error("waiting for health");
    });
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBe(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/health");
  });
});
