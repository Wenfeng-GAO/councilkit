import { describe, expect, it } from "vitest";

import { db } from "@/lib/db";

/**
 * Regression: listGateways() uses db.gateways.orderBy("createdAt"). Dexie
 * requires the orderBy target to be an indexed property, else it throws
 * OrderByError and the /settings list renders empty even after a successful
 * addGateway (human-verify hit this — "保存网关后没看到新网关").
 * v3 adds `createdAt` to the gateways store index to fix it.
 *
 * Real-Dexie read/write can't be exercised in node env (no IndexedDB), so we
 * assert the live schema contract: the createdAt index is declared.
 */
describe("db gateways schema regression", () => {
  it("gateways store indexes createdAt (required by listGateways orderBy)", () => {
    const indexes = db.gateways.schema.indexes.map((i) => i.name);
    expect(indexes).toContain("createdAt");
  });

  it("rooms store indexes lastActiveAt (same pattern, sanity)", () => {
    const indexes = db.rooms.schema.indexes.map((i) => i.name);
    expect(indexes).toContain("lastActiveAt");
  });
});
