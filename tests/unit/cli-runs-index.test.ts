import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCliRunId,
  listCliRuns,
  parseTranscriptMeta,
  readCliRun,
} from "@shared/runtime/cli-runs-index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SQUAD_ID = "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const REVIEW_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";

describe("isCliRunId", () => {
  it("accepts review, discuss, and squad ids", () => {
    expect(isCliRunId("ck-run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee0")).toBe(true);
    expect(isCliRunId(REVIEW_ID)).toBe(true);
    expect(isCliRunId(SQUAD_ID)).toBe(true);
  });

  it("rejects unknown prefixes and truncated uuids", () => {
    expect(isCliRunId("ck-fix-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1")).toBe(false);
    expect(isCliRunId("ck-squad-not-a-uuid")).toBe(false);
  });
});

describe("parseTranscriptMeta", () => {
  it("reads squad.started / squad.finished", () => {
    const text = `${JSON.stringify({
      kind: "squad.started",
      version: 1,
      runId: SQUAD_ID,
      startedAt: "2026-08-24T00:00:00.000Z",
      task: { taskId: "20260824-observe-ab12" },
    })}\n${JSON.stringify({
      kind: "squad.finished",
      version: 1,
      status: "completed",
      endedAt: "2026-08-24T00:10:00.000Z",
    })}\n`;
    expect(parseTranscriptMeta(text, SQUAD_ID)).toEqual({
      kind: "squad",
      status: "completed",
      title: "20260824-observe-ab12",
      startedAt: "2026-08-24T00:00:00.000Z",
      endedAt: "2026-08-24T00:10:00.000Z",
    });
  });

  it("falls back to kind=squad from the run id prefix", () => {
    expect(parseTranscriptMeta("", SQUAD_ID).kind).toBe("squad");
  });
});

describe("listCliRuns squad", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-squad-index-"));
    oldHome = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("lists a squad observe run from status.json without review transcript", () => {
    const dir = join(home, "runs", SQUAD_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "squad.started",
        version: 1,
        runId: SQUAD_ID,
        startedAt: "2026-08-24T01:00:00.000Z",
        task: { taskId: "20260824-observe-ab12" },
      })}\n`,
    );
    writeFileSync(join(dir, "report.md"), "# Squad · 20260824-observe-ab12\n");
    writeFileSync(
      join(dir, "status.json"),
      `${JSON.stringify({
        version: 1,
        status: "running",
        progress: {
          phase: "implementing",
          updatedAt: "2026-08-24T01:02:00.000Z",
          attempts: [
            {
              attemptId: "coder-1",
              agentName: "coder",
              driverId: "grokb",
              modelId: "grok-4.6",
              role: "attempt",
              status: "running",
              durationMs: null,
              lastActivity: "Read src/app.ts",
            },
          ],
        },
        pipeline: null,
      })}\n`,
    );

    const runs = listCliRuns(process.env);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: SQUAD_ID,
      kind: "squad",
      status: "running",
      title: "20260824-observe-ab12",
      hasReport: true,
    });
    expect(runs[0]?.progress?.phase).toBe("implementing");
    expect(runs[0]?.progress?.attempts[0]?.attemptId).toBe("coder-1");
    expect(runs[0]?.handoff).toBeNull();
  });

  it("maps a k4p2-shaped interrupted sidecar to awaiting_orchestrator", () => {
    const dir = join(home, "runs", SQUAD_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "squad.started",
        version: 1,
        runId: SQUAD_ID,
        startedAt: "2026-08-24T01:00:00.000Z",
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
          updatedAt: "2026-08-24T15:35:00.000Z",
          attempts: [
            {
              attemptId: "coder-0",
              agentName: "coder",
              driverId: "grokb",
              modelId: "grok-4.6",
              role: "attempt",
              status: "success",
              durationMs: 864850,
              lastActivity: "}",
            },
            {
              attemptId: "verify-0",
              agentName: "verifier",
              driverId: "codex",
              modelId: "gpt-5.6-terra",
              role: "attempt",
              status: "success",
              durationMs: 1,
              lastActivity: null,
            },
          ],
        },
        pipeline: null,
      })}\n`,
    );

    const runs = listCliRuns(process.env);
    expect(runs[0]?.status).toBe("awaiting_orchestrator");
    expect(runs[0]?.kind).toBe("squad");
    expect(runs[0]?.progress?.phase).toBe("snapshotting");
  });

  it("reads squad brief/plan/reviews documents from the sidecar", () => {
    const dir = join(home, "runs", SQUAD_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "squad.started",
        version: 1,
        runId: SQUAD_ID,
        startedAt: "2026-08-25T01:00:00.000Z",
        task: { taskId: "20260825-observe-docs" },
      })}\n`,
    );
    writeFileSync(join(dir, "report.md"), "# Squad · docs\n");
    writeFileSync(join(dir, "brief.md"), "# Brief\n\nFix the majors.\n");
    writeFileSync(join(dir, "plan.md"), "# Plan\n\nDo C1.\n");
    writeFileSync(join(dir, "reviews.md"), "# 评审\n\n- verdict: `changes-requested`\n");
    writeFileSync(
      join(dir, "status.json"),
      `${JSON.stringify({
        version: 1,
        status: "awaiting_orchestrator",
        progress: { phase: "reviewing", attempts: [], updatedAt: "t" },
        pipeline: null,
      })}\n`,
    );

    const detail = readCliRun(SQUAD_ID, process.env);
    expect(detail?.documents.map((doc) => doc.id)).toEqual(["brief", "plan", "reviews"]);
    expect(detail?.documents[0]?.title).toBe("简报");
    expect(detail?.documents[0]?.markdown).toContain("Fix the majors.");
  });
});
