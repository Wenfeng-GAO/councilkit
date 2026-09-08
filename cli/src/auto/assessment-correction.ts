/**
 * Bounded format correction for invalid reviewer assessments.
 * Never overwrites original attempt output; never lets the Aggregator fill receipts.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FULL_COMMIT_SHA } from "@shared/runtime/cli-ledger";
import {
  type AssessmentDiagnosticItem,
  type DiagnosedAssessment,
  diagnoseAttemptAssessments,
  extractAssessmentBlocks,
} from "@shared/runtime/reviewer-assessment";
import { z } from "zod";
import { atomicWriteJson } from "../store/atomic-write";

export const ASSESSMENT_CORRECTIONS_FILE = "assessment-corrections.v1.json";

export const assessmentCorrectionRecordSchema = z
  .object({
    correctionId: z.string().min(1).max(160),
    sourceRunId: z.string().min(1).max(160),
    sourceAttemptId: z.string().min(1).max(80),
    identity: z
      .object({
        agentId: z.string().min(1).max(160),
        driverId: z.string().min(1).max(80),
        modelId: z.string().min(1).max(200),
      })
      .strict(),
    sourceOutputSha256: z.string().regex(/^[0-9a-f]{64}$/),
    candidateSha: z.string().regex(FULL_COMMIT_SHA),
    requestedFindingIds: z.array(z.string().min(1).max(160)).max(200),
    errorPaths: z.array(z.string().min(1).max(400)).max(400),
    executionId: z.string().min(1).max(160),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1).nullable(),
    correctionOutputSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    accepted: z.boolean(),
    reason: z.string().min(1).max(400),
    toolFingerprint: z
      .object({
        name: z.string().min(1).max(80),
        realpath: z.string().min(1).max(4096),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    trackedCleanBefore: z.boolean(),
    trackedCleanAfter: z.boolean().nullable(),
  })
  .strict();
export type AssessmentCorrectionRecord = z.infer<typeof assessmentCorrectionRecordSchema>;

export const assessmentCorrectionsFileSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("councilkit-assessment-corrections"),
    records: z.array(assessmentCorrectionRecordSchema).max(64),
  })
  .strict();
export type AssessmentCorrectionsFile = z.infer<typeof assessmentCorrectionsFileSchema>;

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function invalidFindingIds(
  items: readonly AssessmentDiagnosticItem[],
  attemptId: string,
): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.attemptId !== attemptId) continue;
    if (item.status === "valid" || item.findingId === null) continue;
    ids.add(item.findingId);
  }
  return [...ids];
}

export function correctionCountForAttempt(
  file: AssessmentCorrectionsFile | null | undefined,
  attemptId: string,
): number {
  return file?.records.filter((row) => row.sourceAttemptId === attemptId).length ?? 0;
}

export function assertCorrectionAllowed(input: {
  records: AssessmentCorrectionsFile | null | undefined;
  attemptId: string;
  attemptStatus: string;
  identity: { agentId: string; driverId: string; modelId: string };
  frozenIdentity: { agentId: string; driverId: string; modelId: string };
  candidateSha: string;
  workspaceHead: string;
  trackedClean: boolean;
}): void {
  if (input.attemptStatus !== "success") {
    throw new Error("correction requires the original successful attempt");
  }
  if (correctionCountForAttempt(input.records, input.attemptId) >= 1) {
    throw new Error("assessment correction limit is 1 per seat");
  }
  if (
    input.identity.agentId !== input.frozenIdentity.agentId ||
    input.identity.driverId !== input.frozenIdentity.driverId ||
    input.identity.modelId !== input.frozenIdentity.modelId
  ) {
    throw new Error("correction identity does not match the frozen reviewer");
  }
  if (input.workspaceHead !== input.candidateSha || !input.trackedClean) {
    throw new Error("correction requires a clean worktree at the candidate SHA");
  }
}

const PROVABLE_OUTCOMES = new Set(["verified_closed", "still_open", "not_evaluated"]);
const EVIDENCE_FIELDS = ["method", "reason", "evidence", "command", "locations"] as const;

function originalAssessmentRows(output: string): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const block of extractAssessmentBlocks(output)) {
    try {
      const parsed = JSON.parse(block);
      if (!Array.isArray(parsed)) continue;
      for (const row of parsed) {
        if (
          row &&
          typeof row === "object" &&
          typeof (row as { findingId?: unknown }).findingId === "string"
        ) {
          rows.set((row as { findingId: string }).findingId, row as Record<string, unknown>);
        }
      }
    } catch {
      /* original block may be invalid JSON */
    }
  }
  return rows;
}

