import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAssessmentDiagnostics } from "@shared/runtime/reviewer-assessment";
import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_CORRECTIONS_FILE,
  appendCorrectionRecord,
  assertCorrectionAllowed,
  completeCorrectionRecord,
  invalidFindingIds,
  loadAssessmentCorrections,
  projectCorrectionOutput,
  sha256Text,
  writeAssessmentCorrections,
} from "../src/auto/assessment-correction";

const SHA = "a".repeat(40);

function fence(rows: unknown[]): string {
  return `\`\`\`councilkit-findings\n${JSON.stringify(rows)}\n\`\`\``;
}

function validRow(id: string, extras: Record<string, unknown> = {}) {
  return {
    findingId: id,
    candidateSha: SHA,
    outcome: "still_open",
    method: "code_trace",
    reason: "still reproduces",
    evidence: "same call path",
    locations: ["src/a.ts:1"],
    ...extras,
  };
}

describe("assessment diagnostics", () => {
  it("rejects twenty verifiedAt extras and a locations range without echoing values", () => {
    const rows: Array<ReturnType<typeof validRow> & { verifiedAt?: string }> = Array.from(
      { length: 20 },
      (_, index) => ({
        ...validRow(`F-${index}`),
        verifiedAt: "2026-09-07T00:00:00.000Z",
      }),
    );
    rows.push({
      ...validRow("F-RANGE"),
      locations: ["src/a.ts:1-12"],
    });
    const { diagnostics } = buildAssessmentDiagnostics({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      sha: SHA,
      requiredFindingIds: ["F-0", "F-RANGE"],
      attempts: [
        {
          attemptId: "attempt-0",
          status: "success",
          exitCode: 0,
          agentName: "R",
          output: fence(rows),
        },
      ],
    });
    expect(diagnostics.items.filter((item) => item.status === "valid")).toHaveLength(0);
    expect(
      diagnostics.items.filter((item) => item.errorClass === "unknown_key").length,
    ).toBeGreaterThan(0);
    expect(
      diagnostics.items.some((item) => item.findingId === "F-RANGE" && item.status === "invalid"),
    ).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("2026-09-07T00:00:00.000Z");
    expect(diagnostics.coverageComplete).toBe(false);
    expect(
      diagnostics.items.some((item) => item.status === "missing" && item.findingId === "F-0"),
    ).toBe(true);
  });

  it("keeps mixed valid rows and refuses bad JSON", () => {
    const mixed = buildAssessmentDiagnostics({
      runId: "run",
      sha: SHA,
      requiredFindingIds: ["F-OK"],
      attempts: [
        {
          attemptId: "attempt-0",
          status: "success",
          exitCode: 0,
          agentName: "R",
          output: `${fence([validRow("F-OK")])}\n\`\`\`councilkit-findings\n{not-json\n\`\`\``,
        },
      ],
    });
    expect(mixed.valid.map((row) => row.assessment.findingId)).toEqual(["F-OK"]);
    expect(mixed.diagnostics.items.some((item) => item.errorClass === "json")).toBe(true);
    expect(mixed.diagnostics.coverageComplete).toBe(true);
  });
});

