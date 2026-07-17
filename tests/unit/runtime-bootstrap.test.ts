import "fake-indexeddb/auto";

import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Runtime bootstrap (U6): CSRF meta reading, the lazy app-wide singleton
 * (created against fake-indexeddb with a stubbed document + navigator.locks),
 * and the at-most-once fire-and-forget startup audit. Each test re-imports
 * the module after vi.resetModules() so the singleton starts fresh.
 */

const CSRF_SELECTOR = 'meta[name="councilkit-csrf"]';

function stubBrowser(csrfToken: string | null): void {
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector === CSRF_SELECTOR && csrfToken !== null
        ? { getAttribute: (name: string) => (name === "content" ? csrfToken : null) }
        : null,
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: () => Promise.resolve(null),
    },
  });
}

async function importBootstrap() {
  return import("@/runtime/bootstrap");
}

describe("readCsrfToken", () => {
  it("returns the content of the injected meta tag", async () => {
    const { readCsrfToken } = await importBootstrap();
    const doc = {
      querySelector: (selector: string) =>
        selector === CSRF_SELECTOR
          ? ({ getAttribute: () => "csrf-abc" } as unknown as Element)
          : null,
    } as Pick<Document, "querySelector">;
    expect(readCsrfToken(doc)).toBe("csrf-abc");
  });

  it("throws a clear error when the meta tag is absent or empty", async () => {
    const { readCsrfToken } = await importBootstrap();
    const missing = {
      querySelector: () => null,
    } as unknown as Pick<Document, "querySelector">;
    expect(() => readCsrfToken(missing)).toThrow(/councilkit-csrf/);
    const empty = {
      querySelector: () => ({ getAttribute: () => "" }) as unknown as Element,
    } as unknown as Pick<Document, "querySelector">;
    expect(() => readCsrfToken(empty)).toThrow(/councilkit-csrf/);
  });
});

describe("app runtime bootstrap (U6)", () => {
  let dbs: CouncilKitRuntimeDB[];

  beforeEach(() => {
    vi.resetModules();
    dbs = [];
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const db of dbs) {
      await db.delete();
      db.close();
    }
  });

  function makeDb(): CouncilKitRuntimeDB {
    const db = new CouncilKitRuntimeDB(`test-bootstrap-${crypto.randomUUID()}`);
    dbs.push(db);
    return db;
  }

  it("creates a lazy singleton with an injected csrf meta + stub navigator.locks", async () => {
    stubBrowser("csrf-singleton");
    const { createAppRuntime, getAppRuntime } = await importBootstrap();

    const first = createAppRuntime({ db: makeDb() });
    expect(first.client).toBeDefined();
    expect(first.orchestrator).toBeDefined();
    // Same instance on repeat calls, whatever the deps; the lazy accessor agrees.
    expect(createAppRuntime({ db: makeDb() })).toBe(first);
    expect(getAppRuntime()).toBe(first);
  });

  it("fails fast with a clear error when the csrf meta is missing", async () => {
    stubBrowser(null);
    const { createAppRuntime } = await importBootstrap();
    expect(() => createAppRuntime({ db: makeDb() })).toThrow(/councilkit-csrf/);
  });

  it("startRuntimeAudit runs the orchestrator audit exactly once, fire-and-forget", async () => {
    stubBrowser("csrf-audit");
    const { createAppRuntime, startRuntimeAudit } = await importBootstrap();
    const runtime = createAppRuntime({ db: makeDb() });
    const audit = vi.spyOn(runtime.orchestrator, "startupAudit").mockResolvedValue(undefined);

    startRuntimeAudit();
    startRuntimeAudit();

    expect(audit).toHaveBeenCalledTimes(1);
    // Let the fire-and-forget promise settle before the db is torn down.
    await Promise.resolve();
  });
});
