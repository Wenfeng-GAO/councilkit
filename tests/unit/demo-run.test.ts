/**
 * Sample-run index, export prefix, and the "需要处理" exclusion.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseStatusAxis } from "@/lib/report-groups";
import { isCliRunId, listCliRuns } from "@shared/runtime/cli-runs-index";
import {
  DEMO_SAMPLE_TITLE,
  countRealRunsNeedingAttention,
  demoSampleHeader,
  exportRunMarkdown,
  isDemoRun,
  realRunNeedsAttention,
} from "@shared/runtime/demo-report";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

const DEMO_ID = "ck-review-demo-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9";
const SENTINEL_ID = "ck-review-demo-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const REAL_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";

function summary(
  partial: Partial<CliRunSummaryDto> & Pick<CliRunSummaryDto, "runId" | "title">,
): CliRunSummaryDto {
  return {
    kind: "review",
    status: "completed",
    startedAt: "2026-10-15T00:00:00.000Z",
    endedAt: null,
    hasReport: true,
    hasPlan: false,
    hasFindings: true,
    hasPlanLock: false,
    reportUrl: `http://127.0.0.1:43127/reports/${partial.runId}`,
    progress: null,
    pipeline: null,
    handoff: null,
    ...partial,
  };
}

describe("DM-01 isDemoRun", () => {
  it("is true only when demo is exactly true", () => {
    expect(isDemoRun({ demo: true })).toBe(true);
    expect(isDemoRun({ demo: false })).toBe(false);
    expect(isDemoRun({})).toBe(false);
    expect(isDemoRun(undefined)).toBe(false);
    expect(isDemoRun(null)).toBe(false);
  });

  it("accepts ck-review-demo ids and reads status.json or demo.json", () => {
    expect(isCliRunId(DEMO_ID)).toBe(true);
    expect(isCliRunId("ck-demo-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9")).toBe(false);

    const home = mkdtempSync(join(tmpdir(), "ck-demo-index-"));
    const previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
    try {
      const demoDir = join(home, "runs", DEMO_ID);
      mkdirSync(demoDir, { recursive: true });
      writeFileSync(
        join(demoDir, "status.json"),
        `${JSON.stringify({
          version: 1,
          status: "completed",
          demo: true,
          title: DEMO_SAMPLE_TITLE,
          startedAt: "2026-10-15T00:00:00.000Z",
          endedAt: "2026-10-15T00:01:00.000Z",
          progress: { phase: "done", attempts: [], updatedAt: "2026-10-15T00:01:00.000Z" },
        })}\n`,
      );
      writeFileSync(join(demoDir, "report.md"), "# sample\n");

      const sentinelDir = join(home, "runs", SENTINEL_ID);
      mkdirSync(sentinelDir, { recursive: true });
      writeFileSync(
        join(sentinelDir, "status.json"),
        `${JSON.stringify({
          version: 1,
          status: "completed",
          title: "sentinel",
          startedAt: "2026-10-14T00:00:00.000Z",
          endedAt: "2026-10-14T00:01:00.000Z",
          progress: { phase: "done", attempts: [], updatedAt: "2026-10-14T00:01:00.000Z" },
        })}\n`,
      );
      writeFileSync(join(sentinelDir, "demo.json"), '{"demo":true}\n');

      const realDir = join(home, "runs", REAL_ID);
      mkdirSync(realDir, { recursive: true });
      writeFileSync(
        join(realDir, "transcript.jsonl"),
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
        })}\n`,
      );

      const runs = listCliRuns(process.env);
      const demo = runs.find((row) => row.runId === DEMO_ID);
      const sentinel = runs.find((row) => row.runId === SENTINEL_ID);
      const real = runs.find((row) => row.runId === REAL_ID);
      expect(demo).toMatchObject({
        demo: true,
        kind: "review",
        status: "completed",
        title: DEMO_SAMPLE_TITLE,
      });
      expect(sentinel).toMatchObject({ demo: true, title: "sentinel", status: "completed" });
      expect(real?.demo).toBe(false);
    } finally {
      if (previous === undefined) process.env.COUNCILKIT_HOME = undefined;
      else process.env.COUNCILKIT_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("DM-04 exportRunMarkdown", () => {
  const header = [
    "> ⚠️ 示例数据 / SAMPLE DATA — 由内置示例 AI 生成，非真实模型输出。",
    `> 只读审查 · run ${DEMO_ID} · demo: true`,
  ].join("\n");

  it("prefixes a demo export once and leaves a real report unchanged", () => {
    expect(demoSampleHeader(DEMO_ID)).toBe(header);
    const body = `# ${DEMO_SAMPLE_TITLE}\n\n正文\n`;
    const once = exportRunMarkdown({ demo: true, runId: DEMO_ID, markdown: body });
    expect(once.startsWith(`${header}\n\n`)).toBe(true);
    expect(once).toContain(body.trim());
    expect(exportRunMarkdown({ demo: true, runId: DEMO_ID, markdown: once })).toBe(once);
    expect(exportRunMarkdown({ demo: false, runId: DEMO_ID, markdown: body })).toBe(body);
    expect(exportRunMarkdown({ runId: REAL_ID, markdown: body })).toBe(body);
  });
});

describe("DM-07 demo runs stay out of real attention counts", () => {
  it("countRealRunsNeedingAttention skips demo even with blocking findings", () => {
    expect(realRunNeedsAttention({ demo: true, status: "failed" })).toBe(false);
    expect(
      realRunNeedsAttention({
        demo: true,
        status: "completed",
        reviewEvidence: { blockingIds: ["demo-limiter-memory"] },
      }),
    ).toBe(false);
    expect(
      countRealRunsNeedingAttention([
        { demo: true, status: "failed" },
        { demo: false, status: "completed", reviewEvidence: { blockingIds: [] } },
        { status: "failed" },
        { status: "completed", reviewEvidence: { blockingIds: ["real-1"] } },
      ]),
    ).toBe(2);
  });

  it("caseStatusAxis drops a demo-only case that would otherwise need attention", () => {
    const row = summary({
      runId: DEMO_ID,
      title: DEMO_SAMPLE_TITLE,
      demo: true,
      reviewEvidence: {
        complete: true,
        sha: "a".repeat(40),
        prUrl: "https://github.com/acme/sample/pull/8",
        againstRunId: null,
        blockingIds: ["demo-limiter-memory"],
        unverifiedFixIds: [],
        openIds: ["demo-limiter-memory"],
      },
    });
    expect(caseStatusAxis([row])).toEqual({ active: false, done: true, attention: false });
    expect(caseStatusAxis([{ ...row, demo: false }])).toMatchObject({
      attention: true,
      done: true,
    });
  });
});