describe("assessment correction", () => {
  it("allows one correction per seat and rejects a second or dirty tree", () => {
    const identity = { agentId: "a", driverId: "grok-stream-json", modelId: "g" };
    assertCorrectionAllowed({
      records: null,
      attemptId: "attempt-0",
      attemptStatus: "success",
      identity,
      frozenIdentity: identity,
      candidateSha: SHA,
      workspaceHead: SHA,
      trackedClean: true,
    });
    const once = appendCorrectionRecord(null, {
      correctionId: "c1",
      sourceRunId: "run",
      sourceAttemptId: "attempt-0",
      identity,
      sourceOutputSha256: "b".repeat(64),
      candidateSha: SHA,
      requestedFindingIds: ["F-1"],
      errorPaths: ["/blocks/0/0"],
      executionId: "exec-1",
      startedAt: "t0",
      endedAt: "t1",
      correctionOutputSha256: "c".repeat(64),
      accepted: true,
      reason: "format",
      toolFingerprint: {
        name: "grok-stream-json",
        realpath: "/bin/grok",
        sha256: "d".repeat(64),
      },
      trackedCleanBefore: true,
      trackedCleanAfter: true,
    });
    expect(() =>
      assertCorrectionAllowed({
        records: once,
        attemptId: "attempt-0",
        attemptStatus: "success",
        identity,
        frozenIdentity: identity,
        candidateSha: SHA,
        workspaceHead: SHA,
        trackedClean: true,
      }),
    ).toThrow(/limit is 1/);
    expect(() =>
      assertCorrectionAllowed({
        records: null,
        attemptId: "attempt-0",
        attemptStatus: "success",
        identity,
        frozenIdentity: identity,
        candidateSha: SHA,
        workspaceHead: SHA,
        trackedClean: false,
      }),
    ).toThrow(/clean worktree/);
  });

  it("projects only requested IDs, is replay-idempotent, and rejects substantial rejudgment", () => {
    const original = fence([{ ...validRow("F-1"), verifiedAt: "x" }]);
    const items = buildAssessmentDiagnostics({
      runId: "run",
      sha: SHA,
      requiredFindingIds: ["F-1"],
      attempts: [
        {
          attemptId: "attempt-0",
          status: "success",
          exitCode: 0,
          agentName: "R",
          output: original,
        },
      ],
    }).diagnostics.items;
    expect(invalidFindingIds(items, "attempt-0")).toEqual(["F-1"]);
    const fixed = fence([validRow("F-1")]);
    const first = projectCorrectionOutput({
      originalOutput: original,
      correctionOutput: fixed,
      candidateSha: SHA,
      requestedFindingIds: ["F-1"],
      sourceAttemptId: "attempt-0",
    });
    const second = projectCorrectionOutput({
      originalOutput: original,
      correctionOutput: fixed,
      candidateSha: SHA,
      requestedFindingIds: ["F-1"],
      sourceAttemptId: "attempt-0",
    });
    expect(first.valid[0]?.attemptId).toBe("attempt-0");
    expect(second.valid).toEqual(first.valid);
    expect(sha256Text(original)).not.toBe(sha256Text(fixed));
    const changed = projectCorrectionOutput({
      originalOutput: original,
      correctionOutput: fence([{ ...validRow("F-1"), outcome: "verified_closed" }]),
      candidateSha: SHA,
      requestedFindingIds: ["F-1"],
      sourceAttemptId: "attempt-0",
    });
    expect(changed.substantialChange).toBe(true);
    expect(changed.valid).toHaveLength(0);
  });

  it("persists intent before completion and upserts the same correctionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-corr-"));
    const identity = { agentId: "a", driverId: "grok-stream-json", modelId: "g" };
    try {
      const intent = appendCorrectionRecord(null, {
        correctionId: "c-intent",
        sourceRunId: "run",
        sourceAttemptId: "attempt-0",
        identity,
        sourceOutputSha256: "b".repeat(64),
        candidateSha: SHA,
        requestedFindingIds: ["F-1"],
        errorPaths: ["/blocks/0/0"],
        executionId: "exec-1",
        startedAt: "t0",
        endedAt: null,
        correctionOutputSha256: null,
        accepted: false,
        reason: "format",
        toolFingerprint: {
          name: "grok-stream-json",
          realpath: "/bin/grok",
          sha256: "d".repeat(64),
        },
        trackedCleanBefore: true,
        trackedCleanAfter: null,
      });
      writeAssessmentCorrections(dir, intent);
      expect(readFileSync(join(dir, ASSESSMENT_CORRECTIONS_FILE), "utf8")).toContain("c-intent");
      const completed = completeCorrectionRecord(loadAssessmentCorrections(dir), {
        correctionId: "c-intent",
        endedAt: "t1",
        correctionOutputSha256: "c".repeat(64),
        accepted: true,
        trackedCleanAfter: true,
        reason: "format",
      });
      writeAssessmentCorrections(dir, completed);
      const loaded = loadAssessmentCorrections(dir);
      expect(loaded?.records).toHaveLength(1);
      expect(loaded?.records[0]?.endedAt).toBe("t1");
      expect(loaded?.records[0]?.trackedCleanAfter).toBe(true);
      expect(loaded?.records[0]?.toolFingerprint.sha256).toBe("d".repeat(64));
      const replay = appendCorrectionRecord(loaded, loaded?.records[0] as never);
      expect(replay.records).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
