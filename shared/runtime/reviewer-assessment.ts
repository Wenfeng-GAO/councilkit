/**
 * Shared councilkit-findings assessment schema. Templates, parsers and
 * diagnostics must use this one definition. Extra keys such as verifiedAt fail.
 */
import { z } from "zod";
import { FULL_COMMIT_SHA } from "./cli-ledger";

export const reviewerAssessmentSchema = z
  .object({
    findingId: z.string().min(1).max(160),
    candidateSha: z.string().regex(FULL_COMMIT_SHA),
    outcome: z.enum(["verified_closed", "still_open", "not_evaluated"]),
    method: z.enum(["regression_test", "code_trace", "not_evaluated"]),
    reason: z.string().trim().min(1).max(2000),
    evidence: z.string().trim().min(1).max(4000),
    command: z.string().trim().min(1).max(2000).optional(),
    locations: z
      .array(z.string().regex(/.+:\d+$/))
      .min(1)
      .max(32)
      .optional(),
  })
  .strict();
export type ReviewerAssessment = z.infer<typeof reviewerAssessmentSchema>;

export const ASSESSMENT_DIAGNOSTICS_FILE = "assessment-diagnostics.v1.json";

export const assessmentDiagnosticItemSchema = z
  .object({
    findingId: z.string().max(160).nullable(),
    attemptId: z.string().min(1).max(80),
    status: z.enum(["valid", "invalid", "missing", "semantic_mismatch"]),
    errorClass: z.string().min(1).max(80),
    errorPath: z.string().min(1).max(400),
  })
  .strict();

export const assessmentDiagnosticsFileSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("councilkit-assessment-diagnostics"),
    source: z
      .object({
        runId: z.string().min(1).max(160),
        sha: z.string().regex(FULL_COMMIT_SHA).nullable(),
        requiredFindingIds: z.array(z.string().min(1).max(160)).max(200),
      })
      .strict(),
    coverageComplete: z.boolean(),
    items: z.array(assessmentDiagnosticItemSchema).max(400),
  })
  .strict();
export type AssessmentDiagnosticsFile = z.infer<typeof assessmentDiagnosticsFileSchema>;
export type AssessmentDiagnosticItem = z.infer<typeof assessmentDiagnosticItemSchema>;

export type DiagnosedAssessment = {
  assessment: ReviewerAssessment;
  attemptId: string;
  reviewer: string;
};

function pathOnly(issuePath: ReadonlyArray<PropertyKey>): string {
  return issuePath.length === 0 ? "/" : `/${issuePath.map(String).join("/")}`;
}

export function extractAssessmentBlocks(output: string): string[] {
  return [...output.matchAll(/```councilkit-findings\s*\n([\s\S]*?)\n```/g)].map(
    (match) => match[1] ?? "",
  );
}

export function diagnoseAttemptAssessments(input: {
  attemptId: string;
  output: string;
  candidateSha: string;
}): { items: AssessmentDiagnosticItem[]; valid: DiagnosedAssessment[] } {
  const items: AssessmentDiagnosticItem[] = [];
  const valid: DiagnosedAssessment[] = [];
  const blocks = extractAssessmentBlocks(input.output);
  if (blocks.length === 0) {
    return { items, valid };
  }
  for (const [blockIndex, raw] of blocks.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      items.push({
        findingId: null,
        attemptId: input.attemptId,
        status: "invalid",
        errorClass: "json",
        errorPath: `/blocks/${blockIndex}`,
      });
      continue;
    }
    if (!Array.isArray(parsed)) {
      items.push({
        findingId: null,
        attemptId: input.attemptId,
        status: "invalid",
        errorClass: "schema",
        errorPath: `/blocks/${blockIndex}`,
      });
      continue;
    }
    if (parsed.length > 200) {
      items.push({
        findingId: null,
        attemptId: input.attemptId,
        status: "invalid",
        errorClass: "schema",
        errorPath: `/blocks/${blockIndex}/length`,
      });
      continue;
    }
    for (const [index, row] of parsed.entries()) {
      const result = reviewerAssessmentSchema.safeParse(row);
      if (!result.success) {
        const findingId =
          row !== null &&
          typeof row === "object" &&
          "findingId" in row &&
          typeof row.findingId === "string"
            ? row.findingId.slice(0, 160)
            : null;
        const first = result.error.issues[0];
        items.push({
          findingId,
          attemptId: input.attemptId,
          status: "invalid",
          errorClass: first?.code === "unrecognized_keys" ? "unknown_key" : "schema",
          errorPath: `/blocks/${blockIndex}/${index}${first ? pathOnly(first.path) : ""}`,
        });
        continue;
      }
      if (result.data.candidateSha !== input.candidateSha) {
        items.push({
          findingId: result.data.findingId,
          attemptId: input.attemptId,
          status: "semantic_mismatch",
          errorClass: "candidate_sha",
          errorPath: `/blocks/${blockIndex}/${index}/candidateSha`,
        });
        continue;
      }
      if (result.data.outcome === "verified_closed" && result.data.method === "not_evaluated") {
        items.push({
          findingId: result.data.findingId,
          attemptId: input.attemptId,
          status: "semantic_mismatch",
          errorClass: "close_without_method",
          errorPath: `/blocks/${blockIndex}/${index}/method`,
        });
        continue;
      }
      items.push({
        findingId: result.data.findingId,
        attemptId: input.attemptId,
        status: "valid",
        errorClass: "ok",
        errorPath: `/blocks/${blockIndex}/${index}`,
      });
      valid.push({
        assessment: result.data,
        attemptId: input.attemptId,
        reviewer: "",
      });
    }
  }
  return { items, valid };
}

