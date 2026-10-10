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

export const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
/** `file:12` or `file:12-20`. Shared by assessment parse and persisted verification. */
export const ASSESSMENT_LOCATION = /.+:\d+(?:-\d+)?$/;
export const findingVerificationSchema = z
  .object({
    outcome: z.enum(["verified_closed", "still_open", "not_evaluated"]),
    candidateSha: z.string().regex(FULL_COMMIT_SHA),
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    reviewer: z.string().min(1).max(120),
    method: z.enum(["regression_test", "code_trace", "not_evaluated"]),
    reason: z.string().trim().min(1).max(2000),
    evidence: z.string().trim().min(1).max(4000),
    command: z.string().trim().min(1).max(2000).optional(),
    locations: z.array(z.string().regex(ASSESSMENT_LOCATION)).min(1).max(32).optional(),
    runComplete: z.boolean(),
  })
  .strict();
export type FindingVerification = z.infer<typeof findingVerificationSchema>;

export const findingRepairClaimSchema = z
  .object({
    candidateSha: z.string().regex(FULL_COMMIT_SHA).nullable(),
    runId: z.string().min(1),
    at: z.string().min(1),
  })
  .strict();
export type FindingRepairClaim = z.infer<typeof findingRepairClaimSchema>;

/** Spec-bound review: Act On vs suggest-amend-spec. Absent = legacy ledger row. */
export const FINDING_CONTRACT_CLASSES = ["in_contract", "out_of_spec"] as const;
export type FindingContractClass = (typeof FINDING_CONTRACT_CLASSES)[number];

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
    /** Present on spec-bound extracts; omitted on legacy findings.json rows. */
    contractClass: z.enum(FINDING_CONTRACT_CLASSES).nullable().optional(),
    invariantId: z.string().trim().min(1).max(200).nullable().optional(),
    counterexample: z.string().trim().min(1).max(4000).nullable().optional(),
    repairClaim: findingRepairClaimSchema.optional(),
    verification: findingVerificationSchema.optional(),
    acceptedReason: z.string().trim().min(1).max(2000).optional(),
    acceptedAt: z.string().min(1).optional(),
  })
  .strict();
export type LedgerFinding = z.infer<typeof ledgerFindingSchema>;

/** Legacy closed is a historical claim, never proof of a verified resolution. */
export function isFindingVerifiedClosed(row: LedgerFinding, sha?: string | null): boolean {
  const parsed = findingVerificationSchema.safeParse(row.verification);
  if (!parsed.success || row.status !== "closed") return false;
  const verification = parsed.data;
  return (
    verification.outcome === "verified_closed" &&
    verification.runComplete &&
    verification.method !== "not_evaluated" &&
    (verification.method === "regression_test"
      ? !!verification.command
      : !!verification.locations?.length) &&
    (!row.repairClaim || row.repairClaim.candidateSha === verification.candidateSha) &&
    (sha === undefined || sha === verification.candidateSha)
  );
}

/** True when a finding has the Act On contract footing (named invariant + counterexample). */
export function hasActOnFooting(
  row: Pick<LedgerFinding, "invariantId" | "counterexample">,
): boolean {
  const invariant = row.invariantId?.trim() ?? "";
  const counterexample = row.counterexample?.trim() ?? "";
  return invariant.length > 0 && counterexample.length > 0;
}

/**
 * Merge / repair gate. Spec-bound subtractive policy:
 * - nit / minor never block
 * - out_of_spec (suggest-amend-spec) never blocks by default
 * - in_contract Act On blocks only with invariantId + counterexample
 * - legacy rows (no contractClass) keep severity-based blocking
 */
export function isFindingBlocking(row: LedgerFinding, sha?: string | null): boolean {
  if (row.severity !== "critical" && row.severity !== "major") return false;
  if (row.status === "accepted") return false;
  if (isFindingVerifiedClosed(row, sha)) return false;
  if (row.contractClass === "out_of_spec") return false;
  if (row.contractClass === "in_contract") return hasActOnFooting(row);
  // Legacy findings.json without contractClass: severity-only gate.
  return true;
}

/** Parse Act On / out-of-spec tags and 不变量 / 反例 lines from report text.
 * Returns contractClass null when the finding has no new-format tags/fields so
 * legacy report extracts keep severity-based blocking. */
export function parseFindingContractFields(input: {
  qualifier?: string | null;
  text: string;
  sectionImpliesOutOfSpec?: boolean;
}): {
  contractClass: FindingContractClass | null;
  invariantId: string | null;
  counterexample: string | null;
} {
  const qualifier = (input.qualifier ?? "").trim().toLowerCase();
  const text = input.text;
  const outOfSpec =
    input.sectionImpliesOutOfSpec === true ||
    /^(?:suggest-amend-spec|out-of-spec|out_of_spec|amend-spec|规格外|建议修订规格)$/i.test(
      qualifier,
    ) ||
    /\b(?:suggest-amend-spec|out-of-spec)\b/i.test(qualifier);
  const actOnTagged =
    /^(?:act-on|合同内)$/i.test(qualifier) || /\bact-on\b/i.test(qualifier);
  const invariantId = firstField(text, [
    /(?:^|\n)\s*(?:不变量|不变式|invariant|acceptance(?:\s*id)?|验收)\s*[:：]\s*`?([^`\n]+?)`?\s*(?:\n|$)/i,
    /\b((?:AC|INV|AV)[-_][A-Za-z0-9][\w.-]{0,80})\b/,
  ]);
  const counterexample = firstField(text, [
    /(?:^|\n)\s*(?:反例|counter(?:\s*-?\s*example)?|复现)\s*[:：]\s*(.+?)(?=\n\s*(?:建议|位置|证据|不变量|不变式|invariant|acceptance|验收)\s*[:：]|\n\s*-\s|\n\n|$)/is,
  ]);
  if (outOfSpec) {
    return {
      contractClass: "out_of_spec",
      invariantId,
      counterexample,
    };
  }
  if (actOnTagged || invariantId !== null || counterexample !== null) {
    return {
      contractClass: "in_contract",
      invariantId,
      counterexample,
    };
  }
  return { contractClass: null, invariantId: null, counterexample: null };
}

function firstField(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const match = re.exec(text);
    const raw = match?.[1]?.trim();
    if (raw && raw.length > 0) return raw.slice(0, 4000);
  }
  return null;
}

export function findingStatusLabel(row: LedgerFinding, sha?: string | null): string {
  if (row.status === "accepted") {
    return row.acceptedReason ? `接受不修 · ${row.acceptedReason}` : "接受不修";
  }
  if (isFindingVerifiedClosed(row, sha)) return "已验证解决";
  if (row.status === "closed") return row.verification ? "待验证当前提交" : "历史未验证";
  if (row.verification?.outcome === "still_open") return "验证仍成立";
  if (row.repairClaim) return "声明已修复 · 待验证";
  if (row.status === "regress") return "回归";
  if (row.contractClass === "out_of_spec") return "规格外 · 建议修订规格";
  if (row.contractClass === "in_contract" && !hasActOnFooting(row)) {
    return "合同内缺脚注 · 不入 Act On";
  }
  return "未解决";
}

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
    /** New landings carry repair claims; legacy `closed` is also claim-only. */
    claimed: z.array(z.string().min(1).max(160)).max(32).optional(),
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
