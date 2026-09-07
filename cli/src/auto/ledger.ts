/**
 * Extract, classify, and persist the finding ledger for an Autonomous Run.
 *
 * findings.json is the identity of a hole. plan.lock.json freezes how a
 * cluster will close it. landings.jsonl records the SHA that claimed the close.
 * Incremental `--against` review classifies closed / regress / new against
 * that ledger instead of rediscovering the whole PR vs master.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ReviewFinding, parseReviewReport } from "@/lib/review-report";
import {
  CLI_RUN_FINDINGS_FILE,
  CLI_RUN_LANDINGS_FILE,
  CLI_RUN_PLAN_LOCK_FILE,
  FINDING_SEVERITIES,
  FULL_COMMIT_SHA,
  type FindingRepairClaim,
  type FindingSource,
  type FindingStatus,
  type FindingVerification,
  type FindingsFile,
  type LandingRecord,
  type LedgerFinding,
  type PlanCluster,
  type PlanLockFile,
  findingStatusLabel,
  isFindingVerifiedClosed,
  lastLandingRange,
  parseFindingsFile,
  parseLandingsText,
  parsePlanLockFile,
  sortLedgerFindings,
} from "@shared/runtime/cli-ledger";
import { z } from "zod";
import { atomicWriteJson } from "../store/atomic-write";
import type { AttemptResult } from "./runner";

export {
  CLI_RUN_FINDINGS_FILE,
  CLI_RUN_LANDINGS_FILE,
  CLI_RUN_PLAN_LOCK_FILE,
  lastLandingRange,
  parseFindingsFile,
  parseLandingsText,
  parsePlanLockFile,
  sortLedgerFindings,
};

/** Incremental `--against` range: prior review SHA → current PR SHA. */
export function againstDiffRange(input: {
  findingsSha: string | null | undefined;
  currentSha: string | null | undefined;
  fallback: string | null;
}): string | null {
  const from = input.findingsSha?.trim() ?? "";
  const to = input.currentSha?.trim() ?? "";
  if (from.length > 0 && to.length > 0 && from !== to) return `${from}...${to}`;
  return input.fallback;
}
export type { FindingsFile, LandingRecord, LedgerFinding, PlanCluster, PlanLockFile };

const CONSENSUS_TITLES = new Set(["共识发现", "consensus findings", "consensus"]);
const UNIQUE_TITLES = new Set(["独有发现", "unique findings", "unique"]);
const SKIP_TITLES = new Set([
  "概览",
  "overview",
  "分歧",
  "disagreements",
  "结论",
  "verdict",
  "过程对比",
  "附录",
  "附录:各审查者交付物",
]);

const PATH_RE = /(?:^|[^\w./-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][A-Za-z0-9]+)(?::\d+)?/g;

const CLUSTER_HEADING = /^###\s*(?:集群|cluster)\s*\d+\s*[:：]\s*(.+)$/i;

export function extractFindingsFromReport(input: {
  markdown: string;
  runId: string;
  extractedAt: string;
  sha?: string | null;
  againstRunId?: string | null;
  againstRange?: string | null;
}): FindingsFile {
  const parsed = parseReviewReport(input.markdown);
  const used = new Set<string>();
  const findings: LedgerFinding[] = [];
  if (parsed) {
    for (const section of parsed.sections) {
      const source = sectionSource(section.title);
      if (source === null) continue;
      if (section.groups && section.groups.length > 0) {
        for (const group of section.groups) {
          const reviewer =
            source === "unique" && group.title.trim().length > 0 ? group.title : null;
          for (const item of group.findings) {
            const row = toLedgerFinding(item, source, reviewer, used);
            if (row) findings.push(row);
          }
        }
      } else if (section.findings) {
        for (const item of section.findings) {
          const row = toLedgerFinding(item, source, null, used);
          if (row) findings.push(row);
        }
      }
    }
  }
  return {
    version: 1,
    runId: input.runId,
    extractedAt: input.extractedAt,
    sha: input.sha ?? null,
    againstRunId: input.againstRunId ?? null,
    againstRange: input.againstRange ?? null,
    findings: sortLedgerFindings(findings),
  };
}