export function buildAssessmentDiagnostics(input: {
  runId: string;
  sha: string | null;
  requiredFindingIds: readonly string[];
  attempts: readonly {
    attemptId: string;
    status: string;
    exitCode: number | null;
    output: string;
    agentName: string;
  }[];
  extraAssessments?: readonly DiagnosedAssessment[];
}): { diagnostics: AssessmentDiagnosticsFile; valid: DiagnosedAssessment[] } {
  const items: AssessmentDiagnosticItem[] = [];
  const valid: DiagnosedAssessment[] = [];
  const sha = input.sha && FULL_COMMIT_SHA.test(input.sha) ? input.sha : "";
  for (const attempt of input.attempts) {
    if (attempt.attemptId === "aggregator") continue;
    if (attempt.status !== "success" || attempt.exitCode !== 0) continue;
    const diagnosed = diagnoseAttemptAssessments({
      attemptId: attempt.attemptId,
      output: attempt.output,
      candidateSha: sha,
    });
    items.push(...diagnosed.items);
    for (const row of diagnosed.valid) {
      valid.push({ ...row, reviewer: attempt.agentName });
    }
  }
  const extras = input.extraAssessments ?? [];
  for (const extra of extras) {
    valid.push(extra);
    items.push({
      findingId: extra.assessment.findingId,
      attemptId: extra.attemptId,
      status: "valid",
      errorClass: "ok",
      errorPath: `/correction/${extra.assessment.findingId}`,
    });
  }
  const extraKeys = new Set(extras.map((row) => `${row.attemptId}:${row.assessment.findingId}`));
  const covered = new Set(valid.map((row) => row.assessment.findingId));
  const successfulSeats = input.attempts.filter(
    (attempt) =>
      attempt.attemptId !== "aggregator" && attempt.status === "success" && attempt.exitCode === 0,
  );
  for (const id of input.requiredFindingIds) {
    if (!covered.has(id)) {
      items.push({
        findingId: id,
        attemptId: "coverage",
        status: "missing",
        errorClass: "missing_required_id",
        errorPath: `/required/${id}`,
      });
    }
    const outcomes = new Set(
      valid.filter((row) => row.assessment.findingId === id).map((row) => row.assessment.outcome),
    );
    if (outcomes.size > 1) {
      items.push({
        findingId: id,
        attemptId: "coverage",
        status: "semantic_mismatch",
        errorClass: "contradictory_outcome",
        errorPath: `/required/${id}/outcome`,
      });
    }
  }
  const coverageComplete = input.requiredFindingIds.every((id) => {
    const valids = valid.filter((row) => row.assessment.findingId === id);
    if (valids.length === 0) return false;
    const remainingInvalid = items.some(
      (item) =>
        item.findingId === id &&
        (item.status === "invalid" || item.status === "semantic_mismatch") &&
        item.attemptId !== "coverage" &&
        !extraKeys.has(`${item.attemptId}:${id}`),
    );
    if (remainingInvalid) return false;
    for (const seat of successfulSeats) {
      const seatItems = items.filter((item) => item.attemptId === seat.attemptId);
      const seatCovers =
        extraKeys.has(`${seat.attemptId}:${id}`) ||
        seatItems.some((item) => item.findingId === id && item.status === "valid");
      if (!seatCovers) return false;
    }
    const outcomes = new Set(valids.map((row) => row.assessment.outcome));
    return outcomes.size === 1;
  });
  return {
    diagnostics: {
      version: 1,
      kind: "councilkit-assessment-diagnostics",
      source: {
        runId: input.runId,
        sha: sha || null,
        requiredFindingIds: [...input.requiredFindingIds],
      },
      coverageComplete,
      items,
    },
    valid,
  };
}
