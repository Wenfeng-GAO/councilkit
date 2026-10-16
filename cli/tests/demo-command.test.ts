/**
 * `councilkit demo` and `runs list` sample marking. No model calls.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findingsFileSchema } from "@shared/runtime/cli-ledger";
import { type CliRunSummary, isCliRunId } from "@shared/runtime/cli-runs-index";
import {
  DEMO_SAMPLE_TITLE,
  countRealRunsNeedingAttention,
  demoSampleHeader,
} from "@shared/runtime/demo-report";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDemo } from "../src/commands/demo";
import { runRuns } from "../src/commands/runs";

const REAL_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";

interface FakeSink {
  json: boolean;
  finished: unknown;
  human: string;
  progress(message: string): void;
  diag(message: string): void;
  finish(data: unknown, humanRender?: (data: unknown) => string): Promise<void>;
}

function makeSink(): FakeSink {
  const sink: FakeSink = {
    json: false,
    finished: undefined,
    human: "",
    progress: () => {},
    diag: () => {},
    finish: (data, humanRender) => {
      sink.finished = data;
      sink.human = humanRender ? humanRender(data) : "";
      return Promise.resolve();
    },
  };
  return sink;
}

function seedRealReview(home: string): void {
  const dir = join(home, "runs", REAL_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "transcript.jsonl"),
    `${JSON.stringify({
      kind: "review.started",
      version: 1,
      runId: REAL_ID,
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

describe("councilkit demo", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-demo-cmd-"));
    oldHome = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("DM-01 demo creates a completed review with demo true", async () => {
    const sink = makeSink();
    await runDemo([], sink);
    const out = sink.finished as { runId: string; demo: boolean; reportUrl: string; title: string };
    expect(out.demo).toBe(true);
    expect(out.title).toBe(DEMO_SAMPLE_TITLE);
    expect(isCliRunId(out.runId)).toBe(true);
    expect(out.runId.startsWith("ck-review-demo-")).toBe(true);
    expect(out.reportUrl).toBe(`http://127.0.0.1:43127/reports/${out.runId}`);
    expect(sink.human).toBe(`示例报告已生成 ${out.reportUrl}`);

    const status = JSON.parse(readFileSync(join(home, "runs", out.runId, "status.json"), "utf8"));
    expect(status).toMatchObject({
      status: "completed",
      kind: "review",
      demo: true,
      readonly: true,
      title: DEMO_SAMPLE_TITLE,
    });
    const findings = findingsFileSchema.parse(
      JSON.parse(readFileSync(join(home, "runs", out.runId, "findings.json"), "utf8")),
    );
    expect(findings.findings.map((row) => row.id)).toEqual([
      "demo-limiter-memory",
      "demo-limit-status",
      "demo-health-probe",
    ]);
  });

  it("DM-04 report.md starts with the SAMPLE DATA lines", async () => {
    const sink = makeSink();
    await runDemo([], sink);
    const { runId } = sink.finished as { runId: string };
    const header = [
      "> ⚠️ 示例数据 / SAMPLE DATA — 由内置示例 AI 生成，非真实模型输出。",
      `> 只读审查 · run ${runId} · demo: true`,
    ].join("\n");
    expect(demoSampleHeader(runId)).toBe(header);
    const markdown = readFileSync(join(home, "runs", runId, "report.md"), "utf8");
    expect(markdown.startsWith(`${header}\n`)).toBe(true);
    expect(markdown).toContain(DEMO_SAMPLE_TITLE);
    expect(markdown).toContain("## Background（背景）");
    expect(markdown).toContain("## Next actions（下一步行动）");
    expect(markdown).toContain("demo-limiter-memory");
  });

  it("DM-05 runs list marks demo and leaves a real run unmarked", async () => {
    seedRealReview(home);
    const created = makeSink();
    await runDemo([], created);
    const { runId } = created.finished as { runId: string };

    const listed = makeSink();
    await runRuns(["list"], listed);
    const runs = (listed.finished as { runs: Array<Record<string, unknown>> }).runs;
    const demo = runs.find((row) => row.runId === runId);
    const real = runs.find((row) => row.runId === REAL_ID);
    expect(demo).toMatchObject({ demo: true, kind: "review", status: "completed" });
    expect(real).toMatchObject({ demo: false, kind: "review" });
    const col = (id: string) =>
      String(listed.human)
        .split("\n")
        .find((line) => line.startsWith(id))
        ?.split(/\s{2,}/)[4];
    expect(col(runId)).toBe("[示例 DEMO]");
    expect(col(REAL_ID)).toBe("真实");
  });

  it("DM-01 re-running demo reuses the sample instead of piling up copies; --new forces one", async () => {
    const first = makeSink();
    await runDemo([], first);
    const again = makeSink();
    await runDemo([], again);
    const a = first.finished as { runId: string };
    const b = again.finished as { runId: string; reused?: boolean };
    expect(b.runId).toBe(a.runId);
    expect(b.reused).toBe(true);
    const forced = makeSink();
    await runDemo(["--new"], forced);
    expect((forced.finished as { runId: string }).runId).not.toBe(a.runId);
  });

  it("DM-07 countRealRunsNeedingAttention excludes demo", async () => {
    seedRealReview(home);
    const created = makeSink();
    await runDemo([], created);
    const listed = makeSink();
    await runRuns(["list"], listed);
    const runs = (listed.finished as { runs: CliRunSummary[] }).runs;
    expect(runs.some((row) => row.demo === true)).toBe(true);
    expect(countRealRunsNeedingAttention(runs)).toBe(0);
    expect(
      countRealRunsNeedingAttention([
        ...runs,
        { demo: true, status: "failed", reviewEvidence: { blockingIds: ["demo-limiter-memory"] } },
        { demo: false, status: "failed" },
      ]),
    ).toBe(1);
  });
});
