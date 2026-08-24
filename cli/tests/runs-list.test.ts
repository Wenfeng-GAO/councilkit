/**
 * `councilkit runs list|open` — fixture directories, no real reviews.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRuns } from "../src/commands/runs";
import { CliError } from "../src/errors";

const REVIEW_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const DISCUSS_ID = "ck-run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const SQUAD_ID = "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";

interface FakeSink {
  json: boolean;
  lines: string[];
  finished: unknown;
  progress(m: string): void;
  diag(m: string): void;
  finish(d: unknown): Promise<void>;
}

function makeSink(): FakeSink {
  const sink: FakeSink = {
    json: false,
    lines: [],
    finished: undefined,
    progress: (m) => sink.lines.push(m),
    diag: () => {},
    finish: (d) => {
      sink.finished = d;
      return Promise.resolve();
    },
  };
  return sink;
}

describe("cli runs list/open", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-runs-list-"));
    oldHome = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  function seedReview(): void {
    const dir = join(home, "runs", REVIEW_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "review.started",
        version: 1,
        runId: REVIEW_ID,
        startedAt: "2026-08-01T00:00:00.000Z",
        task: { pr: "https://github.com/acme/repo/pull/9" },
        attempts: [],
        aggregator: {
          attemptId: "a",
          agentId: "a",
          agentName: "A",
          driverId: "kimi-stream-json",
          modelId: "kimi-code/k3",
        },
      })}\n${JSON.stringify({
        kind: "review.finished",
        version: 1,
        status: "completed",
        endedAt: "2026-08-01T00:10:00.000Z",
      })}\n`,
    );
    writeFileSync(join(dir, "report.md"), "# Autonomous Review Report\n\nfixture body\n");
  }

  function seedDiscuss(): void {
    const dir = join(home, "runs", DISCUSS_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "run.started",
        version: 1,
        runId: DISCUSS_ID,
        startedAt: "2026-08-02T00:00:00.000Z",
        council: {
          id: "c",
          name: "board",
          topic: "Should we ship?",
          background: "",
          targetOutput: "",
          rounds: 2,
          reporterAgentId: "r",
          agentIds: ["r"],
        },
        agents: [],
        installationId: "i",
        installations: {},
      })}\n`,
    );
    writeFileSync(join(dir, "report.md"), "# Decision Report\n");
  }

  function seedSquad(): void {
    const dir = join(home, "runs", SQUAD_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "squad.started",
        version: 1,
        runId: SQUAD_ID,
        startedAt: "2026-08-03T00:00:00.000Z",
        task: { taskId: "20260824-observe-ab12" },
      })}\n`,
    );
    writeFileSync(join(dir, "report.md"), "# Squad · 20260824-observe-ab12\n");
  }

  it("lists fixture runs newest-first with kind, status and title", async () => {
    seedReview();
    seedDiscuss();
    seedSquad();
    const sink = makeSink();
    await runRuns(["list"], sink);
    const runs = (sink.finished as { runs: Array<Record<string, unknown>> }).runs;
    expect(runs.map((r) => r.runId)).toEqual([SQUAD_ID, DISCUSS_ID, REVIEW_ID]);
    expect(runs[2]).toMatchObject({
      kind: "review",
      status: "completed",
      title: "https://github.com/acme/repo/pull/9",
      hasReport: true,
      reportUrl: `http://127.0.0.1:43127/reports/${REVIEW_ID}`,
    });
    expect(runs[1]).toMatchObject({
      kind: "discuss",
      status: "running",
      title: "Should we ship?",
    });
    expect(runs[0]).toMatchObject({
      kind: "squad",
      title: "20260824-observe-ab12",
    });
  });

  it("skips a symlinked run directory", async () => {
    seedReview();
    const real = join(home, "outside");
    mkdirSync(real);
    writeFileSync(join(real, "report.md"), "secret\n");
    symlinkSync(real, join(home, "runs", DISCUSS_ID));
    const sink = makeSink();
    await runRuns(["list"], sink);
    const runs = (sink.finished as { runs: Array<{ runId: string }> }).runs;
    expect(runs.map((r) => r.runId)).toEqual([REVIEW_ID]);
  });

  it("open prints the in-app URL for a known run", async () => {
    seedReview();
    const sink = makeSink();
    await runRuns(["open", REVIEW_ID], sink);
    const out = sink.finished as { url: string; title: string };
    expect(out.url).toBe(`http://127.0.0.1:43127/reports/${REVIEW_ID}`);
    expect(out.title).toContain("pull/9");
  });

  it("open rejects path traversal and unknown ids", async () => {
    try {
      await runRuns(["open", "../etc/passwd"], makeSink());
      throw new Error("expected usage");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
    }
    try {
      await runRuns(["open", REVIEW_ID], makeSink());
      throw new Error("expected usage");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("no run found");
    }
  });
});
