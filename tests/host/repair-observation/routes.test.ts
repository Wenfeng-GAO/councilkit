import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairObservationRoutes } from "@host/repair-observation/routes";
import type { HostServices, RouteContext } from "@host/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUN_ID = "ck-repair-00000000-0000-4000-8000-000000000128";

let home: string;
let oldHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-repair-obs-host-"));
  oldHome = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
  const runDir = join(home, "runs", RUN_ID);
  const taskDir = join(home, "squad-tasks", "task-1");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(runDir, "repair.json"),
    JSON.stringify({
      version: 1,
      casVersion: 0,
      sourceRunId: "ck-review-00000000-0000-4000-8000-000000000001",
      profileName: "default",
      outerUsed: 2,
      outerMax: 3,
      timeoutMs: null,
      businessResult: null,
      reasonCode: null,
      goalSummary: "停机中断后恢复会话，并支持安全重试",
      frozenBaseSha: "b".repeat(40),
      candidateSha: "c".repeat(40),
      resumeEligible: false,
      protocolVersion: "v2",
      cycles: [
        {
          n: 2,
          phase: "active",
          childReviewId: null,
          squadTaskId: "task-1",
          squadTaskDir: taskDir,
        },
      ],
    }),
  );
  writeFileSync(
    join(taskDir, "orchestrator.log"),
    `${JSON.stringify({
      type: "tool.started",
      callId: "c1",
      name: "bash",
      summary: "Authorization: Bearer HOSTSECRET go test",
      role: "coder",
      at: "2026-09-22T06:00:01Z",
    })}\n`,
  );
  writeFileSync(
    join(taskDir, "adapter-meta.json"),
    JSON.stringify({
      executionRef: "squad:task-1#1.1",
      pid: 1234,
      startKey: "start-abc",
      checkedAt: "2026-09-22T06:00:02Z",
      alive: true,
      roles: [
        {
          roleKey: "builder",
          status: "active",
          planned: true,
          requestedModel: "grok-4.7",
          actualModel: null,
          executionRef: "squad:task-1#1.1",
        },
      ],
    }),
  );
});

afterEach(() => {
  if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
  else process.env.COUNCILKIT_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

function ctx(query: Record<string, string>, params: Record<string, string> = { runId: RUN_ID }): RouteContext {
  return {
    body: undefined,
    params,
    query: new URLSearchParams(query),
    req: {} as IncomingMessage,
    res: {
      writeHead() {
        return this;
      },
      end() {
        return this;
      },
    } as unknown as ServerResponse,
    services: {} as HostServices,
  };
}

describe("host repair observation routes (no listen)", () => {
  it("exposes session auth on observation routes", () => {
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    for (const route of routes) {
      expect(route.auth).toBe("session");
    }
  });

  it("returns redacted observation and clamps limit", async () => {
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const data = (await route.handler(ctx({ round: "current", limit: "9999" }))) as {
      upserts: Array<{ summary: string }>;
    };
    expect(data.upserts.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(data)).not.toContain("HOSTSECRET");
    expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThanOrEqual(512 * 1024);
  });

  it("marks reset for illegal foreign cursors", async () => {
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const foreign = Buffer.from(
      JSON.stringify({
        runId: "ck-repair-other",
        round: 2,
        direction: "forward",
        watermarks: [],
      }),
      "utf8",
    ).toString("base64url");
    const data = (await route.handler(ctx({ round: "2", cursor: foreign }))) as {
      reset: boolean;
      reasons: string[];
    };
    expect(data.reset).toBe(true);
    expect(data.reasons.some((r) => r.includes("cursor") || r.includes("mismatch"))).toBe(true);
  });

  it("does not export approved when evidence is missing", async () => {
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/evidence"));
    if (!route) throw new Error("missing evidence route");
    const data = (await route.handler(ctx({ round: "2" }))) as {
      exportableAsApproved: boolean;
    };
    expect(data.exportableAsApproved).toBe(false);
  });

  it("rejects path-escape source dirs without leaking sibling content", async () => {
    const sibling = join(home, "squad-tasks", "sibling-secret");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "orchestrator.log"), "SIBLING_SENTINEL\n");
    writeFileSync(
      join(home, "runs", RUN_ID, "repair.json"),
      JSON.stringify({
        version: 1,
        casVersion: 0,
        sourceRunId: "ck-review-00000000-0000-4000-8000-000000000001",
        profileName: "default",
        outerUsed: 0,
        outerMax: 3,
        timeoutMs: null,
        businessResult: null,
        reasonCode: null,
        cycles: [
          {
            n: 1,
            phase: "active",
            squadTaskId: "evil",
            squadTaskDir: join(home, "squad-tasks", "task-1", "..", "sibling-secret"),
          },
        ],
      }),
    );
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const data = await route.handler(ctx({ round: "1" }));
    expect(JSON.stringify(data)).not.toContain("SIBLING_SENTINEL");
  });

  it("rejects invalid repair run ids", async () => {
    const routes = repairObservationRoutes();
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    try {
      await route.handler(ctx({}, { runId: "ck-review-not-repair" }));
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toMatchObject({ status: 400 });
    }
  });
});
