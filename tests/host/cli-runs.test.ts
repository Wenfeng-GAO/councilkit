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
import {
  createRepairGrant,
  revokeRepairProfile,
  saveRepairProfile,
} from "../../cli/src/auto/repair-profile";
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

  it("maps interrupted squad with terminal seats to awaiting_orchestrator and returns handoff", async () => {
    const squadId = "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee8";
    const dir = join(home, "runs", squadId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "squad.started",
        version: 1,
        runId: squadId,
        startedAt: "2026-08-24T00:00:00.000Z",
        task: { taskId: "20260824-pr126-cmfix-k4p2" },
      })}\n`,
    );
    writeFileSync(join(dir, "report.md"), "# Squad · k4p2\n");
    writeFileSync(
      join(dir, "status.json"),
      `${JSON.stringify({
        version: 1,
        status: "interrupted",
        progress: {
          phase: "snapshotting",
          updatedAt: "t",
          attempts: [
            {
              attemptId: "coder-0",
              agentName: "coder",
              driverId: "grokb",
              modelId: "grok-4.6",
              role: "attempt",
              status: "success",
              durationMs: 12,
              lastActivity: "}",
            },
          ],
        },
        pipeline: null,
        handoff: {
          epoch: 9,
          candidateSha: "636e4b58deadbeef",
          candidateStatus: "invalidated",
          approved: false,
          next: "approved_paths relative to parent",
        },
      })}\n`,
    );
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/cli-runs/${squadId}`, {
      headers: authedHeaders(host),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: {
        status: string;
        kind: string;
        handoff: { epoch: number; candidateStatus: string } | null;
      };
    };
    expect(body.data.kind).toBe("squad");
    expect(body.data.status).toBe("awaiting_orchestrator");
    expect(body.data.handoff?.epoch).toBe(9);
    expect(body.data.handoff?.candidateStatus).toBe("invalidated");
  });

  it("returns squad brief and plan documents on detail", async () => {
    const squadId = "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee7";
    const dir = join(home, "runs", squadId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "squad.started",
        version: 1,
        runId: squadId,
        startedAt: "2026-08-25T00:00:00.000Z",
        task: { taskId: "20260825-observe-docs" },
      })}\n`,
    );
    writeFileSync(join(dir, "report.md"), "# Squad · docs\n");
    writeFileSync(join(dir, "brief.md"), "# Brief\n\nLock occupancy.\n");
    writeFileSync(join(dir, "plan.md"), "# Plan\n\nC1 then C2.\n");
    writeFileSync(
      join(dir, "status.json"),
      `${JSON.stringify({
        version: 1,
        status: "awaiting_orchestrator",
        progress: { phase: "reviewing", attempts: [], updatedAt: "t" },
        pipeline: null,
      })}\n`,
    );
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/cli-runs/${squadId}`, {
      headers: authedHeaders(host),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { documents: Array<{ id: string; title: string; markdown: string }> };
    };
    expect(body.data.documents.map((doc) => doc.id)).toEqual(["brief", "plan"]);
    expect(body.data.documents[0]?.markdown).toContain("Lock occupancy.");
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
          return start ? start(input) : { pid: process.pid };
        },
      };
      return cliRunsRoutes(services);
    },
  });
  return { launches };
}

