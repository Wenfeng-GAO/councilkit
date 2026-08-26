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

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

const STATUS_RANK: Record<FindingStatus, number> = {
  regress: 0,
  open: 1,
  accepted: 2,
  closed: 3,
};

const SOURCE_RANK: Record<FindingSource, number> = {
  consensus: 0,
  unique: 1,
  unknown: 2,
};

export function compareFindingSeverity(
  a: FindingSeverity | null | undefined,
  b: FindingSeverity | null | undefined,
): number {
  const left = a == null ? FINDING_SEVERITIES.length : SEVERITY_RANK[a];
  const right = b == null ? FINDING_SEVERITIES.length : SEVERITY_RANK[b];
  return left - right;
}

export function sortLedgerFindings(findings: readonly LedgerFinding[]): LedgerFinding[] {
  return findings
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const severity = compareFindingSeverity(a.item.severity, b.item.severity);
      if (severity !== 0) return severity;
      const status = STATUS_RANK[a.item.status] - STATUS_RANK[b.item.status];
      if (status !== 0) return status;
      const source = SOURCE_RANK[a.item.source] - SOURCE_RANK[b.item.source];
      if (source !== 0) return source;
      const title = a.item.title.localeCompare(b.item.title);
      if (title !== 0) return title;
      const id = a.item.id.localeCompare(b.item.id);
      if (id !== 0) return id;
      return a.index - b.index;
    })
    .map((row) => row.item);
}

export interface LedgerFindingCounts {
  total: number;
  byStatus: Record<FindingStatus, number>;
  bySeverity: Record<FindingSeverity, number>;
}

export function countLedgerFindings(findings: readonly LedgerFinding[]): LedgerFindingCounts {
  const byStatus: Record<FindingStatus, number> = {
    open: 0,
    closed: 0,
    accepted: 0,
    regress: 0,
  };
  const bySeverity: Record<FindingSeverity, number> = {
    critical: 0,
    major: 0,
    minor: 0,
    nit: 0,
  };
  for (const row of findings) {
    byStatus[row.status] += 1;
    bySeverity[row.severity] += 1;
  }
  return { total: findings.length, byStatus, bySeverity };
}
