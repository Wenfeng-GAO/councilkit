/**
 * On-disk finding ledger for Autonomous Review runs.
 *
 * Files live next to report.md:
 *   findings.json     identity + status of each finding
 *   plan.lock.json    frozen clusters (closes / files / gates)
 *   landings.jsonl    one cluster → one candidate SHA
 *
 * Host and CLI share the file names and lenient parsers. Extraction from
 * report.md and plan.md lives in the CLI (`cli/src/auto/ledger.ts`).
 */
import { z } from "zod";

export const CLI_RUN_FINDINGS_FILE = "findings.json";
export const CLI_RUN_PLAN_LOCK_FILE = "plan.lock.json";
export const CLI_RUN_LANDINGS_FILE = "landings.jsonl";

export const FINDING_STATUSES = ["open", "closed", "accepted", "regress"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_SEVERITIES = ["critical", "major", "minor", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_SOURCES = ["consensus", "unique", "unknown"] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export const ledgerFindingSchema = z
  .object({
    id: z.string().min(1).max(160),
    severity: z.enum(FINDING_SEVERITIES),
    status: z.enum(FINDING_STATUSES),
    title: z.string().min(1).max(400),
    text: z.string().max(8000),
    source: z.enum(FINDING_SOURCES),
    reviewer: z.string().max(120).nullable(),
    files: z.array(z.string().min(1).max(400)).max(32),
  })
  .strict();
export type LedgerFinding = z.infer<typeof ledgerFindingSchema>;

export const findingsFileSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    extractedAt: z.string().min(1),
    sha: z.string().nullable(),
    againstRunId: z.string().nullable(),
    againstRange: z.string().nullable(),
    findings: z.array(ledgerFindingSchema).max(200),
  })
  .strict();
export type FindingsFile = z.infer<typeof findingsFileSchema>;

export const planClusterSchema = z
  .object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    closes: z.array(z.string().min(1).max(160)).max(32),
    files: z.array(z.string().min(1).max(400)).max(64),
    gates: z.array(z.string().min(1).max(400)).max(16),
    policy: z.string().max(400),
    invariants: z.string().max(2000),
    forbidden: z.string().max(2000),
    tests: z.string().max(2000),
    mentions: z.string().max(2000),
    body: z.string().max(20_000),
  })
  .strict();
export type PlanCluster = z.infer<typeof planClusterSchema>;

export const planLockFileSchema = z
  .object({
    version: z.literal(1),
    sourceRunId: z.string().min(1),
    approvedAt: z.string().min(1),
    verdict: z.enum(["approve", "changes-requested", "comment"]),
    clusters: z.array(planClusterSchema).max(32),
    deferred: z
      .array(
        z
          .object({
            title: z.string().min(1).max(400),
            reason: z.string().max(800),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type PlanLockFile = z.infer<typeof planLockFileSchema>;

export const landingRecordSchema = z
  .object({
    at: z.string().min(1),
    clusterId: z.string().min(1).max(80),
    parentSha: z.string().nullable(),
    candidateSha: z.string().nullable(),
    closed: z.array(z.string().min(1).max(160)).max(32),
    runId: z.string().min(1),
    pushed: z.boolean(),
  })
  .strict();
export type LandingRecord = z.infer<typeof landingRecordSchema>;

export function parseFindingsFile(text: string | null | undefined): FindingsFile | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = findingsFileSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parsePlanLockFile(text: string | null | undefined): PlanLockFile | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = planLockFileSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseLandingsText(text: string | null | undefined): LandingRecord[] {
  if (text === null || text === undefined) return [];
  const rows: LandingRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = landingRecordSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) rows.push(parsed.data);
    } catch {
      // skip a corrupt JSONL line
    }
  }
  return rows;
}

export function nextUnlandedCluster(
  lock: PlanLockFile | null,
  landings: readonly LandingRecord[],
): PlanCluster | null {
  if (lock === null || lock.clusters.length === 0) return null;
  const landed = new Set(landings.map((row) => row.clusterId));
  return lock.clusters.find((cluster) => !landed.has(cluster.id)) ?? null;
}

export function lastLandingRange(landings: readonly LandingRecord[]): string | null {
  const last = landings[landings.length - 1];
  if (!last) return null;
  if (!last.parentSha || !last.candidateSha) return null;
  return `${last.parentSha}...${last.candidateSha}`;
}
