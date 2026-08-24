import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRunLaunchRequest } from "@host/cli-launcher";
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

  it("refills empty status.json attempts from the transcript so process stays inspectable", async () => {
    seed();
    writeFileSync(
      join(home, "runs", RUN_ID, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "review.started",
        version: 1,
        runId: RUN_ID,
        startedAt: "2026-08-01T00:00:00.000Z",
        task: { task: "host-fixture" },
        attempts: [
          {
            attemptId: "attempt-0",
            agentId: "a",
            agentName: "review-security",
            driverId: "claude-stream-json",
            modelId: "m",
          },
        ],
        aggregator: {
          attemptId: "aggregator",
          agentId: "a",
          agentName: "review-security",
          driverId: "claude-stream-json",
          modelId: "m",
        },
      })}\n${JSON.stringify({
        kind: "attempt.finished",
        attemptId: "attempt-0",
        status: "success",
        durationMs: 12,
      })}\n${JSON.stringify({
        kind: "aggregation.finished",
        status: "success",
        durationMs: 4,
      })}\n`,
    );
    writeFileSync(
      join(home, "runs", RUN_ID, "status.json"),
      `${JSON.stringify({
        version: 1,
        status: "completed",
        progress: { phase: "done", attempts: [], updatedAt: "t-done" },
        pipeline: {
          phase: "done",
          round: 0,
          maxRounds: 2,
          planVerdict: null,
          applyStatus: "skipped",
          followUpRunId: "ck-review-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          summary: "follow-up",
          updatedAt: "t-done",
        },
      })}\n`,
    );
    host = await boot();
    const detail = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}`, {
      headers: authedHeaders(host),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      ok: true;
      data: {
        status: string;
        progress: {
          phase: string;
          attempts: Array<{ attemptId: string; agentName: string; status: string }>;
        } | null;
      };
    };
    expect(body.data.status).toBe("completed");
    expect(body.data.progress?.phase).toBe("done");
    expect(body.data.progress?.attempts.map((row) => row.attemptId)).toEqual([
      "attempt-0",
      "aggregator",
    ]);
    expect(body.data.progress?.attempts[0]?.status).toBe("success");
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

  it("lists a squad observe run and refuses fix actions", async () => {
    const squadId = "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9";
    const dir = join(home, "runs", squadId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "squad.started",
        version: 1,
        runId: squadId,
        startedAt: "2026-08-24T00:00:00.000Z",
        task: { taskId: "20260824-observe-ab12" },
      })}\n`,
    );
    writeFileSync(join(dir, "report.md"), "# Squad · fixture\n");
    writeFileSync(
      join(dir, "status.json"),
      `${JSON.stringify({
        version: 1,
        status: "running",
        progress: { phase: "briefing", attempts: [], updatedAt: "t" },
        pipeline: null,
      })}\n`,
    );
    host = await boot();
    const list = await fetch(`${host.baseUrl}/api/v1/cli-runs`, { headers: authedHeaders(host) });
    const listed = (await list.json()) as {
      ok: true;
      data: { runs: Array<{ runId: string; kind: string }> };
    };
    expect(listed.data.runs.some((run) => run.runId === squadId && run.kind === "squad")).toBe(
      true,
    );
    const action = await fetch(`${host.baseUrl}/api/v1/cli-runs/${squadId}/actions`, {
      method: "POST",
      headers: { ...authedHeaders(host), "content-type": "application/json" },
      body: JSON.stringify({ action: "fix" }),
    });
    expect(action.status).toBe(400);
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
    const launches: CliRunLaunchRequest[] = [];
    host = await createTestHost({
      routesFactory: (services) => {
        services.cliRunLauncher = {
          start: (input: CliRunLaunchRequest) => {
            launches.push(input);
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
    expect(launches).toHaveLength(1);
    expect(launches[0]?.action).toBe("fix");
    expect(launches[0]?.runId).toBe(RUN_ID);
    expect(existsSync(join(dir, "pipeline.pid"))).toBe(true);
    expect(readFileSync(join(dir, "pipeline.pid"), "utf8").trim()).toBe("4242");
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

  it("POST /actions still 409 when that run's pipeline pid is alive", async () => {
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
    writeFileSync(join(dir, "pipeline.pid"), `${String(process.pid)}\n`);
    host = await createTestHost({
      routesFactory: (services) => {
        services.cliRunLauncher = {
          start: () => {
            throw new Error("launcher must not start when pipeline pid is alive");
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
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
    expect(body.error.code).toBe("EXECUTION_CONFLICT");
    expect(body.error.message).toContain("already running");
  });
});

const GH_PR = "https://github.com/acme/repo/pull/1";

function seedPrJury(): void {
  writeFileSync(
    join(home, "councils.json"),
    `${JSON.stringify({
      format: "councilkit-councils",
      version: 1,
      councils: [
        {
          id: "pr-jury",
          name: "pr-jury",
          topic: "jury",
          background: "",
          targetOutput: "",
          agentIds: ["a"],
          rounds: 1,
          reporterAgentId: "a",
        },
      ],
    })}\n`,
  );
}

async function bootStartReview(start?: (input: CliRunLaunchRequest) => { pid: number }): Promise<{
  launches: CliRunLaunchRequest[];
}> {
  const launches: CliRunLaunchRequest[] = [];
  host = await createTestHost({
    routesFactory: (services) => {
      services.cliRunLauncher = {
        start: (input: CliRunLaunchRequest) => {
          launches.push(input);
          return start ? start(input) : { pid: 4242 };
        },
      };
      return cliRunsRoutes(services);
    },
  });
  return { launches };
}

describe("POST /api/v1/cli-runs start review", () => {
  it("POST /api/v1/cli-runs without session cookie returns 401 UNAUTHENTICATED", async () => {
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: {
        Host: CANONICAL_HOST_HEADER,
        Origin: "http://127.0.0.1:43127",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pr: GH_PR }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(launches).toEqual([]);
  });

  it("POST /api/v1/cli-runs with session but missing x-councilkit-csrf returns 403 CSRF_MISMATCH", async () => {
    const { launches } = await bootStartReview();
    const headers = authedHeaders(host as TestHost);
    const { "x-councilkit-csrf": _csrf, ...withoutCsrf } = headers;
    void _csrf;
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: withoutCsrf,
      body: JSON.stringify({ pr: GH_PR }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe("CSRF_MISMATCH");
    expect(launches).toEqual([]);
  });

  it("POST /api/v1/cli-runs body { pr, extra: 1 } returns 400 (strict DTO)", async () => {
    seedPrJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR, extra: 1 }),
    });
    expect(res.status).toBe(400);
    expect(launches).toEqual([]);
  });

  it("POST /api/v1/cli-runs rejects a non GitHub/AntCode URL before spawn", async () => {
    seedPrJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: "https://example.com/x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(launches).toEqual([]);
  });

  it("POST /api/v1/cli-runs with a GitHub PR and pr-jury returns 200 and spawns review", async () => {
    seedPrJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { runId: string; started: true };
    };
    expect(body.data.started).toBe(true);
    expect(body.data.runId).toMatch(/^ck-review-[0-9a-fA-F-]+$/);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.action).toBe("review");
    expect(launches[0]?.pr).toBe(GH_PR);
    expect(launches[0]?.runId).toBe(body.data.runId);
    expect(launches[0]?.action).not.toBe("fix");
  });

  it("POST /api/v1/cli-runs passes repo through to launcher.start", async () => {
    seedPrJury();
    const { launches } = await bootStartReview();
    const repo = "/abs/path/to/checkout";
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR, repo }),
    });
    expect(res.status).toBe(200);
    expect(launches[0]?.repo).toBe(repo);
  });

  it("POST /api/v1/cli-runs rejects repo --against (argv-injection guard)", async () => {
    seedPrJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR, repo: "--against" }),
    });
    expect(res.status).toBe(400);
    expect(launches).toEqual([]);
  });

  it("two overlapping POST /api/v1/cli-runs both return 200 with distinct runIds and no pipeline.pid", async () => {
    seedPrJury();
    const { launches } = await bootStartReview();
    const headers = authedHeaders(host as TestHost);
    const [first, second] = await Promise.all([
      fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pr: GH_PR }),
      }),
      fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pr: "https://github.com/acme/other/pull/2" }),
      }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { ok: true; data: { runId: string } };
    const b = (await second.json()) as { ok: true; data: { runId: string } };
    expect(a.data.runId).not.toBe(b.data.runId);
    expect(launches).toHaveLength(2);
    expect(existsSync(join(home, "runs", a.data.runId, "pipeline.pid"))).toBe(false);
    expect(existsSync(join(home, "runs", b.data.runId, "pipeline.pid"))).toBe(false);
  });

  it("POST /api/v1/cli-runs create still 200 when another ck-review fixture is running", async () => {
    seed();
    seedPrJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { runId: string } };
    expect(body.data.runId).not.toBe(RUN_ID);
    expect(launches).toHaveLength(1);
    expect(existsSync(join(home, "runs", RUN_ID, "pipeline.pid"))).toBe(false);
  });

  it("POST /api/v1/cli-runs missing councils.json tells the user to run councilkit init", async () => {
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { message: string } };
    expect(body.error.message).toContain("councilkit init");
    expect(launches).toEqual([]);
  });

  it("POST /api/v1/cli-runs maps no local clone to 400 with project key and CLI hint", async () => {
    seedPrJury();
    const { launches } = await bootStartReview(() => {
      throw new Error("no local clone for acme/repo");
    });
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { message: string } };
    expect(body.error.message).toContain("acme/repo");
    expect(body.error.message).toContain("councilkit review");
    expect(launches).toHaveLength(1);
  });
});