describe("GET /api/v1/cli-runs/:runId/attempts/:attemptId/result", () => {
  const SEAT_A = {
    attemptId: "attempt-0",
    agentId: "a",
    agentName: "review-security",
    driverId: "claude-stream-json",
    modelId: "m",
  };
  const SEAT_B = {
    attemptId: "attempt-1",
    agentId: "b",
    agentName: "review-correctness",
    driverId: "kimi-stream-json",
    modelId: "k",
  };
  const AGGREGATOR = {
    attemptId: "aggregator",
    agentId: "b",
    agentName: "review-correctness",
    driverId: "kimi-stream-json",
    modelId: "k",
  };

  function seedTranscript(records: unknown[]): void {
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), MARKDOWN);
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
  }

  function startedRecord(): unknown {
    return {
      kind: "review.started",
      version: 1,
      runId: RUN_ID,
      startedAt: "2026-09-20T00:00:00.000Z",
      task: { task: "result-fixture" },
      attempts: [SEAT_A, SEAT_B],
      aggregator: AGGREGATOR,
    };
  }

  function finishedRecord(
    attemptId: string,
    status: "success" | "failure",
    extra: Record<string, unknown> = {},
  ): unknown {
    return {
      kind: "attempt.finished",
      version: 1,
      attemptId,
      agentName: "review-security",
      driverId: "claude-stream-json",
      status,
      output: status === "success" ? "output" : null,
      exitCode: status === "success" ? 0 : 1,
      durationMs: 10,
      ...extra,
    };
  }

  function aggregationRecord(output: string): unknown {
    return {
      kind: "aggregation.finished",
      version: 1,
      attemptId: "aggregator",
      agentName: "review-correctness",
      driverId: "kimi-stream-json",
      status: "success",
      output,
      exitCode: 0,
      durationMs: 5,
    };
  }

  async function getResult(
    attemptId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(
      `${host?.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/${attemptId}/result`,
      { headers: authedHeaders(host as TestHost) },
    );
    const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown> };
    return { status: res.status, body: body.data ?? (body as unknown as Record<string, unknown>) };
  }

  it("returns the full durable output far beyond the detail API's 256KB scan cap", async () => {
    const big = "x".repeat(300 * 1024);
    seedTranscript([startedRecord(), finishedRecord("attempt-0", "success", { output: big })]);
    host = await boot();
    const { status, body } = await getResult("attempt-0");
    expect(status).toBe(200);
    expect(body.executionRef).toBe("attempt-0#1.1");
    expect(body.executionStatus).toBe("success");
    expect(body.availability).toBe("available");
    expect(body.markdown).toBe(big);
    expect(body.truncated).toBe(false);
    expect(body.failure).toBeNull();
    expect(body.reusedFrom).toBeNull();
  });

  it("serves the retried success, never the earlier failure, for the same attemptId", async () => {
    seedTranscript([
      startedRecord(),
      finishedRecord("attempt-0", "failure", {
        attemptNumber: 1,
        exitCode: 1,
        durationMs: 5_000,
        failure: { code: "EXIT", message: "non-zero exit 1" },
      }),
      finishedRecord("attempt-0", "success", {
        output: "retry-success-body",
        attemptNumber: 2,
        retryOf: 1,
      }),
    ]);
    host = await boot();
    const { status, body } = await getResult("attempt-0");
    expect(status).toBe(200);
    expect(body.executionRef).toBe("attempt-0#1.2");
    expect(body.executionStatus).toBe("success");
    expect(body.markdown).toBe("retry-success-body");
    expect(body.failure).toBeNull();
  });

  it("returns failure details for a terminal failure and maps CANCELLED to cancelled", async () => {
    seedTranscript([
      startedRecord(),
      finishedRecord("attempt-0", "failure", {
        attemptNumber: 1,
        failure: { code: "NO_OUTPUT", message: "no final output extracted" },
      }),
      finishedRecord("attempt-1", "failure", {
        attemptNumber: 1,
        failure: { code: "CANCELLED", message: "run aborted before this attempt started" },
      }),
    ]);
    host = await boot();
    const failed = await getResult("attempt-0");
    expect(failed.status).toBe(200);
    expect(failed.body.executionRef).toBe("attempt-0#1.1");
    expect(failed.body.executionStatus).toBe("failure");
    expect(failed.body.availability).toBe("unavailable");
    expect(failed.body.markdown).toBeNull();
    expect(failed.body.failure).toEqual({
      code: "NO_OUTPUT",
      message: "no final output extracted",
    });

    const cancelled = await getResult("attempt-1");
    expect(cancelled.body.executionStatus).toBe("cancelled");
    expect(cancelled.body.availability).toBe("unavailable");
  });

  it("returns reusedFrom for seats explicitly reused via reusedAttemptIds", async () => {
    seedTranscript([
      startedRecord(),
      finishedRecord("attempt-0", "success", { output: "reusable-body", attemptNumber: 1 }),
      {
        kind: "review.resumed",
        version: 1,
        runId: RUN_ID,
        resumedAt: "2026-09-20T01:00:00.000Z",
        reusedAttemptIds: ["attempt-0"],
        rerunAttemptIds: ["attempt-1"],
        probe: [],
      },
      finishedRecord("attempt-1", "success", { output: "fresh-body", attemptNumber: 1 }),
    ]);
    host = await boot();
    const { status, body } = await getResult("attempt-0");
    expect(status).toBe(200);
    expect(body.executionRef).toBe("attempt-0#1.1");
    expect(body.availability).toBe("available");
    expect(body.markdown).toBe("reusable-body");
    expect(body.reusedFrom).toEqual({ runId: RUN_ID, executionRef: "attempt-0#1.1" });

    const fresh = await getResult("attempt-1");
    expect(fresh.body.executionRef).toBe("attempt-1#2.1");
    expect(fresh.body.reusedFrom).toBeNull();
    expect(fresh.body.markdown).toBe("fresh-body");
  });

  it("reports pending with the prospective ref while a resumed rerun is in flight", async () => {
    seedTranscript([
      startedRecord(),
      finishedRecord("attempt-0", "failure", {
        attemptNumber: 1,
        failure: { code: "NO_OUTPUT", message: "nothing" },
      }),
      {
        kind: "review.resumed",
        version: 1,
        runId: RUN_ID,
        resumedAt: "2026-09-20T01:00:00.000Z",
        reusedAttemptIds: ["attempt-1"],
        rerunAttemptIds: ["attempt-0"],
        probe: [],
      },
    ]);
    host = await boot();
    const { status, body } = await getResult("attempt-0");
    expect(status).toBe(200);
    expect(body.executionRef).toBe("attempt-0#2.1");
    expect(body.executionStatus).toBe("queued");
    expect(body.availability).toBe("pending");
    expect(body.markdown).toBeNull();
    expect(body.reusedFrom).toBeNull();
  });

  it("distinguishes the pending aggregator from seats and reads its durable summary", async () => {
    seedTranscript([
      startedRecord(),
      finishedRecord("attempt-0", "success", { output: "seat-body" }),
    ]);
    host = await boot();
    const pending = await getResult("aggregator");
    expect(pending.status).toBe(200);
    expect(pending.body.executionRef).toBe("aggregator#1.1");
    expect(pending.body.executionStatus).toBe("pending");
    expect(pending.body.availability).toBe("pending");

    seedTranscript([
      startedRecord(),
      finishedRecord("attempt-0", "success", { output: "seat-body" }),
      aggregationRecord("aggregated-markdown"),
    ]);
    const done = await getResult("aggregator");
    expect(done.body.executionRef).toBe("aggregator#1.1");
    expect(done.body.executionStatus).toBe("success");
    expect(done.body.availability).toBe("available");
    expect(done.body.markdown).toBe("aggregated-markdown");
  });

  it("reports empty for a terminal success with an empty persisted output", async () => {
    seedTranscript([startedRecord(), finishedRecord("attempt-0", "success", { output: "" })]);
    host = await boot();
    const { status, body } = await getResult("attempt-0");
    expect(status).toBe(200);
    expect(body.executionStatus).toBe("success");
    expect(body.availability).toBe("empty");
    expect(body.markdown).toBeNull();
  });

  it("keeps the seat pending before any terminal record exists", async () => {
    seedTranscript([startedRecord()]);
    host = await boot();
    const { status, body } = await getResult("attempt-0");
    expect(status).toBe(200);
    expect(body.executionRef).toBe("attempt-0#1.1");
    expect(body.executionStatus).toBe("queued");
    expect(body.availability).toBe("pending");
    expect(body.markdown).toBeNull();
  });

  it("returns unavailable (not pending forever) when the run ended without a seat record", async () => {
    seedTranscript([
      startedRecord(),
      finishedRecord("attempt-0", "success", { output: "seat-body" }),
      finishedRecord("attempt-1", "failure", {
        attemptNumber: 1,
        failure: { code: "NO_OUTPUT", message: "nothing" },
      }),
      {
        kind: "review.finished",
        version: 1,
        status: "failed",
        endedAt: "2026-09-20T02:00:00.000Z",
        incomplete: true,
      },
    ]);
    host = await boot();
    const { status, body } = await getResult("aggregator");
    expect(status).toBe(200);
    expect(body.executionStatus).toBe("failure");
    expect(body.availability).toBe("unavailable");
    expect(body.markdown).toBeNull();
  });

  it("returns unavailable with a sentinel ref for a corrupt transcript line", async () => {
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript.jsonl"), `${JSON.stringify(startedRecord())}\n{not-json\n`);
    host = await boot();
    const { status, body } = await getResult("attempt-0");
    expect(status).toBe(200);
    expect(body.executionRef).toBe("attempt-0#0.0");
    expect(body.availability).toBe("unavailable");
    expect(body.markdown).toBeNull();
  });

  it("rejects unknown attempts with 404 and bad attempt ids with 400", async () => {
    seedTranscript([startedRecord()]);
    host = await boot();
    const unknown = await getResult("attempt-9");
    expect(unknown.status).toBe(404);
    const bad = await fetch(`${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/attempt.0/result`, {
      headers: authedHeaders(host),
    });
    expect(bad.status).toBe(400);
    const badRun = await fetch(
      `${host.baseUrl}/api/v1/cli-runs/not-a-run/attempts/attempt-0/result`,
      { headers: authedHeaders(host) },
    );
    expect(badRun.status).toBe(400);
  });

  it("requires session auth and refuses a missing transcript", async () => {
    seedTranscript([startedRecord()]);
    host = await boot();
    const unauth = await fetch(
      `${host.baseUrl}/api/v1/cli-runs/${RUN_ID}/attempts/attempt-0/result`,
      { headers: { Host: CANONICAL_HOST_HEADER } },
    );
    expect(unauth.status).toBe(401);

    const missing = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
    mkdirSync(join(home, "runs", missing), { recursive: true });
    const res = await fetch(
      `${host.baseUrl}/api/v1/cli-runs/${missing}/attempts/attempt-0/result`,
      { headers: authedHeaders(host) },
    );
    expect(res.status).toBe(404);
  });

  it("404s a symlinked run dir instead of reading through it", async () => {
    seedTranscript([startedRecord()]);
    const outside = join(home, "outside-result");
    mkdirSync(outside);
    writeFileSync(join(outside, "transcript.jsonl"), `${JSON.stringify(startedRecord())}\n`);
    symlinkSync(outside, join(home, "runs", "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2"));
    host = await boot();
    const res = await fetch(
      `${host.baseUrl}/api/v1/cli-runs/ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2/attempts/attempt-0/result`,
      { headers: authedHeaders(host) },
    );
    expect(res.status).toBe(404);
  });
});

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

  it("launches a custom Codex roster without requiring pr-jury", async () => {
    const { launches } = await bootStartReview();
    const reviewModels = {
      models: [
        { modelId: "gpt-6-astra", driverSelection: { driverId: "codex-app-server", options: {} } },
      ],
      aggregatorIndex: 0,
    };
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR, reviewModels }),
    });
    expect(res.status).toBe(200);
    expect(launches[0]?.reviewModels).toEqual(reviewModels);
  });

  it.each([
    { models: [], aggregatorIndex: 0 },
    {
      models: [
        { modelId: "gpt-6-astra", driverSelection: { driverId: "codex-app-server", options: {} } },
      ],
      aggregatorIndex: 1,
    },
    {
      models: [
        {
          modelId: "gpt-6-astra",
          driverSelection: { driverId: "codex-app-server", options: { executable: "/tmp/bad" } },
        },
      ],
      aggregatorIndex: 0,
    },
  ])("rejects invalid custom roster before launch: %j", async (reviewModels) => {
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR, reviewModels }),
    });
    expect(res.status).toBe(400);
    expect(launches).toHaveLength(0);
  });

  it("POST /api/v1/cli-runs passes against through to launcher.start", async () => {
    seedPrJury();
    const { launches } = await bootStartReview();
    const against = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR, against }),
    });
    expect(res.status).toBe(200);
    expect(launches[0]?.against).toBe(against);
  });

  it("POST /api/v1/cli-runs rejects a non-review against id", async () => {
    seedPrJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ pr: GH_PR, against: "--repo" }),
    });
    expect(res.status).toBe(400);
    expect(launches).toEqual([]);
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

