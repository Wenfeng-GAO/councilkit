import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRunsRoutes } from "@host/routes/cli-runs";
import { CANONICAL_HOST_HEADER } from "@shared/runtime/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "./helpers";

const RUN_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const MARKDOWN = "# Autonomous Review Report\n\nhand-written fixture\n";

let host: TestHost | null = null;
let home: string;
let oldHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-host-cli-runs-"));
  oldHome = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
});

afterEach(async () => {
  await host?.cleanup();
  host = null;
  if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
  else process.env.COUNCILKIT_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

async function boot(): Promise<TestHost> {
  host = await createTestHost({ routesFactory: () => cliRunsRoutes() });
  return host;
}

function seed(): void {
  const dir = join(home, "runs", RUN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.md"), MARKDOWN);
  writeFileSync(
    join(dir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "review.started",
      version: 1,
      runId: RUN_ID,
      startedAt: "2026-08-01T00:00:00.000Z",
      task: { task: "host-fixture" },
      attempts: [],
      aggregator: {
        attemptId: "a",
        agentId: "a",
        agentName: "A",
        driverId: "kimi-stream-json",
        modelId: "kimi-code/k3",
      },
    })}\n`,
  );
}

describe("cli-runs route", () => {
  it("rejects unauthenticated list", async () => {
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/cli-runs`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(res.status).toBe(401);
  });

  it("returns an empty list when the CLI home has no runs", async () => {
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/cli-runs`, { headers: authedHeaders(host) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { runs: unknown[] } };
    expect(body.data.runs).toEqual([]);
  });

  it("lists a fixture run and returns its markdown", async () => {
    seed();
    host = await boot();
    const list = await fetch(`${host.baseUrl}/api/v1/cli-runs`, { headers: authedHeaders(host) });
    const listed = (await list.json()) as {
      ok: true;
      data: {
        runs: Array<{
          runId: string;
          title: string;
          status: string;
          progress: { phase: string } | null;
        }>;
      };
    };
    expect(listed.data.runs).toHaveLength(1);
    expect(listed.data.runs[0].runId).toBe(RUN_ID);
    expect(listed.data.runs[0].title).toBe("host-fixture");
    expect(listed.data.runs[0].status).toBe("running");
    expect(listed.data.runs[0].progress?.phase).toBe("attempts");

    const detail = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}`, {
      headers: authedHeaders(host),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { ok: true; data: { markdown: string } };
    expect(body.data.markdown).toBe(MARKDOWN);
  });

  it("serves attempt live events with afterSeq paging and skips bad/partial lines", async () => {
    seed();
    const liveDir = join(home, "runs", RUN_ID, "live");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(
      join(liveDir, "attempt-0.jsonl"),
      [
        JSON.stringify({ seq: 1, at: "t1", type: "text.delta", text: "a" }),
        "{broken",
        JSON.stringify({ seq: 2, at: "t2", type: "tool.completed", name: "Bash", summary: "ls" }),
        '{"seq":3,"at":"t3","type":"text.delta","text":"partial',
      ].join("\n"),
    );
    host = await boot();
    const first = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/attempt-0/live`, {
      headers: authedHeaders(host),
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      ok: true;
      data: { events: Array<{ seq: number; type: string }>; nextSeq: number; done: boolean };
    };
    expect(body.data.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(body.data.nextSeq).toBe(2);
    expect(body.data.done).toBe(false);

    const page = await fetch(
      `${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/attempt-0/live?afterSeq=1`,
      { headers: authedHeaders(host) },
    );
    const paged = (await page.json()) as {
      ok: true;
      data: { events: Array<{ seq: number }>; nextSeq: number };
    };
    expect(paged.data.events.map((e) => e.seq)).toEqual([2]);
    expect(paged.data.nextSeq).toBe(2);
  });

  it("returns empty events when the live sidecar is missing", async () => {
    seed();
    host = await boot();
    const res = await fetch(
      `${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/attempt-0/live?afterSeq=4`,
      { headers: authedHeaders(host) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { events: unknown[]; nextSeq: number; done: boolean };
    };
    expect(body.data.events).toEqual([]);
    expect(body.data.nextSeq).toBe(4);
    expect(body.data.done).toBe(false);
  });

  it("rejects an illegal attemptId with 400", async () => {
    seed();
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/attempt.0/live`, {
      headers: authedHeaders(host),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer afterSeq with 400", async () => {
    seed();
    host = await boot();
    const res = await fetch(
      `${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/attempt-0/live?afterSeq=-1`,
      { headers: authedHeaders(host) },
    );
    expect(res.status).toBe(400);
  });

  it("marks done when the run is no longer running", async () => {
    seed();
    writeFileSync(
      join(home, "runs", RUN_ID, "status.json"),
      `${JSON.stringify({
        version: 1,
        status: "completed",
        progress: { phase: "done", attempts: [], updatedAt: "t" },
      })}\n`,
    );
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/aggregator/live`, {
      headers: authedHeaders(host),
    });
    const body = (await res.json()) as { ok: true; data: { done: boolean; events: unknown[] } };
    expect(body.data.done).toBe(true);
    expect(body.data.events).toEqual([]);
  });

  it("rejects path traversal and skips a symlinked run dir", async () => {
    seed();
    const outside = join(home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "report.md"), "secret\n");
    symlinkSync(outside, join(home, "runs", "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2"));
    host = await boot();

    const traversal = await fetch(`${host.baseUrl}/api/v1/cli-runs/..%2Fetc%2Fpasswd`, {
      headers: authedHeaders(host),
    });
    expect([400, 404]).toContain(traversal.status);

    const listed = await fetch(`${host.baseUrl}/api/v1/cli-runs`, { headers: authedHeaders(host) });
    const body = (await listed.json()) as { ok: true; data: { runs: Array<{ runId: string }> } };
    expect(body.data.runs.map((r) => r.runId)).toEqual([RUN_ID]);
  });
});