export function classifyAgainstPrior(
  prior: readonly LedgerFinding[],
  next: readonly LedgerFinding[],
): LedgerFinding[] {
  const used = new Set<string>();
  const out: LedgerFinding[] = [];
  for (const old of prior) {
    if (old.status === "accepted") {
      out.push({ ...old });
      continue;
    }
    const match = matchFinding(old, next, used);
    if (match === null) {
      // Absence is missing coverage, never a closure receipt (including failed runs).
      out.push({ ...old });
      continue;
    }
    used.add(match.id);
    const { verification: _previousVerification, ...history } = old;
    out.push({
      ...history,
      ...match,
      id: old.id,
      status: isFindingVerifiedClosed(old) ? "regress" : "open",
    });
  }
  for (const fresh of next) {
    if (used.has(fresh.id)) continue;
    if (out.some((row) => row.id === fresh.id)) continue;
    out.push({ ...fresh, status: "open" });
  }
  return sortLedgerFindings(out);
}

export function markFindingsRepairClaimed(
  file: FindingsFile,
  ids: readonly string[],
  repairClaim: FindingRepairClaim,
): FindingsFile {
  const claimed = new Set(ids);
  return {
    ...file,
    findings: file.findings.map((row) => {
      if (!claimed.has(row.id) || row.status === "accepted") return row;
      // A new producer claim invalidates the old resolution; it is not a
      // verification of the newly applied candidate, even when file.sha is old.
      const { verification: _previousVerification, ...finding } = row;
      return { ...finding, status: "open" as const, repairClaim };
    }),
  };
}

export function parsePlanDocument(
  markdown: string,
  meta: {
    sourceRunId: string;
    approvedAt: string;
    verdict: PlanLockFile["verdict"];
  },
): PlanLockFile {
  const used = new Set<string>();
  const clusters: PlanCluster[] = [];
  for (const block of splitClusterBlocks(markdown)) {
    const cluster = clusterFromBlock(block.heading, block.body, used);
    clusters.push(cluster);
  }
  return {
    version: 1,
    sourceRunId: meta.sourceRunId,
    approvedAt: meta.approvedAt,
    verdict: meta.verdict,
    clusters,
    deferred: parseDeferred(markdown),
  };
}

export function resolveClusterCloses(
  cluster: PlanCluster,
  findings: readonly LedgerFinding[],
): string[] {
  if (cluster.closes.length > 0) return unique(cluster.closes);
  const hay = `${cluster.title}\n${cluster.mentions}\n${cluster.body}`.toLowerCase();
  const hayTokens = tokens(hay);
  const matched: string[] = [];
  for (const finding of findings) {
    if (finding.severity !== "critical" && finding.severity !== "major") continue;
    if (hay.includes(finding.id.toLowerCase())) {
      matched.push(finding.id);
      continue;
    }
    const fileHit = finding.files.some(
      (file) => cluster.files.includes(file) || hay.includes(file.toLowerCase()),
    );
    const titleCore = finding.title.replace(/^[\w./-]+:\s*/, "").toLowerCase();
    const titleHit =
      (titleCore.length >= 8 && hay.includes(titleCore.slice(0, Math.min(40, titleCore.length)))) ||
      tokenOverlap(tokens(finding.title), hayTokens) >= 0.4;
    if (fileHit || titleHit) matched.push(finding.id);
  }
  return unique(matched);
}

export function attachClosesFromFindings(
  lock: PlanLockFile,
  findings: readonly LedgerFinding[],
): PlanLockFile {
  return {
    ...lock,
    clusters: lock.clusters.map((cluster) => ({
      ...cluster,
      closes: resolveClusterCloses(cluster, findings),
    })),
  };
}