function seedProductJury(): void {
  writeFileSync(
    join(home, "councils.json"),
    `${JSON.stringify({
      format: "councilkit-councils",
      version: 1,
      councils: [
        {
          id: "product-jury",
          name: "product-jury",
          topic: "ideate",
          background: "",
          targetOutput: "",
          agentIds: ["p", "e"],
          rounds: 1,
          reporterAgentId: "p",
        },
      ],
    })}\n`,
  );
}

describe("POST /api/v1/cli-runs/ideate", () => {
  it("rejects an empty idea after trim", async () => {
    seedProductJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/ideate`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ idea: "   " }),
    });
    expect(res.status).toBe(400);
    expect(launches).toEqual([]);
  });

  it("rejects extra fields", async () => {
    seedProductJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/ideate`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ idea: "weekly feedback", extra: 1 }),
    });
    expect(res.status).toBe(400);
    expect(launches).toEqual([]);
  });

  it("requires product-jury when models are omitted", async () => {
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/ideate`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ idea: "weekly feedback" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { message: string } };
    expect(body.error.message).toContain("product-jury");
    expect(launches).toEqual([]);
  });

  it("spawns ideate with idea, background and debate rounds", async () => {
    seedProductJury();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/ideate`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({
        idea: "weekly feedback sorter",
        background: "solo builder, two weeks",
        debateRounds: 1,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { runId: string; started: true } };
    expect(body.data.started).toBe(true);
    expect(body.data.runId).toMatch(/^ck-ideate-[0-9a-fA-F-]+$/);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      action: "ideate",
      idea: "weekly feedback sorter",
      background: "solo builder, two weeks",
      debateRounds: 1,
      runId: body.data.runId,
    });
  });

  it("keeps special characters in the idea and does not shell-join", async () => {
    seedProductJury();
    const { launches } = await bootStartReview();
    const idea = `quotes "and" $HOME; rm -rf /`;
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/ideate`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ idea }),
    });
    expect(res.status).toBe(200);
    expect(launches[0]?.idea).toBe(idea);
  });
});

describe("POST /api/v1/cli-runs/repair", () => {
  function seedRepairProfile(): void {
    saveRepairProfile({
      name: "default",
      prUrl: GH_PR,
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      base: "main",
      capabilities: ["push-source-branch"],
    });
  }

  it("starts a new parent run and does not write pipeline.pid on the source review", async () => {
    seed();
    seedRepairProfile();
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ from: RUN_ID, profile: "default" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { runId: string; started: true } };
    expect(body.data.started).toBe(true);
    expect(body.data.runId).toMatch(/^ck-repair-[0-9a-fA-F-]+$/);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.action).toBe("repair");
    expect(launches[0]?.runId).toBe(body.data.runId);
    expect(launches[0]?.from).toBe(RUN_ID);
    expect(launches[0]?.profile).toBe("default");
    expect(existsSync(join(home, "runs", RUN_ID, "pipeline.pid"))).toBe(false);
    const sourceStatus = existsSync(join(home, "runs", RUN_ID, "status.json"))
      ? readFileSync(join(home, "runs", RUN_ID, "status.json"), "utf8")
      : null;
    expect(sourceStatus).toBeNull();
  });

  it("returns the same active parent run on a repeated mutation without a second spawn", async () => {
    seed();
    seedRepairProfile();
    const { launches } = await bootStartReview();
    const headers = authedHeaders(host as TestHost);
    const first = await fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: RUN_ID, profile: "default" }),
    });
    const second = await fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: RUN_ID, profile: "default" }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { ok: true; data: { runId: string } };
    const b = (await second.json()) as { ok: true; data: { runId: string } };
    expect(a.data.runId).toBe(b.data.runId);
    expect(launches).toHaveLength(1);
  });

  it("serializes overlapping POSTs onto one parent id", async () => {
    seed();
    seedRepairProfile();
    const { launches } = await bootStartReview();
    const headers = authedHeaders(host as TestHost);
    const [first, second] = await Promise.all([
      fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
        method: "POST",
        headers,
        body: JSON.stringify({ from: RUN_ID, profile: "default" }),
      }),
      fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
        method: "POST",
        headers,
        body: JSON.stringify({ from: RUN_ID, profile: "default" }),
      }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { ok: true; data: { runId: string } };
    const b = (await second.json()) as { ok: true; data: { runId: string } };
    expect(a.data.runId).toBe(b.data.runId);
    expect(launches).toHaveLength(1);
  });

  it("rejects missing CSRF", async () => {
    seed();
    seedRepairProfile();
    const { launches } = await bootStartReview();
    const headers = authedHeaders(host as TestHost);
    const { "x-councilkit-csrf": _csrf, ...withoutCsrf } = headers;
    void _csrf;
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
      method: "POST",
      headers: withoutCsrf,
      body: JSON.stringify({ from: RUN_ID, profile: "default" }),
    });
    expect(res.status).toBe(403);
    expect(launches).toEqual([]);
  });

  it("rejects argv or authorized booleans in the start body", async () => {
    seed();
    seedRepairProfile();
    const { launches } = await bootStartReview();
    const headers = authedHeaders(host as TestHost);
    const withArgv = await fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: RUN_ID, profile: "default", argv: ["-c", "curl evil"] }),
    });
    const withAuth = await fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: RUN_ID, profile: "default", authorized: true }),
    });
    expect(withArgv.status).toBe(400);
    expect(withAuth.status).toBe(400);
    expect(launches).toEqual([]);
  });

  it("returns the minted parent id when handshake times out after the CLI created the directory", async () => {
    seed();
    seedRepairProfile();
    const { launches } = await bootStartReview((input) => {
      const dir = join(home, "runs", input.runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "repair.json"),
        `${JSON.stringify({
          version: 1,
          casVersion: 0,
          sourceRunId: RUN_ID,
          profileName: "default",
          outerUsed: 0,
          outerMax: 10,
          timeoutMs: null,
          businessResult: null,
          reasonCode: null,
        })}\n`,
      );
      writeFileSync(join(dir, "pipeline.pid"), `${String(process.pid)}\n`);
      writeFileSync(
        join(dir, "status.json"),
        `${JSON.stringify({
          version: 1,
          status: "running",
          progress: {
            phase: "repair-preparing",
            attempts: [],
            updatedAt: new Date().toISOString(),
          },
          pipeline: null,
        })}\n`,
      );
      throw Object.assign(new Error("repair handshake timed out waiting for the run directory"), {
        code: "HANDSHAKE_TIMEOUT",
      });
    });
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ from: RUN_ID, profile: "default" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { runId: string } };
    expect(launches).toHaveLength(1);
    expect(body.data.runId).toBe(launches[0]?.runId);
    expect(existsSync(join(home, "runs", RUN_ID, "pipeline.pid"))).toBe(false);
  });

  it("refuses resume after the profile grant is revoked", async () => {
    seed();
    const profile = saveRepairProfile({
      name: "default",
      prUrl: GH_PR,
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      base: "main",
      capabilities: ["push-source-branch"],
    });
    const grant = createRepairGrant(profile);
    const repairId = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
    const dir = join(home, "runs", repairId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "repair-grant.json"), `${JSON.stringify(grant, null, 2)}\n`);
    writeFileSync(
      join(dir, "repair.json"),
      `${JSON.stringify({
        version: 1,
        casVersion: 0,
        sourceRunId: RUN_ID,
        profileName: "default",
        outerUsed: 0,
        outerMax: 10,
        timeoutMs: null,
        businessResult: null,
        reasonCode: null,
      })}\n`,
    );
    revokeRepairProfile("default");
    const { launches } = await bootStartReview();
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/${repairId}/repair/resume`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(launches).toEqual([]);
    const body = (await res.json()) as { ok: false; error: { message: string } };
    expect(body.error.message).toMatch(/revok/i);
  });

  it("stops via repair stop and does not touch the source review pid", async () => {
    seed();
    seedRepairProfile();
    const { launches } = await bootStartReview();
    const started = await fetch(`${host?.baseUrl}/api/v1/cli-runs/repair`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({ from: RUN_ID, profile: "default" }),
    });
    const created = (await started.json()) as { ok: true; data: { runId: string } };
    const res = await fetch(`${host?.baseUrl}/api/v1/cli-runs/${created.data.runId}/repair/stop`, {
      method: "POST",
      headers: authedHeaders(host as TestHost),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(launches.at(-1)?.action).toBe("repair-stop");
    expect(launches.at(-1)?.runId).toBe(created.data.runId);
    expect(existsSync(join(home, "runs", RUN_ID, "pipeline.pid"))).toBe(false);
  });
});
