import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiagnosedAssessment,
  buildAssessmentDiagnostics,
} from "@shared/runtime/reviewer-assessment";
import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_CORRECTIONS_FILE,
  appendCorrectionRecord,
  assertCorrectionAllowed,
  completeCorrectionRecord,
  invalidFindingIds,
  loadAssessmentCorrections,
  projectCorrectionOutput,
  replayAcceptedCorrections,
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
  it("strips verifiedAt extras and accepts location ranges without echoing extra values", () => {
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
    const { diagnostics, valid } = buildAssessmentDiagnostics({
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
    expect(diagnostics.items.filter((item) => item.status === "valid")).toHaveLength(21);
    expect(diagnostics.items.some((item) => item.errorClass === "unknown_key")).toBe(false);
    expect(valid.some((row) => row.assessment.findingId === "F-RANGE")).toBe(true);
    expect(
      valid.find((row) => row.assessment.findingId === "F-RANGE")?.assessment.locations,
    ).toEqual(["src/a.ts:1-12"]);
    expect(JSON.stringify(diagnostics)).not.toContain("2026-09-07T00:00:00.000Z");
    expect(diagnostics.coverageComplete).toBe(true);
    expect(diagnostics.items.some((item) => item.status === "missing")).toBe(false);
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

  it("does not request correction for unknown keys; still rejects substantial rejudgment", () => {
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
    expect(invalidFindingIds(items, "attempt-0")).toEqual([]);
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

  it("refuses to invent a close or replace evidence fields", () => {
    const missingOutcome = fence([
      {
        findingId: "F-1",
        candidateSha: SHA,
        method: "code_trace",
        reason: "still reproduces",
        evidence: "same call path",
        locations: ["src/a.ts:1"],
      },
    ]);
    const invented = projectCorrectionOutput({
      originalOutput: missingOutcome,
      correctionOutput: fence([
        {
          findingId: "F-1",
          candidateSha: SHA,
          outcome: "verified_closed",
          method: "regression_test",
          reason: "now closed",
          evidence: "new test",
          command: "pnpm test",
        },
      ]),
      candidateSha: SHA,
      requestedFindingIds: ["F-1"],
      sourceAttemptId: "attempt-0",
    });
    expect(invented.substantialChange).toBe(true);
    expect(invented.valid).toHaveLength(0);

    const illegal = fence([{ ...validRow("F-1"), verifiedAt: "x" }]);
    const swapped = projectCorrectionOutput({
      originalOutput: illegal,
      correctionOutput: fence([
        {
          ...validRow("F-1"),
          command: "pnpm test extra",
          evidence: "brand new proof",
        },
      ]),
      candidateSha: SHA,
      requestedFindingIds: ["F-1"],
      sourceAttemptId: "attempt-0",
    });
    expect(swapped.substantialChange).toBe(true);
    expect(swapped.valid).toHaveLength(0);
  });

  it("refuses to rebind a close that was proven against a different candidate SHA", () => {
    const other = "b".repeat(40);
    const original = fence([
      {
        findingId: "F-1",
        candidateSha: other,
        outcome: "verified_closed",
        method: "code_trace",
        reason: "closed on B",
        evidence: "trace on B",
        locations: ["src/a.ts:1"],
        verifiedAt: "x",
      },
    ]);
    const rebound = projectCorrectionOutput({
      originalOutput: original,
      correctionOutput: fence([
        {
          findingId: "F-1",
          candidateSha: SHA,
          outcome: "verified_closed",
          method: "code_trace",
          reason: "closed on B",
          evidence: "trace on B",
          locations: ["src/a.ts:1"],
        },
      ]),
      candidateSha: SHA,
      requestedFindingIds: ["F-1"],
      sourceAttemptId: "attempt-0",
    });
    expect(rebound.substantialChange).toBe(true);
    expect(rebound.valid).toHaveLength(0);
    expect(rebound.rejected.some((item) => item.errorClass === "candidate_sha_replaced")).toBe(
      true,
    );
  });

  it("marks coverage incomplete only when valid seats contradict the same id", () => {
    const closed = {
      ...validRow("F-1"),
      outcome: "verified_closed",
      method: "code_trace",
    };
    const extrasPeer = buildAssessmentDiagnostics({
      runId: "run",
      sha: SHA,
      requiredFindingIds: ["F-1"],
      attempts: [
        {
          attemptId: "attempt-0",
          status: "success",
          exitCode: 0,
          agentName: "A",
          output: fence([closed]),
        },
        {
          attemptId: "attempt-1",
          status: "success",
          exitCode: 0,
          agentName: "B",
          output: fence([{ ...closed, verifiedAt: "x" }]),
        },
      ],
    });
    expect(extrasPeer.diagnostics.coverageComplete).toBe(true);

    const conflict = buildAssessmentDiagnostics({
      runId: "run",
      sha: SHA,
      requiredFindingIds: ["F-1"],
      attempts: [
        {
          attemptId: "attempt-0",
          status: "success",
          exitCode: 0,
          agentName: "A",
          output: fence([closed]),
        },
        {
          attemptId: "attempt-1",
          status: "success",
          exitCode: 0,
          agentName: "B",
          output: fence([validRow("F-1")]),
        },
      ],
    });
    expect(conflict.diagnostics.coverageComplete).toBe(false);
  });

  it("does not treat not_evaluated as a factual contradiction of verified_closed", () => {
    const diag = buildAssessmentDiagnostics({
      runId: "r1",
      sha: SHA,
      requiredFindingIds: ["F-1"],
      attempts: [],
      extraAssessments: [
        {
          attemptId: "r1",
          reviewer: "reviewer",
          assessment: {
            findingId: "F-1",
            candidateSha: SHA,
            outcome: "verified_closed",
            method: "regression_test",
            reason: "original counterexample passed",
            evidence: "probe passed",
            command: "go test ./pkg",
          },
        },
        {
          attemptId: "r2",
          reviewer: "abstainer",
          assessment: {
            findingId: "F-1",
            candidateSha: SHA,
            outcome: "not_evaluated",
            method: "not_evaluated",
            reason: "not assigned",
            evidence: "no evaluation",
          },
        },
      ],
    });
    expect(diag.diagnostics.coverageComplete).toBe(true);
    expect(
      diag.diagnostics.items
        .filter((item) => item.errorClass !== "ok")
        .map((item) => item.errorClass),
    ).toEqual([]);
  });

  it("lets one seat's valid row cover a finding omitted or unreadable on a peer seat", () => {
    const closed = {
      ...validRow("F-1"),
      outcome: "verified_closed",
      method: "code_trace",
    };
    const missingPeer = buildAssessmentDiagnostics({
      runId: "run",
      sha: SHA,
      requiredFindingIds: ["F-1"],
      attempts: [
        {
          attemptId: "attempt-0",
          status: "success",
          exitCode: 0,
          agentName: "A",
          output: fence([closed]),
        },
        {
          attemptId: "attempt-1",
          status: "success",
          exitCode: 0,
          agentName: "B",
          output: fence([]),
        },
      ],
    });
    expect(missingPeer.diagnostics.coverageComplete).toBe(true);

    const badJsonPeer = buildAssessmentDiagnostics({
      runId: "run",
      sha: SHA,
      requiredFindingIds: ["F-1"],
      attempts: [
        {
          attemptId: "attempt-0",
          status: "success",
          exitCode: 0,
          agentName: "A",
          output: fence([closed]),
        },
        {
          attemptId: "attempt-1",
          status: "success",
          exitCode: 0,
          agentName: "B",
          output: "```councilkit-findings\n{not-json\n```",
        },
      ],
    });
    expect(badJsonPeer.diagnostics.coverageComplete).toBe(true);
    expect(badJsonPeer.diagnostics.items.some((item) => item.errorClass === "json")).toBe(true);
  });

  it("treats accepted extraAssessments as the coverage projection", () => {
    const original = fence([{ ...validRow("F-1"), locations: ["src/a.ts"] }]);
    const extra: DiagnosedAssessment = {
      assessment: {
        findingId: "F-1",
        candidateSha: SHA,
        outcome: "still_open",
        method: "code_trace",
        reason: "still reproduces",
        evidence: "same call path",
        locations: ["src/a.ts:1"],
      },
      attemptId: "attempt-0",
      reviewer: "R",
    };
    const diagnosed = buildAssessmentDiagnostics({
      runId: "run",
      sha: SHA,
      requiredFindingIds: ["F-1"],
      extraAssessments: [extra],
      attempts: [
        {
          attemptId: "attempt-0",
          status: "success",
          exitCode: 0,
          agentName: "R",
          output: original,
        },
      ],
    });
    expect(diagnosed.diagnostics.coverageComplete).toBe(true);
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

  it("does not replay a correction whose source run, identity, hashes, or clean proofs do not bind", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-corr-replay-"));
    const identity = { agentId: "a", driverId: "grok-stream-json", modelId: "g" };
    const original = fence([{ ...validRow("F-1"), verifiedAt: "x" }]);
    const fixed = fence([validRow("F-1")]);
    try {
      mkdirSync(join(dir, "corrections"), { recursive: true });
      writeFileSync(join(dir, "corrections", "attempt-0.md"), fixed);
      writeAssessmentCorrections(
        dir,
        appendCorrectionRecord(null, {
          correctionId: "c-bad",
          sourceRunId: "ck-review-other",
          sourceAttemptId: "attempt-0",
          identity: { agentId: "other", driverId: "kimi-stream-json", modelId: "k" },
          sourceOutputSha256: "e".repeat(64),
          candidateSha: "b".repeat(40),
          requestedFindingIds: ["F-1"],
          errorPaths: ["/blocks/0/0"],
          executionId: "exec-1",
          startedAt: "t0",
          endedAt: "t1",
          correctionOutputSha256: "f".repeat(64),
          accepted: true,
          reason: "format",
          toolFingerprint: {
            name: "kimi-stream-json",
            realpath: "/bin/kimi",
            sha256: "d".repeat(64),
          },
          trackedCleanBefore: false,
          trackedCleanAfter: false,
        }),
      );
      const extras = replayAcceptedCorrections({
        runDir: dir,
        runId: "ck-review-current",
        candidateSha: SHA,
        attempts: [
          {
            attemptId: "attempt-0",
            output: original,
            agentId: identity.agentId,
            driverId: identity.driverId,
            modelId: identity.modelId,
          },
        ],
      });
      expect(extras).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays a bound accepted correction whose hashes and identity match", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-corr-replay-ok-"));
    const identity = { agentId: "a", driverId: "grok-stream-json", modelId: "g" };
    const original = fence([{ ...validRow("F-1"), verifiedAt: "x" }]);
    const fixed = fence([validRow("F-1")]);
    try {
      mkdirSync(join(dir, "corrections"), { recursive: true });
      writeFileSync(join(dir, "corrections", "attempt-0.md"), fixed);
      writeAssessmentCorrections(
        dir,
        appendCorrectionRecord(null, {
          correctionId: "c-ok",
          sourceRunId: "ck-review-current",
          sourceAttemptId: "attempt-0",
          identity,
          sourceOutputSha256: sha256Text(original),
          candidateSha: SHA,
          requestedFindingIds: ["F-1"],
          errorPaths: ["/blocks/0/0"],
          executionId: "exec-1",
          startedAt: "t0",
          endedAt: "t1",
          correctionOutputSha256: sha256Text(fixed),
          accepted: true,
          reason: "format",
          toolFingerprint: {
            name: "grok-stream-json",
            realpath: "/bin/grok",
            sha256: "d".repeat(64),
          },
          trackedCleanBefore: true,
          trackedCleanAfter: true,
        }),
      );
      const extras = replayAcceptedCorrections({
        runDir: dir,
        runId: "ck-review-current",
        candidateSha: SHA,
        attempts: [
          {
            attemptId: "attempt-0",
            output: original,
            agentId: identity.agentId,
            driverId: identity.driverId,
            modelId: identity.modelId,
          },
        ],
      });
      expect(extras).toHaveLength(1);
      expect(extras[0]?.assessment.findingId).toBe("F-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
