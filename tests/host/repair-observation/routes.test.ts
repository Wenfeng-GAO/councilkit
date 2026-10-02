import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairObservationRoutes } from "@host/repair-observation/routes";
import type { HostServices, RouteContext } from "@host/server";
import {
  REPAIR_OBS_LINE_ISOLATE,
  type RepairObservation,
} from "@shared/runtime/repair-observation";
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
  async function observe() {
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    return (await route.handler(ctx({ round: "current" }))) as RepairObservation;
  }

  function patchRun(patch: Record<string, unknown>) {
    const path = join(home, "runs", RUN_ID, "repair.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
  }

  function writeMeta(meta: Record<string, unknown>) {
    writeFileSync(join(home, "squad-tasks", "task-1", "adapter-meta.json"), JSON.stringify(meta));
  }

  it("does not portray a failed repair with only an intent and unfinished tool as active or exited", async () => {
    patchRun({
      businessResult: "needs_attention",
      reasonCode: "squad_failed",
      candidateSha: null,
      executions: [{ kind: "source_fix", state: "intent", pids: [], startedAtMs: null, endedAtMs: null }],
    });
    writeMeta({
      checkedAt: "2026-09-22T06:00:02Z",
      roles: [{ roleKey: "builder", status: "active", planned: true }],
    });
    writeFileSync(join(home, "squad-tasks", "task-1", "orchestrator.log"), `${JSON.stringify({
      type: "tool.started", callId: "old", name: "shell", role: "coder", at: "2026-09-22T05:00:00Z",
    })}\n`);
    const data = await observe();
    expect(data.task).toMatchObject({ businessResult: "needs_attention", reasonCode: "squad_failed", phase: "active" });
    expect(data.task.process.state).toBe("unknown");
    expect(data.upserts[0]?.status).toBe("unfinished");
    expect(data.roles.find((r) => r.roleKey === "builder")?.status).toBe("unknown");
  });

  it.each(["completed", "failed", "unfinished"])("does not upgrade a %s tool record to a role outcome", async (status) => {
    writeMeta({ roles: [{ roleKey: "builder", status: "active", planned: true }] });
    writeFileSync(join(home, "squad-tasks", "task-1", "orchestrator.log"), `${JSON.stringify({
      type: "tool", callId: "tool-1", name: "shell", role: "coder", status, at: "2026-09-22T06:00:01Z",
    })}\n`);
    const data = await observe();
    expect(data.roles.find((r) => r.roleKey === "builder")?.status).toBe("unknown");
  });

  it("does not infer activity from the existence of empty source files", async () => {
    writeMeta({});
    writeFileSync(join(home, "squad-tasks", "task-1", "orchestrator.log"), "");
    const data = await observe();
    expect(data.roles.find((r) => r.roleKey === "builder")?.status).toBe("unknown");
  });

  it.each(["intent", "running"])("does not treat a %s journal entry as heartbeat evidence", async (state) => {
    patchRun({
      executions: [{ kind: "source_fix", state, pids: [1234], startedAtMs: Date.parse("2026-09-22T06:00:02Z"), endedAtMs: null }],
    });
    writeMeta({
      executionRef: "squad:task-1#1.1", pid: 1234, startKey: "start-abc", checkedAt: "2026-09-22T06:00:02Z",
    });
    expect((await observe()).task.process.state).toBe("unknown");
  });

  it("keeps explicit role outcomes and fresh liveness when the business result is terminal", async () => {
    patchRun({ businessResult: "needs_attention", reasonCode: "squad_failed" });
    writeMeta({
      executionRef: "squad:task-1#1.1", pid: 1234, startKey: "start-abc",
      checkedAt: "2026-09-22T06:00:02Z", alive: true,
      roles: [
        { roleKey: "builder", status: "ended", planned: true },
        { roleKey: "reviewer", status: "failed", planned: true },
      ],
    });
    const data = await observe();
    expect(data.task.process.state).toBe("alive");
    expect(data.roles.find((r) => r.roleKey === "builder")?.status).toBe("ended");
    expect(data.roles.find((r) => r.roleKey === "reviewer")?.status).toBe("failed");
  });

  it.each([true, false])("reads explicit nested process liveness=%s", async (alive) => {
    writeMeta({
      executionRef: "squad:task-1#1.1",
      process: { pid: 1234, startKey: "start-abc", checkedAt: "2026-09-22T06:00:02Z", alive },
    });
    const data = await observe();
    expect(data.task.process.state).toBe(alive ? "alive" : "exited");
    expect(data.roles.find((r) => r.roleKey === "builder")?.status).toBe(alive ? "active" : "unknown");
  });

  it("does not apply the builder's exit to independent review activity", async () => {
    writeMeta({
      executionRef: "squad:task-1#1.1", pid: 1234, startKey: "start-abc",
      checkedAt: "2026-09-22T06:00:02Z", alive: false,
      roles: [{ roleKey: "reviewer", status: "active", planned: true, executionRef: "reviewer#1.1" }],
    });
    writeFileSync(join(home, "squad-tasks", "task-1", "reviewer.jsonl"), `${JSON.stringify({
      type: "tool.started", callId: "review-1", name: "shell", role: "reviewer", at: "2026-09-22T06:00:01Z",
    })}\n`);
    const data = await observe();
    expect(data.task.process.state).toBe("exited");
    expect(data.roles.find((r) => r.roleKey === "reviewer")?.status).toBe("active");
  });

  it("exposes session auth on observation routes", () => {
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    for (const route of routes) {
      expect(route.auth).toBe("session");
    }
  });

  it("does not drop a later source when an earlier source fills the page", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const line = (summary: string, callId: string) =>
      `${JSON.stringify({
        type: "tool.started",
        callId,
        name: "shell",
        summary,
        role: "coder",
        at: "2026-09-22T06:00:01Z",
      })}\n`;
    writeFileSync(join(taskDir, "orchestrator.log"), `${line("alpha", "a1")}${line("beta", "a2")}`);
    writeFileSync(join(taskDir, "coder.jsonl"), line("gamma", "b1"));
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const data = (await route.handler(
        ctx({
          round: "current",
          limit: "1",
          ...(cursor ? { cursor } : {}),
        }),
      )) as RepairObservation;
      seen.push(...data.upserts.map((row) => row.summary));
      cursor = data.nextCursor;
    }
    expect(seen).toEqual(["alpha", "beta", "gamma"]);
  });

  it("does not offer an earlier page when the log was read from byte zero", async () => {
    const data = await observe();
    expect(data.upserts).toHaveLength(1);
    expect(data.hasMore).toBe(false);
    expect(data.earlierCursor).toBeNull();
  });

  it("does not offer an earlier page when a leading newline precedes the only record", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const line = JSON.stringify({
      type: "tool.started",
      callId: "c1",
      name: "shell",
      summary: "only-row",
      role: "coder",
      at: "2026-09-22T06:00:01Z",
    });
    writeFileSync(join(taskDir, "orchestrator.log"), `\n${line}\n`);
    const data = await observe();
    expect(data.upserts.map((row) => row.summary)).toEqual(["only-row"]);
    expect(data.hasMore).toBe(false);
    expect(data.earlierCursor).toBeNull();
  });

  it("walks earlier pages back to the first row without repeating the cold tail", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const pad = "x".repeat(16 * 1024);
    const lines = Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({
        type: "tool.started",
        callId: `c${index}`,
        name: "shell",
        summary: `row-${index}`,
        role: "coder",
        at: "2026-09-22T06:00:01Z",
        pad,
      }),
    );
    writeFileSync(join(taskDir, "orchestrator.log"), `${lines.join("\n")}\n`);
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const page = async (cursor: string | null) =>
      (await route.handler(
        ctx({
          round: "current",
          limit: "2",
          ...(cursor ? { cursor } : {}),
        }),
      )) as RepairObservation;

    const first = await page(null);
    const firstSummaries = first.upserts.map((row) => row.summary);
    expect(firstSummaries).not.toContain("row-0");
    expect(first.earlierCursor).not.toBeNull();

    const earlierPages: string[][] = [];
    let earlier = first.earlierCursor;
    for (let guard = 0; earlier && guard < 30; guard += 1) {
      const data = await page(earlier);
      earlierPages.push(data.upserts.map((row) => row.summary));
      earlier = data.earlierCursor;
    }
    expect(earlier).toBeNull();

    const forward: string[] = [];
    let cursor: string | null = first.nextCursor;
    for (let guard = 0; cursor && guard < 30; guard += 1) {
      const data = await page(cursor);
      forward.push(...data.upserts.map((row) => row.summary));
      if (!data.hasMore) break;
      cursor = data.nextCursor;
    }

    const seen = [...earlierPages.flat(), ...firstSummaries, ...forward];
    const overlap = earlierPages.flat().filter((row) => firstSummaries.includes(row));
    expect(overlap).toEqual([]);
    expect([...seen].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))).toEqual(
      Array.from({ length: 40 }, (_, index) => `row-${index}`),
    );
  });

  it("pages earlier past a line between the tail window and the isolate cap", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const suffixCount = 40;
    const lines = [
      JSON.stringify({
        type: "tool.started",
        callId: "prefix",
        name: "shell",
        summary: "prefix-0",
        role: "coder",
        at: "2026-09-22T06:00:01Z",
      }),
      JSON.stringify({
        type: "tool.started",
        callId: "big",
        name: "shell",
        summary: "BIG-LINE",
        role: "coder",
        at: "2026-09-22T06:00:01Z",
        pad: "x".repeat(600 * 1024),
      }),
      ...Array.from({ length: suffixCount }, (_, index) =>
        JSON.stringify({
          type: "tool.started",
          callId: `s${index}`,
          name: "shell",
          summary: `suffix-${index}`,
          role: "coder",
          at: "2026-09-22T06:00:01Z",
          pad: "y".repeat(20 * 1024),
        }),
      ),
    ];
    writeFileSync(join(taskDir, "orchestrator.log"), `${lines.join("\n")}\n`);
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const page = async (cursor: string | null) =>
      (await route.handler(
        ctx({
          round: "current",
          ...(cursor ? { cursor } : {}),
        }),
      )) as RepairObservation;

    const seen = new Set<string>();
    let cursor: string | null = null;
    let guard = 0;
    for (; guard < 12; guard += 1) {
      const data = await page(cursor);
      for (const row of data.upserts) {
        if (row.summary) seen.add(row.summary);
      }
      if (!data.earlierCursor) break;
      cursor = data.earlierCursor;
    }

    expect(guard).toBeLessThan(12);
    expect([...seen].sort()).toEqual(
      ["BIG-LINE", "prefix-0", ...Array.from({ length: suffixCount }, (_, index) => `suffix-${index}`)].sort(),
    );
  });

  it.each([
    REPAIR_OBS_LINE_ISOLATE + 1,
    REPAIR_OBS_LINE_ISOLATE + 512 * 1024 + 64 * 1024,
    2 * 1024 * 1024 + 512 * 1024,
  ])("pages earlier past an isolated line of %i bytes", async (bodyLen) => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const line = (summary: string, callId: string) =>
      JSON.stringify({
        type: "tool.started",
        callId,
        name: "shell",
        summary,
        role: "coder",
        at: "2026-09-22T06:00:01Z",
      });
    writeFileSync(
      join(taskDir, "orchestrator.log"),
      `${[line("prefix-0", "prefix"), "x".repeat(bodyLen), line("suffix-0", "suffix")].join("\n")}\n`,
    );
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const page = async (cursor: string | null) =>
      (await route.handler(
        ctx({
          round: "current",
          ...(cursor ? { cursor } : {}),
        }),
      )) as RepairObservation;

    const seen = new Set<string>();
    let cursor: string | null = null;
    let guard = 0;
    for (; guard < 12; guard += 1) {
      const data = await page(cursor);
      for (const row of data.upserts) {
        if (row.summary) seen.add(row.summary);
      }
      if (!data.earlierCursor) break;
      cursor = data.earlierCursor;
    }

    expect(guard).toBeLessThan(12);
    expect([...seen].sort()).toEqual(["prefix-0", "suffix-0"]);
  });

  it("pages earlier rows of every cold-tailed source", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const pad = "x".repeat(16 * 1024);
    const lines = (prefix: string) =>
      Array.from({ length: 40 }, (_, index) =>
        JSON.stringify({
          type: "tool.started",
          callId: `${prefix}-${index}`,
          name: "shell",
          summary: `${prefix}-${index}`,
          role: "coder",
          at: "2026-09-22T06:00:01Z",
          pad,
        }),
      );
    writeFileSync(join(taskDir, "orchestrator.log"), `${lines("a").join("\n")}\n`);
    writeFileSync(join(taskDir, "coder.jsonl"), `${lines("b").join("\n")}\n`);
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const page = async (cursor: string | null, limit?: string) =>
      (await route.handler(
        ctx({
          round: "current",
          ...(limit ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      )) as RepairObservation;

    const first = await page(null);
    const firstSummaries = first.upserts.map((row) => row.summary);
    expect(firstSummaries).not.toContain("a-0");
    expect(firstSummaries).not.toContain("b-0");
    expect(firstSummaries).toContain("a-39");
    expect(firstSummaries).toContain("b-39");
    expect(first.earlierCursor).not.toBeNull();

    const earlierPages: string[][] = [];
    let earlier = first.earlierCursor;
    for (let guard = 0; earlier && guard < 30; guard += 1) {
      const data = await page(earlier, "2");
      earlierPages.push(data.upserts.map((row) => row.summary));
      earlier = data.earlierCursor;
    }
    expect(earlier).toBeNull();

    const forward: string[] = [];
    let cursor: string | null = first.nextCursor;
    for (let guard = 0; cursor && guard < 30; guard += 1) {
      const data = await page(cursor);
      forward.push(...data.upserts.map((row) => row.summary));
      if (!data.hasMore) break;
      cursor = data.nextCursor;
    }

    const seen = [...earlierPages.flat(), ...firstSummaries, ...forward];
    const rank = (summary: string) => {
      const match = /^([ab])-(\d+)$/.exec(summary);
      if (!match?.[1] || !match[2]) return Number.MAX_SAFE_INTEGER;
      return (match[1] === "a" ? 0 : 100) + Number(match[2]);
    };
    expect(
      seen.filter((row) => row.startsWith("a-") || row.startsWith("b-")).sort((a, b) => rank(a) - rank(b)),
    ).toEqual([
      ...Array.from({ length: 40 }, (_, index) => `a-${index}`),
      ...Array.from({ length: 40 }, (_, index) => `b-${index}`),
    ]);
  });

  it("keeps the start of a later source that is larger than the cold tail", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const line = (summary: string, callId: string) =>
      `${JSON.stringify({
        type: "tool.started",
        callId,
        name: "shell",
        summary,
        role: "coder",
        at: "2026-09-22T06:00:01Z",
      })}\n`;
    writeFileSync(join(taskDir, "orchestrator.log"), line("alpha", "a1"));
    writeFileSync(
      join(taskDir, "coder.jsonl"),
      `${line("early-marker", "b1")}${"x".repeat(600 * 1024)}\n${line("late-marker", "b2")}`,
    );
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const route = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    if (!route) throw new Error("missing observation route");
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const data = (await route.handler(
        ctx({
          round: "current",
          limit: "1",
          ...(cursor ? { cursor } : {}),
        }),
      )) as RepairObservation;
      seen.push(...data.upserts.map((row) => row.summary));
      if (!data.hasMore) break;
      cursor = data.nextCursor;
    }
    expect(seen).toEqual(["alpha", "early-marker", "late-marker"]);
  });

  it("opens detail for an event that sits before the cold tail", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const pad = "x".repeat(16 * 1024);
    const early = JSON.stringify({
      type: "tool.completed",
      callId: "c0",
      name: "shell",
      summary: "row-0",
      output: `ONLY_EARLY_${"e".repeat(40)}`,
      role: "coder",
      at: "2026-09-22T06:00:01Z",
    });
    const rest = Array.from({ length: 40 }, (_, index) =>
      JSON.stringify({
        type: "tool.started",
        callId: `c${index + 1}`,
        name: "shell",
        summary: `row-${index + 1}`,
        role: "coder",
        at: "2026-09-22T06:00:01Z",
        pad,
      }),
    );
    writeFileSync(join(taskDir, "orchestrator.log"), `${early}\n${rest.join("\n")}\n`);
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const list = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    const detail = routes.find((r) => r.pattern.endsWith("/repair/events/:eventId"));
    if (!list || !detail) throw new Error("missing observation routes");
    const page = async (cursor: string | null) =>
      (await list.handler(
        ctx({
          round: "current",
          ...(cursor ? { cursor } : {}),
        }),
      )) as RepairObservation;
    const first = await page(null);
    expect(first.upserts.map((row) => row.summary)).not.toContain("row-0");
    expect(first.earlierCursor).not.toBeNull();
    let earlier = first.earlierCursor;
    let earlyEvent: RepairObservation["upserts"][number] | undefined;
    for (let guard = 0; earlier && guard < 30 && !earlyEvent; guard += 1) {
      const data = await page(earlier);
      earlyEvent = data.upserts.find((row) => row.summary.startsWith("row-0"));
      earlier = data.earlierCursor;
    }
    expect(earlyEvent?.eventId).toMatch(/^evt_/);
    if (!earlyEvent) throw new Error("missing earlier event");
    const body = (await detail.handler(
      ctx({}, { runId: RUN_ID, eventId: earlyEvent.eventId }),
    )) as { availability: string; body: string; reasons: string[] };
    expect(body.availability).toBe("available");
    expect(body.body).toBe(early);
    expect(body.reasons).toEqual([]);
  });

  it("opens detail for an event on a round that is not current", async () => {
    const oldDir = join(home, "squad-tasks", "task-old");
    mkdirSync(oldDir, { recursive: true });
    const line = JSON.stringify({
      type: "tool.completed",
      callId: "old-1",
      name: "shell",
      summary: "round-1-row",
      output: "ONLY_ROUND_1",
      role: "coder",
      at: "2026-09-22T05:00:01Z",
    });
    writeFileSync(join(oldDir, "orchestrator.log"), `${line}\n`);
    const currentDir = join(home, "squad-tasks", "task-1");
    patchRun({
      cycles: [
        {
          n: 1,
          phase: "done",
          childReviewId: null,
          squadTaskId: "task-old",
          squadTaskDir: oldDir,
        },
        {
          n: 2,
          phase: "active",
          childReviewId: null,
          squadTaskId: "task-1",
          squadTaskDir: currentDir,
        },
      ],
    });
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const list = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    const detail = routes.find((r) => r.pattern.endsWith("/repair/events/:eventId"));
    if (!list || !detail) throw new Error("missing observation routes");
    const past = (await list.handler(ctx({ round: "1" }))) as RepairObservation;
    const event = past.upserts.find((row) => row.summary.startsWith("round-1-row"));
    expect(event?.eventId).toMatch(/^evt_/);
    if (!event) throw new Error("missing round 1 event");
    const current = (await detail.handler(
      ctx({}, { runId: RUN_ID, eventId: event.eventId }),
    )) as { availability: string; body: string };
    expect(current.availability).toBe("unavailable");
    expect(current.body).toBe("");
    const body = (await detail.handler(
      ctx({ round: "1" }, { runId: RUN_ID, eventId: event.eventId }),
    )) as { availability: string; body: string; reasons: string[] };
    expect(body.availability).toBe("available");
    expect(body.body).toBe(line);
    expect(body.reasons).toEqual([]);
  });

  it("opens detail for an event that arrives after the first page", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const lines = Array.from({ length: 201 }, (_, index) =>
      JSON.stringify({
        type: "tool.started",
        callId: `c${index}`,
        name: "shell",
        summary: `row-${index}`,
        role: "coder",
        at: "2026-09-22T06:00:01Z",
      }),
    );
    writeFileSync(join(taskDir, "orchestrator.log"), `${lines.join("\n")}\n`);
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const list = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    const detail = routes.find((r) => r.pattern.endsWith("/repair/events/:eventId"));
    if (!list || !detail) throw new Error("missing observation routes");
    const first = (await list.handler(ctx({ round: "current" }))) as RepairObservation;
    const second = (await list.handler(
      ctx({ round: "current", cursor: first.nextCursor ?? "" }),
    )) as RepairObservation;
    const later = second.upserts.find((row) => row.summary === "row-200");
    expect(later?.eventId).toMatch(/^evt_/);
    const body = (await detail.handler(
      ctx({}, { runId: RUN_ID, eventId: later!.eventId }),
    )) as { availability: string; body: string; reasons: string[] };
    expect(body.availability).toBe("available");
    expect(body.body).toBe("row-200");
    expect(body.reasons).toEqual([]);
  });

  it("opens detail on that event's line and omits the next event", async () => {
    const taskDir = join(home, "squad-tasks", "task-1");
    const line = (callId: string, output: string) =>
      JSON.stringify({
        type: "tool.completed",
        callId,
        name: "shell",
        summary: callId,
        output,
        role: "coder",
        at: "2026-09-22T06:00:01Z",
      });
    const first = line("c0", `ONLY_FIRST_${"f".repeat(130)}`);
    const second = line("c1", `ONLY_SECOND_${"s".repeat(130)}`);
    writeFileSync(join(taskDir, "orchestrator.log"), `${first}\n${second}\n`);
    const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
    const list = routes.find((r) => r.pattern.endsWith("/repair/observation"));
    const detail = routes.find((r) => r.pattern.endsWith("/repair/events/:eventId"));
    if (!list || !detail) throw new Error("missing observation routes");
    const page = (await list.handler(ctx({ round: "current" }))) as RepairObservation;
    const later = page.upserts.find((row) => row.summary === "c1");
    expect(later?.eventId).toMatch(/^evt_/);
    const body = (await detail.handler(
      ctx({}, { runId: RUN_ID, eventId: later!.eventId }),
    )) as { availability: string; body: string; truncated: boolean };
    expect(body.availability).toBe("available");
    expect(body.body).toBe(second);
    expect(body.truncated).toBe(false);
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