function sameEvidenceField(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function projectCorrectionOutput(input: {
  originalOutput: string;
  correctionOutput: string;
  candidateSha: string;
  requestedFindingIds: readonly string[];
  sourceAttemptId: string;
}): {
  valid: DiagnosedAssessment[];
  rejected: AssessmentDiagnosticItem[];
  substantialChange: boolean;
} {
  const originals = originalAssessmentRows(input.originalOutput);
  const corrected = diagnoseAttemptAssessments({
    attemptId: "correction",
    output: input.correctionOutput,
    candidateSha: input.candidateSha,
  });
  const requested = new Set(input.requestedFindingIds);
  const valid: DiagnosedAssessment[] = [];
  const rejected: AssessmentDiagnosticItem[] = [
    ...corrected.items.filter((item) => item.status !== "valid"),
  ];
  let substantialChange = false;
  for (const row of corrected.valid) {
    if (!requested.has(row.assessment.findingId)) {
      rejected.push({
        findingId: row.assessment.findingId,
        attemptId: "correction",
        status: "semantic_mismatch",
        errorClass: "unrequested_id",
        errorPath: `/correction/${row.assessment.findingId}`,
      });
      continue;
    }
    const prior = originals.get(row.assessment.findingId);
    const priorOutcome = typeof prior?.outcome === "string" ? prior.outcome : null;
    if (!priorOutcome || !PROVABLE_OUTCOMES.has(priorOutcome)) {
      substantialChange = true;
      rejected.push({
        findingId: row.assessment.findingId,
        attemptId: "correction",
        status: "semantic_mismatch",
        errorClass: "unprovable_outcome",
        errorPath: `/correction/${row.assessment.findingId}/outcome`,
      });
      continue;
    }
    if (priorOutcome !== row.assessment.outcome) {
      substantialChange = true;
      rejected.push({
        findingId: row.assessment.findingId,
        attemptId: "correction",
        status: "semantic_mismatch",
        errorClass: "substantial_rejudgment",
        errorPath: `/correction/${row.assessment.findingId}/outcome`,
      });
      continue;
    }
    let fieldReplaced: (typeof EVIDENCE_FIELDS)[number] | null = null;
    for (const field of EVIDENCE_FIELDS) {
      if (!sameEvidenceField(prior?.[field], row.assessment[field])) {
        fieldReplaced = field;
        break;
      }
    }
    if (fieldReplaced) {
      substantialChange = true;
      rejected.push({
        findingId: row.assessment.findingId,
        attemptId: "correction",
        status: "semantic_mismatch",
        errorClass: "evidence_field_replaced",
        errorPath: `/correction/${row.assessment.findingId}/${fieldReplaced}`,
      });
      continue;
    }
    valid.push({ ...row, attemptId: input.sourceAttemptId });
  }
  return { valid, rejected, substantialChange };
}

export function appendCorrectionRecord(
  file: AssessmentCorrectionsFile | null | undefined,
  record: AssessmentCorrectionRecord,
): AssessmentCorrectionsFile {
  const parsed = assessmentCorrectionRecordSchema.parse(record);
  const base: AssessmentCorrectionsFile = file ?? {
    version: 1,
    kind: "councilkit-assessment-corrections",
    records: [],
  };
  if (base.records.some((row) => row.correctionId === parsed.correctionId)) return base;
  return { ...base, records: [...base.records, parsed] };
}

export function completeCorrectionRecord(
  file: AssessmentCorrectionsFile | null | undefined,
  patch: {
    correctionId: string;
    endedAt: string;
    correctionOutputSha256: string;
    accepted: boolean;
    trackedCleanAfter: boolean;
    reason: string;
  },
): AssessmentCorrectionsFile {
  const base: AssessmentCorrectionsFile = file ?? {
    version: 1,
    kind: "councilkit-assessment-corrections",
    records: [],
  };
  return {
    ...base,
    records: base.records.map((row) =>
      row.correctionId === patch.correctionId
        ? assessmentCorrectionRecordSchema.parse({
            ...row,
            endedAt: patch.endedAt,
            correctionOutputSha256: patch.correctionOutputSha256,
            accepted: patch.accepted,
            trackedCleanAfter: patch.trackedCleanAfter,
            reason: patch.reason,
          })
        : row,
    ),
  };
}

export function writeAssessmentCorrections(runDir: string, file: AssessmentCorrectionsFile): void {
  atomicWriteJson(
    join(runDir, ASSESSMENT_CORRECTIONS_FILE),
    assessmentCorrectionsFileSchema.parse(file),
  );
}

export function loadAssessmentCorrections(runDir: string): AssessmentCorrectionsFile | null {
  const path = join(runDir, ASSESSMENT_CORRECTIONS_FILE);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = assessmentCorrectionsFileSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function formatCorrectableIds(
  items: readonly AssessmentDiagnosticItem[],
  attemptId: string,
): {
  findingIds: string[];
  errorPaths: string[];
} {
  const findingIds: string[] = [];
  const errorPaths: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.attemptId !== attemptId || item.status !== "invalid" || item.findingId === null)
      continue;
    if (seen.has(item.findingId)) continue;
    seen.add(item.findingId);
    findingIds.push(item.findingId);
    errorPaths.push(item.errorPath);
  }
  return { findingIds, errorPaths };
}

export function replayAcceptedCorrections(input: {
  runDir: string;
  candidateSha: string;
  attempts: Iterable<{ attemptId: string; output: string }>;
}): DiagnosedAssessment[] {
  const records = loadAssessmentCorrections(input.runDir);
  if (!records || !FULL_COMMIT_SHA.test(input.candidateSha)) return [];
  const byId = new Map([...input.attempts].map((row) => [row.attemptId, row]));
  const extras: DiagnosedAssessment[] = [];
  for (const rec of records.records) {
    if (!rec.accepted) continue;
    const attempt = byId.get(rec.sourceAttemptId);
    if (!attempt) continue;
    let correctionOutput = "";
    try {
      correctionOutput = readFileSync(
        join(input.runDir, "corrections", `${rec.sourceAttemptId}.md`),
        "utf8",
      );
    } catch {
      continue;
    }
    const projected = projectCorrectionOutput({
      originalOutput: attempt.output,
      correctionOutput,
      candidateSha: input.candidateSha,
      requestedFindingIds: rec.requestedFindingIds,
      sourceAttemptId: rec.sourceAttemptId,
    });
    if (!projected.substantialChange) extras.push(...projected.valid);
  }
  return extras;
}
