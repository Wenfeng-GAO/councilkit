import "fake-indexeddb/auto";

import { AGENT_EXPORT_FORMAT, AGENT_EXPORT_VERSION, importAgents } from "@/lib/agent-io";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let db: CouncilKitRuntimeDB;

beforeEach(() => {
  db = new CouncilKitRuntimeDB(`test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await db.delete();
  db.close();
});

describe("importAgents factory rejection", () => {
  it("rejects the whole file when a name is only whitespace", async () => {
    const json = JSON.stringify({
      format: AGENT_EXPORT_FORMAT,
      version: AGENT_EXPORT_VERSION,
      exportedAt: "2026-10-14T00:00:00.000Z",
      agents: [
        {
          name: " ",
          personaPrompt: "直言不讳的人设。",
          modelId: "model-a",
          color: "#a1b2c3",
          executionProfileId: "profile-1",
          profileSnapshot: null,
        },
      ],
    });

    await expect(importAgents(db, json)).resolves.toEqual({
      ok: false,
      error: "name is required",
    });
    expect(await db.agents.count()).toBe(0);
  });
});