export function formatLedgerForPrompt(file: FindingsFile, range: string | null): string {
  const lines: string[] = [
    `对照账本 run ${file.runId}${file.sha ? ` @ ${file.sha.slice(0, 12)}` : ""}。`,
    "这是增量复审：不要把整份 PR 相对 master 再发现一遍。",
    "检查未解决、声明已修复和历史未验证项；仅有绑定本次完整 SHA 的独立验证可关闭。未提及不等于关闭。",
    "账本标 accepted 的项不要再当成阻塞，除非实现偏离了已接受的合同。",
  ];
  if (range) {
    lines.push(`对照 git 区间：\`${range}\`（在当前 worktree 里 \`git diff ${range}\`）。`);
  }
  const byStatus = (status: FindingStatus): LedgerFinding[] =>
    file.findings.filter((row) => row.status === status);
  for (const status of FINDING_STATUS_ORDER) {
    const rows = byStatus(status);
    lines.push("", `${status} (${rows.length})`);
    if (rows.length === 0) {
      lines.push("- （无）");
      continue;
    }
    for (const row of sortLedgerFindings(rows).slice(0, 40)) {
      lines.push(
        `- ${row.id} [${row.severity}] [${findingStatusLabel(row, file.sha)}] ${row.title}`,
      );
    }
    if (rows.length > 40) lines.push(`- …另有 ${rows.length - 40} 条`);
  }
  return lines.join("\n").slice(0, 12_000);
}

export function buildClusterPlanMarkdown(lock: PlanLockFile, cluster: PlanCluster): string {
  const lines = [
    "# 修复方案",
    "",
    `本轮只落地集群 \`${cluster.id}\`。其它集群禁止改动。`,
    "",
    "## 不变量",
    cluster.invariants.trim().length > 0 ? cluster.invariants.trim() : "（见集群正文）",
    "",
    "### 集群",
    cluster.body.trim().length > 0 ? cluster.body.trim() : `- id: ${cluster.id}`,
    "",
    "## 范围",
    cluster.files.length > 0
      ? cluster.files.map((file) => `- ${file}`).join("\n")
      : "- （方案未列文件）",
    "",
    "## 关闭",
    cluster.closes.length > 0
      ? cluster.closes.map((id) => `- ${id}`).join("\n")
      : "- （落地后由复审对照账本确认）",
    "",
    "## 门禁",
    cluster.gates.length > 0
      ? cluster.gates.map((gate) => `- ${gate}`).join("\n")
      : cluster.tests.trim().length > 0
        ? cluster.tests.trim()
        : "- （方案未列命令）",
    "",
    "## 本轮不落地",
    ...lock.deferred.map((row) => `- ${row.title}: ${row.reason}`),
    lock.deferred.length === 0 ? "- （无）" : "",
  ];
  return `${lines.filter((line) => line !== "").join("\n")}\n`;
}

export function readFindings(runDir: string): FindingsFile | null {
  return parseFindingsFile(readOptional(join(runDir, CLI_RUN_FINDINGS_FILE)));
}

export function readPlanLock(runDir: string): PlanLockFile | null {
  return parsePlanLockFile(readOptional(join(runDir, CLI_RUN_PLAN_LOCK_FILE)));
}

export function readLandings(runDir: string): LandingRecord[] {
  return parseLandingsText(readOptional(join(runDir, CLI_RUN_LANDINGS_FILE)));
}

export function writeFindings(runDir: string, file: FindingsFile): void {
  atomicWriteJson(join(runDir, CLI_RUN_FINDINGS_FILE), file);
}

export function writePlanLock(runDir: string, file: PlanLockFile): void {
  atomicWriteJson(join(runDir, CLI_RUN_PLAN_LOCK_FILE), file);
}

