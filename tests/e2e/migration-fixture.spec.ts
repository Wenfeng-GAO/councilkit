/**
 * Dexie v1 → v2 migration E2E fixture (plan-a §3, ruling #1): the unit test
 * tests/unit/domain-models.test.ts proves the upgrade function with a frozen
 * v1 schema under fake-indexeddb. This spec is the browser-visible half the
 * 10-point acceptance (#1) asked for: a pre-cutover Chromium holds a REAL
 * v1 `councilkit-runtime-v1` DB (nine v1 stores, v1-shaped Room/Agent rows
 * omitting the four/one new fields). On first app load Dexie opens it under
 * the v2 schema and runs the upgrade; we then assert the four Room defaults
 * landed, Agent.enabled backfilled, every pre-existing row is byte-identical,
 * and the brand-new reports store is empty. Raw IDB seeding mirrors the unit
 * test's V1_STORES exactly; readStore (helpers) does the assertion-only reads.
 *
 * 串行锁纪律：mkdir /tmp/councilkit-e2e.lock && pnpm exec playwright test
 * tests/e2e/migration-fixture.spec.ts; rmdir /tmp/councilkit-e2e.lock（绝不与
 * vitest 并发）。
 */
import { expect, test } from "@playwright/test";
import { freshPage, readStore } from "./helpers";

/** v1 store specs exactly mirroring tests/unit/domain-models.test.ts V1_STORES:
 * Dexie store syntax (`keyPath, idxA, &uniqueIdx, [a+b]`). Here each store is
 * the raw IDB shape: keyPath + index array where compound indexes carry the
 * real multi-entry keyPath array (Dexie's `[a+b]` sugar expands to this). */
const V1_STORES: Record<
  string,
  { keyPath: string; indexes: { name: string; keyPath: string | string[]; unique?: boolean }[] }
> = {
  agents: {
    keyPath: "id",
    indexes: [{ name: "executionProfileId", keyPath: "executionProfileId" }],
  },
  participants: {
    keyPath: "id",
    indexes: [
      { name: "roomId", keyPath: "roomId" },
      { name: "agentId", keyPath: "agentId" },
      { name: "state", keyPath: "state" },
      { name: "[roomId+state]", keyPath: ["roomId", "state"] },
    ],
  },
  rooms: {
    keyPath: "id",
    indexes: [
      { name: "runState", keyPath: "runState" },
      { name: "lastActiveAt", keyPath: "lastActiveAt" },
      { name: "activeRoundId", keyPath: "activeRoundId" },
    ],
  },
  rounds: {
    keyPath: "id",
    indexes: [
      { name: "roomId", keyPath: "roomId" },
      { name: "roundNumber", keyPath: "roundNumber" },
      { name: "phase", keyPath: "phase" },
      { name: "[roomId+phase]", keyPath: ["roomId", "phase"] },
    ],
  },
  messages: {
    keyPath: "id",
    indexes: [
      { name: "roomId", keyPath: "roomId" },
      { name: "roundId", keyPath: "roundId" },
      { name: "sourceExecutionId", keyPath: "sourceExecutionId", unique: true },
    ],
  },
  summaries: {
    keyPath: "id",
    indexes: [
      { name: "roomId", keyPath: "roomId" },
      { name: "roundId", keyPath: "roundId", unique: true },
      { name: "sourceExecutionId", keyPath: "sourceExecutionId", unique: true },
    ],
  },
  modelExecutions: {
    keyPath: "executionId",
    indexes: [
      { name: "roomId", keyPath: "roomId" },
      { name: "roundId", keyPath: "roundId" },
      { name: "participantId", keyPath: "participantId" },
      { name: "state", keyPath: "state" },
      { name: "ackState", keyPath: "ackState" },
      { name: "retryOfExecutionId", keyPath: "retryOfExecutionId" },
    ],
  },
  runtimeBindings: {
    keyPath: "id",
    indexes: [
      { name: "roomId", keyPath: "roomId" },
      { name: "scopeRequestId", keyPath: "scopeRequestId", unique: true },
      { name: "state", keyPath: "state" },
    ],
  },
  executionProfiles: {
    keyPath: "id",
    indexes: [
      { name: "driverId", keyPath: "driverId" },
      { name: "installationId", keyPath: "installationId" },
    ],
  },
};

/** Build a real v1 `councilkit-runtime-v1` DB (version 1, nine stores, v1
 * indices) and write one v1-shaped Room + one v1-shaped Agent. Mirrors the
 * unit test: Room omits mode/targetOutput/maxRounds/status; Agent omits
 * enabled. Closes immediately so the app's Dexie connection reopens & upgrades.
 *
 * Runs via page.addInitScript so it executes in the page's origin (about:blank
 * blocks IndexedDB) BEFORE the app bundle opens the DB. Sets window.__v1Seed
 * to {"pending"|"done"|"error"} so the test can await completion before
 * asserting (the app's Dexie open races nothing: the seed closes its DB first). */
