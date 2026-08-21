import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("returns findings.json on the detail payload", async () => {
    seed();
    writeFileSync(
      join(home, "runs", RUN_ID, "findings.json"),
      `${JSON.stringify({
        version: 1,
        runId: RUN_ID,
        extractedAt: "2026-08-20T00:00:00.000Z",
        sha: "abc1234",
        againstRunId: null,
        againstRange: null,
        findings: [
          {
            id: "pkg.foo.go--torn-line",
            severity: "major",
            status: "open",
            title: "torn line",
            text: "pkg/foo.go torn line",
            source: "consensus",
            reviewer: null,
            files: ["pkg/foo.go"],
          },
        ],
      })}\n`,
    );
    host = await boot();
    const detail = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}`, {
      headers: authedHeaders(host),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      ok: true;
      data: { hasFindings: boolean; findings: Array<{ id: string; status: string }> };
    };
    expect(body.data.hasFindings).toBe(true);
    expect(body.data.findings[0]?.id).toBe("pkg.foo.go--torn-line");
    expect(body.data.findings[0]?.status).toBe("open");
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

  it("POST /actions starts a fix pipeline via the injected launcher", async () => {
    seed();
    const dir = join(home, "runs", RUN_ID);
    const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8");
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${transcript}${JSON.stringify({
        kind: "review.finished",
        version: 1,
        status: "completed",
        endedAt: "2026-08-01T01:00:00.000Z",
        incomplete: false,
      })}\n`,
    );
    const launches: Array<{ action: string; runId: string }> = [];
    host = await createTestHost({
      routesFactory: (services) => {
        services.cliRunLauncher = {
          start: (input: { action: string; runId: string }) => {
            launches.push({ action: input.action, runId: input.runId });
            return { pid: 4242 };
          },
        };
        return cliRunsRoutes(services);
      },
    });
    const res = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/actions`, {
      method: "POST",
      headers: authedHeaders(host),
      body: JSON.stringify({ action: "fix" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { started: boolean; action: string } };
    expect(body.data.started).toBe(true);
    expect(body.data.action).toBe("fix");
    expect(launches).toEqual([{ action: "fix", runId: RUN_ID }]);
    const live = JSON.parse(readFileSync(join(home, "runs", RUN_ID, "status.json"), "utf8")) as {
      status: string;
      pipeline: { phase: string; summary: string };
    };
    expect(live.status).toBe("running");
    expect(live.pipeline.phase).toBe("planning");
    expect(live.pipeline.summary).toContain("探测模型");
  });

  it("POST /actions rejects an unknown action", async () => {
    seed();
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/actions`, {
      method: "POST",
      headers: authedHeaders(host),
      body: JSON.stringify({ action: "merge" }),
    });
    expect(res.status).toBe(400);
  });
});