export function appendLanding(runDir: string, record: LandingRecord): void {
  appendFileSync(join(runDir, CLI_RUN_LANDINGS_FILE), `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function persistFindingsFromReport(input: {
  runDir: string;
  runId: string;
  markdown: string;
  sha?: string | null;
  againstRunId?: string | null;
  againstRange?: string | null;
  prior?: FindingsFile | null;
  attempts?: readonly AttemptResult[];
  reviewComplete?: boolean;
  verifiedAttemptShas?: Readonly<Record<string, string>>;
}): FindingsFile {
  const extracted = extractFindingsFromReport({
    markdown: input.markdown,
    runId: input.runId,
    extractedAt: new Date().toISOString(),
    sha: input.sha,
    againstRunId: input.againstRunId,
    againstRange: input.againstRange,
  });
  // Keep independent findings even when the Aggregator omits a severe minority finding.
  for (const attempt of input.attempts ?? []) {
    if (attempt.status !== "success") continue;
    const independent = extractFindingsFromReport({
      markdown: `# Autonomous Review Report\n\n---\n\n${attempt.output.replace(
        /^##\s+(?:发现|findings)\s*$/gim,
        "## 独有发现",
      )}`,
      runId: input.runId,
      extractedAt: extracted.extractedAt,
    });
    for (const row of independent.findings) {
      const matched = matchFinding(row, extracted.findings, new Set());
      if (!matched) {
        extracted.findings.push({ ...row, source: "unique", reviewer: attempt.agentName });
      } else {
        const stronger =
          FINDING_SEVERITIES.indexOf(row.severity) < FINDING_SEVERITIES.indexOf(matched.severity);
        if (stronger) {
          matched.severity = row.severity;
          matched.title = row.title;
          matched.source = "unique";
          matched.reviewer = attempt.agentName;
        }
        if (row.text !== matched.text) {
          // Put the stronger evidence first so the bounded field cannot truncate it away.
          const evidence = `${attempt.agentName}: ${row.text}`;
          matched.text = (
            stronger ? `${evidence}\n\n聚合摘要: ${matched.text}` : `${matched.text}\n\n${evidence}`
          ).slice(0, 8000);
        }
        matched.files = [...new Set([...matched.files, ...row.files])].slice(0, 32);
      }
    }
  }
  const file: FindingsFile =
    input.prior && input.againstRunId
      ? {
          ...extracted,
          findings: classifyAgainstPrior(input.prior.findings, extracted.findings),
        }
      : extracted;
  file.findings = applyReviewerVerifications(file.findings, {
    sha: input.sha,
    runId: input.runId,
    complete: input.reviewComplete === true,
    attempts: input.attempts ?? [],
    verifiedAttemptShas: input.verifiedAttemptShas ?? {},
    reportedFindings: extracted.findings,
  });
  writeFindings(input.runDir, file);
  return file;
}

export function ensureFindings(input: {
  runDir: string;
  runId: string;
  markdown: string;
  sha?: string | null;
}): FindingsFile {
  const existing = readFindings(input.runDir);
  if (existing) return existing;
  return persistFindingsFromReport({
    runDir: input.runDir,
    runId: input.runId,
    markdown: input.markdown,
    sha: input.sha,
  });
}

export function loadAgainstContext(
  againstRunDir: string,
  againstRunId: string,
): { findings: FindingsFile; range: string | null } {
  const landings = readLandings(againstRunDir);
  const range = lastLandingRange(landings);
  const existing = readFindings(againstRunDir);
  if (existing) return { findings: existing, range };
  let markdown = "";
  try {
    markdown = readFileSync(join(againstRunDir, "report.md"), "utf8");
  } catch {
    markdown = "";
  }
  const extracted = extractFindingsFromReport({
    markdown,
    runId: againstRunId,
    extractedAt: new Date().toISOString(),
    sha: null,
    againstRunId: null,
    againstRange: range,
  });
  return { findings: extracted, range };
}

const FINDING_STATUS_ORDER: FindingStatus[] = ["open", "regress", "closed", "accepted"];

function sectionSource(title: string): FindingSource | null {
  const key = title.trim().toLowerCase();
  if (CONSENSUS_TITLES.has(key)) return "consensus";
  if (UNIQUE_TITLES.has(key)) return "unique";
  if (SKIP_TITLES.has(key)) return null;
  return null;
}

function toLedgerFinding(
  item: ReviewFinding,
  source: FindingSource,
  reviewer: string | null,
  used: Set<string>,
): LedgerFinding | null {
  if (item.severity === null) return null;
  const text = item.text.trim();
  if (text.length === 0) return null;
  const title = firstLine(text).slice(0, 200);
  if (title.length === 0) return null;
  const files = extractPaths(text);
  const id = uniqueId(findingId(files[0] ?? null, title), used);
  used.add(id);
  return {
    id,
    severity: item.severity,
    status: "open",
    title,
    text: text.slice(0, 4000),
    source,
    reviewer,
    files,
  };
}

function findingId(path: string | null, title: string): string {
  const fileSlug = slugify(path ? path.replaceAll("/", ".") : "misc");
  const titleSlug = slugify(title)
    .split("-")
    .filter((part) => part.length > 1)
    .slice(0, 6)
    .join("-");
  const id = `${fileSlug}--${titleSlug || "finding"}`;
  return id.slice(0, 96);
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function extractPaths(text: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null = PATH_RE.exec(text);
  while (match) {
    const path = match[1];
    if (path && !seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
    if (files.length >= 8) break;
    match = PATH_RE.exec(text);
  }
  return files;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")[0]
      ?.replace(/^[-*]\s+/, "")
      .trim() ?? text.trim()
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function matchFinding(
  prior: LedgerFinding,
  next: readonly LedgerFinding[],
  used: Set<string>,
): LedgerFinding | null {
  const byId = next.find((row) => row.id === prior.id && !used.has(row.id));
  if (byId) return byId;
  // Reports often quote an existing ID; never slugify that quote into misc--misc--… .
  const byReference = next.find(
    (row) =>
      !used.has(row.id) &&
      (explicitFindingIds(row.text).includes(prior.id) ||
        explicitFindingIds(prior.text).includes(row.id)),
  );
  if (byReference) return byReference;
  let best: { row: LedgerFinding; score: number } | null = null;
  const priorTokens = tokens(prior.title);
  for (const row of next) {
    if (used.has(row.id)) continue;
    if (row.severity !== prior.severity) continue;
    const sameFile = prior.files.length > 0 && row.files.some((file) => prior.files.includes(file));
    const overlap = tokenOverlap(priorTokens, tokens(row.title));
    const score = (sameFile ? 0.4 : 0) + overlap;
    if (score < 0.55) continue;
    if (best === null || score > best.score) best = { row, score };
  }
  return best?.row ?? null;
}

function explicitFindingIds(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter((id) => id.length > 0 && id.length <= 160 && !/\s/.test(id));
}

const reviewerAssessmentSchema = z
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

/** Only original reviewer final output is a source. The Aggregator cannot create receipts. */
export function applyReviewerVerifications(
  findings: readonly LedgerFinding[],
  input: {
    sha?: string | null;
    runId: string;
    complete: boolean;
    attempts: readonly AttemptResult[];
    reportedFindings: readonly LedgerFinding[];
    verifiedAttemptShas: Readonly<Record<string, string>>;
  },
): LedgerFinding[] {
  if (!input.sha || !FULL_COMMIT_SHA.test(input.sha)) return [...findings];
  const assessments = new Map<string, FindingVerification[]>();
  for (const attempt of input.attempts) {
    if (
      attempt.status !== "success" ||
      attempt.exitCode !== 0 ||
      !attempt.workspace ||
      attempt.attemptId === "aggregator"
    )
      continue;
    for (const block of attempt.output.matchAll(/```councilkit-findings\s*\n([\s\S]*?)\n```/g)) {
      let rows: unknown;
      try {
        rows = JSON.parse(block[1] ?? "");
      } catch {
        continue;
      }
      if (!Array.isArray(rows) || rows.length > 200) continue;
      for (const raw of rows) {
        const parsed = reviewerAssessmentSchema.safeParse(raw);
        if (!parsed.success || parsed.data.candidateSha !== input.sha) continue;
        const { findingId, ...assessment } = parsed.data;
        if (assessment.outcome === "verified_closed" && assessment.method === "not_evaluated")
          continue;
        if (
          assessment.outcome === "verified_closed" &&
          (input.verifiedAttemptShas[attempt.attemptId] !== input.sha ||
            (assessment.method === "regression_test"
              ? !assessment.command
              : !assessment.locations?.length))
        )
          continue;
        const list = assessments.get(findingId) ?? [];
        list.push({
          ...assessment,
          runId: input.runId,
          attemptId: attempt.attemptId,
          reviewer: attempt.agentName,
          runComplete: input.complete,
        });
        assessments.set(findingId, list);
      }
    }
  }
  return sortLedgerFindings(
    findings.map((row) => {
      if (row.status === "accepted") return row;
      const receipts = assessments.get(row.id) ?? [];
      const stillOpen = receipts.find((receipt) => receipt.outcome === "still_open");
      if (stillOpen) return { ...row, status: "open" as const, verification: stillOpen };
      // Contradicting findings, including unique ones, outrank any closure claim.
      const reported = matchFinding(row, input.reportedFindings, new Set()) !== null;
      const closure = receipts.find((receipt) => receipt.outcome === "verified_closed");
      if (closure && input.complete && !reported) {
        return { ...row, status: "closed" as const, verification: closure };
      }
      const unevaluated = receipts.find((receipt) => receipt.outcome === "not_evaluated");
      return unevaluated ? { ...row, verification: unevaluated } : row;
    }),
  );
}

function tokens(text: string): Set<string> {
  return new Set(
    slugify(text)
      .split("-")
      .filter((part) => part.length > 1),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const token of a) {
    if (b.has(token)) hit += 1;
  }
  return hit / Math.max(a.size, b.size);
}

function splitClusterBlocks(markdown: string): Array<{ heading: string; body: string }> {
  const start = markdown.search(/^## 落地顺序\s*$/m);
  const region = start >= 0 ? markdown.slice(start) : markdown;
  const end = region.search(/^## (?:本轮不落地|合并门槛|分歧|结论)\s*$/m);
  const body = (end < 0 ? region : region.slice(0, end)).split("\n");
  const blocks: Array<{ heading: string; body: string }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of body) {
    const heading = CLUSTER_HEADING.exec(line);
    if (heading) {
      if (current) blocks.push({ heading: current.heading, body: current.lines.join("\n").trim() });
      current = { heading: heading[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push({ heading: current.heading, body: current.lines.join("\n").trim() });
  return blocks.filter((block) => block.heading.length > 0);
}

function clusterFromBlock(heading: string, body: string, used: Set<string>): PlanCluster {
  const keys = parseKeyedItems(body);
  const rawId = keys.id ?? heading;
  const id = uniqueId(slugify(rawId).slice(0, 64) || "cluster", used);
  used.add(id);
  return {
    id,
    title: heading.slice(0, 200) || id,
    closes: splitCsv(keys.closes),
    files: unique([...splitCsv(keys.files), ...extractPaths(body)]),
    gates: splitCsv(keys.gates),
    policy: keys.policy ?? "",
    invariants: keys.invariants ?? "",
    forbidden: keys.forbidden ?? "",
    tests: keys.tests ?? "",
    mentions: keys.mentions ?? "",
    body: body.slice(0, 16_000),
  };
}

function parseKeyedItems(body: string): Record<string, string> {
  const aliases: Record<string, string> = {
    id: "id",
    closes: "closes",
    关闭: "closes",
    files: "files",
    范围文件: "files",
    范围: "files",
    gates: "gates",
    门禁: "gates",
    测试: "tests",
    方针: "policy",
    policy: "policy",
    不变量: "invariants",
    禁止: "forbidden",
    对应发现: "mentions",
  };
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = /^- ([^:：]+)[:：]\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = aliases[match[1].trim()];
    if (!key) continue;
    const value = match[2].trim();
    if (value.length === 0) continue;
    out[key] = out[key] && out[key].length > 0 ? `${out[key]}; ${value}` : value;
  }
  return out;
}

function parseDeferred(markdown: string): Array<{ title: string; reason: string }> {
  const start = markdown.search(/^## 本轮不落地\s*$/m);
  if (start < 0) return [];
  const after = markdown.slice(start).replace(/^## 本轮不落地\s*\n*/, "");
  const end = after.search(/^## /m);
  const body = (end < 0 ? after : after.slice(0, end)).trim();
  const rows: Array<{ title: string; reason: string }> = [];
  for (const line of body.split("\n")) {
    const match = /^- (.+)$/.exec(line);
    if (!match) continue;
    const raw = match[1].trim();
    const split = raw.search(/[:：]/);
    if (split < 0) {
      rows.push({ title: raw.slice(0, 400), reason: "" });
    } else {
      rows.push({
        title: raw.slice(0, split).trim().slice(0, 400),
        reason: raw
          .slice(split + 1)
          .trim()
          .slice(0, 800),
      });
    }
  }
  return rows;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return unique(
    value
      .split(/[,;，、]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part !== "…" && part !== "..."),
  );
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