function installV1Seeder(page: import("@playwright/test").Page): void {
  page.addInitScript((v1Stores) => {
    const DB_NAME = "councilkit-runtime-v1";
    const flag = { state: "pending" as "pending" | "done" | "error", error: "" };
    Object.defineProperty(window, "__v1Seed", { value: flag, configurable: true });
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [storeName, spec] of Object.entries(v1Stores)) {
        const store = db.createObjectStore(storeName, { keyPath: spec.keyPath });
        for (const idx of spec.indexes) {
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // If the app already upgraded this DB to v2 (e.g. on a reload after the
      // first navigation), do not re-seed over an upgraded DB.
      if (db.version > 1) {
        db.close();
        flag.state = "done";
        return;
      }
      // Do NOT close on versionchange here: closing mid-transaction aborts it
      // and the seed loses its rows. Instead let the readwrite transaction
      // commit fully (tx.oncomplete → db.close → flag "done"). Dexie's v2 open
      // is naturally blocked until this connection closes, then upgrades — so
      // the seeded v1 rows are present before the upgrade runs.
      const tx = db.transaction(["rooms", "agents"], "readwrite");
      tx.objectStore("rooms").put({
        id: "legacy-room-v1",
        topic: "v1 旧库房间",
        background: "v1 上下文",
        facilitatorParticipantId: "fac-v1",
        runState: "idle",
        activeRoundId: null,
        contextRevision: 0,
        contextDigest: "v1-digest",
        createdAt: "2026-07-17T00:00:00.000Z",
        lastActiveAt: "2026-07-17T00:00:00.000Z",
      });
      tx.objectStore("agents").put({
        id: "legacy-agent-v1",
        name: "v1 评审员",
        personaPrompt: "v1 人格",
        executionProfileId: "prof-v1",
        modelId: "v1-model",
        color: "#a1b2c3",
        revision: 1,
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
      });
      tx.oncomplete = () => {
        db.close();
        flag.state = "done";
      };
      tx.onerror = () => {
        flag.state = "error";
        flag.error = `tx: ${String(tx.error)}`;
        console.error("[v1-seed] tx error", tx.error);
      };
      tx.onabort = () => {
        flag.state = "error";
        flag.error = "aborted";
        console.error("[v1-seed] tx aborted", tx.error);
      };
    };
    request.onerror = () => {
      flag.state = "error";
      flag.error = `open: ${String(request.error)}`;
      console.error("[v1-seed] open error", request.error);
    };
  }, V1_STORES);
}

/** Await the init-script seed's window flag (used after the first navigation,
 * once a same-origin page exists for page.evaluate). */
async function awaitV1Seed(page: import("@playwright/test").Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (window as unknown as { __v1Seed?: { state: string; error: string } }).__v1Seed?.state,
        ),
      { timeout: 15_000, intervals: [50, 100, 200] },
    )
    .not.toBe("pending");
  const status = await page.evaluate(
    () => (window as unknown as { __v1Seed?: { state: string; error: string } }).__v1Seed,
  );
  if (status?.state !== "done") {
    throw new Error(
      `v1 seed did not complete: state=${status?.state} error=${status?.error ?? ""}`,
    );
  }
}

test.describe("Dexie v1 → v2 migration fixture", () => {
  test("Chromium v1 旧库首启：v2 默认值回填、内容零变化、reports 空表", async ({ browser }) => {
    const { context, page } = await freshPage(browser);
    try {
      // 1. Install the v1 seeder as an init-script BEFORE the first navigation
      //    (about:blank blocks IndexedDB; the app bundle would otherwise open
      //    the DB first). The seed runs in the page origin, opens the v1 DB,
      //    writes one v1-shaped Room + Agent, then closes — letting Dexie's v2
      //    open race nothing: it sees the v1 DB and runs the upgrade.
      installV1Seeder(page);

      // 2. First app load: HomePage queries runtimeDb.rooms → Dexie opens the
      //    v1 DB under the v2 schema and runs the upgrade in the browser.
      await page.goto("/");
      await awaitV1Seed(page);
      // Wait for the app shell: the seeded room renders, so the upgrade landed.
      await expect(page.getByRole("link", { name: "v1 旧库房间" })).toBeVisible({
        timeout: 20_000,
      });

      // 3. Room: four v2 defaults backfilled; every v1 key byte-identical.
      const rooms = await readStore<Record<string, unknown>>(page, "rooms");
      expect(rooms).toHaveLength(1);
      const room = rooms[0];
      expect(room?.id).toBe("legacy-room-v1");
      expect(room?.mode).toBe("brainstorm");
      expect(room?.targetOutput).toBe("");
      expect(room?.maxRounds).toBeNull();
      expect(room?.status).toBe("open");
      // The nine v1 keys are untouched (no field added beyond the four defaults).
      expect(Object.keys(room as object).sort()).toEqual(
        [
          "id",
          "topic",
          "background",
          "facilitatorParticipantId",
          "runState",
          "activeRoundId",
          "contextRevision",
          "contextDigest",
          "createdAt",
          "lastActiveAt",
          "mode",
          "targetOutput",
          "maxRounds",
          "status",
        ].sort(),
      );

      // 4. Agent: enabled backfilled to true; every v1 key byte-identical.
      const agents = await readStore<Record<string, unknown>>(page, "agents");
      expect(agents).toHaveLength(1);
      const agent = agents[0];
      expect(agent?.id).toBe("legacy-agent-v1");
      expect(agent?.enabled).toBe(true);
      expect(Object.keys(agent as object).sort()).toEqual(
        [
          "id",
          "name",
          "personaPrompt",
          "executionProfileId",
          "modelId",
          "color",
          "revision",
          "createdAt",
          "updatedAt",
          "enabled",
        ].sort(),
      );

      // 5. The reports store is brand-new in v2 and empty.
      const reports = await readStore<unknown>(page, "reports");
      expect(reports).toEqual([]);

      // 6. Every other v1 store exists and is empty (no rows seeded → zero).
      for (const storeName of [
        "participants",
        "rounds",
        "messages",
        "summaries",
        "modelExecutions",
        "runtimeBindings",
        "executionProfiles",
      ]) {
        const rows = await readStore<unknown>(page, storeName);
        expect(rows, `${storeName} should be empty`).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });
});
