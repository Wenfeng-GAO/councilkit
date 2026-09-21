/**
 * Reading projection over the finding ledger.
 *
 * Groups are display-only: they never rewrite findings, change repair gates,
 * CLI close authority, or exported ids. Close/blocking still use
 * isFindingVerifiedClosed / isFindingBlocking on each original member.
 */
import {
  type FindingSeverity,
  type FindingSource,
  type LedgerFinding,
  compareFindingSeverity,
  findingStatusLabel,
  isFindingBlocking,
  isFindingVerifiedClosed,
  sortLedgerFindings,
} from "@shared/runtime/cli-ledger";
import {
  FindingGroupsError,
  type FindingGroupsFile,
  validateFindingGroups,
} from "@shared/runtime/finding-groups";

const FILE_EXT = String.raw`[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}`;
const LOCATION_PATTERN = String.raw`((?:[\w.-]+\/)*${FILE_EXT}):(\d+)(?:-(\d+))?`;

function locationRe(): RegExp {
  return new RegExp(LOCATION_PATTERN, "g");
}

export const FINDING_LIST_FILTERS = ["blocking", "pending", "resolved", "all"] as const;
export type FindingListFilter = (typeof FINDING_LIST_FILTERS)[number];

export const FINDING_LIST_FILTER_LABEL: Record<FindingListFilter, string> = {
  blocking: "阻塞",
  pending: "待处理",
  resolved: "已解决",
  all: "全部",
};

export type FindingListOrigin = "sidecar" | "inferred" | "singleton";

export interface FindingListProblem {
  key: string;
  title: string;
  severity: FindingSeverity;
  source: FindingSource;
  sourceTags: Array<"共识" | "独有">;
  reviewers: string[];
  blocking: boolean;
  pending: boolean;
  resolved: boolean;
  statusLabel: string;
  members: LedgerFinding[];
  basis: string | null;
  origin: FindingListOrigin;
}

export interface FindingListProjection {
  problems: FindingListProblem[];
  originalCount: number;
  displayCount: number;
  blockingCount: number;
  pendingCount: number;
  resolvedCount: number;
}

export type AgainstLedgerState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; runId: string; sha: string | null; findings: readonly LedgerFinding[] };

export type LedgerComparison =
  | { status: "none" }
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "compared";
      added: number;
      remaining: number;
      resolved: number;
      accepted: number;
      againstRunId: string;
    };

/** Visible row title limit; full text stays on members. */
export const FINDING_TITLE_DISPLAY_LIMIT = 80;

interface CitedLocation {
  path: string;
  start: number;
  end: number;
}

export function usableFindingGroups(
  groups: FindingGroupsFile | null | undefined,
  findings: readonly LedgerFinding[],
): FindingGroupsFile | null {
  if (!groups) return null;
  try {
    validateFindingGroups(groups, new Set(findings.map((row) => row.id)));
    return groups;
  } catch (error) {
    if (error instanceof FindingGroupsError) return null;
    return null;
  }
}

export function projectFindingList(
  findings: readonly LedgerFinding[],
  options: {
    sha?: string | null;
    groups?: FindingGroupsFile | null;
  } = {},
): FindingListProjection {
  const sha = options.sha ?? null;
  const groups = usableFindingGroups(options.groups, findings);
  const claimed = new Set<string>();
  const problems: FindingListProblem[] = [];

  if (groups) {
    const byRoot = new Map<string, { members: LedgerFinding[]; basis: string }>();
    for (const group of groups.groups) {
      const ids = new Set([...group.findingIds, ...group.aliases]);
      const members = findings.filter((row) => ids.has(row.id));
      if (members.length === 0) continue;
      const bucket = byRoot.get(group.rootCauseId);
      if (bucket) {
        for (const row of members) {
          if (!bucket.members.some((existing) => existing.id === row.id)) {
            bucket.members.push(row);
          }
        }
      } else {
        byRoot.set(group.rootCauseId, { members: [...members], basis: group.basis });
      }
    }
    for (const [rootCauseId, bucket] of byRoot) {
      for (const row of bucket.members) claimed.add(row.id);
      problems.push(
        toProblem(bucket.members, sha, {
          key: rootCauseId,
          origin: bucket.members.length > 1 ? "sidecar" : "singleton",
          basis: bucket.basis,
        }),
      );
    }
  }

  const rest = findings.filter((row) => !claimed.has(row.id));
  for (const members of inferDuplicateGroups(rest)) {
    const origin: FindingListOrigin = members.length > 1 ? "inferred" : "singleton";
    problems.push(
      toProblem(members, sha, {
        key: members[0]?.id ?? "finding",
        origin,
        basis: origin === "inferred" ? inferredBasis(members) : null,
      }),
    );
  }

  const ordered = sortProblems(problems);
  return {
    problems: ordered,
    originalCount: findings.length,
    displayCount: ordered.length,
    blockingCount: ordered.filter((row) => row.blocking).length,
    pendingCount: ordered.filter((row) => row.pending).length,
    resolvedCount: ordered.filter((row) => row.resolved).length,
  };
}

export function defaultFindingListFilter(projection: FindingListProjection): FindingListFilter {
  if (projection.blockingCount > 0) return "blocking";
  if (projection.pendingCount > 0) return "pending";
  return "pending";
}

export function filterFindingProblems(
  problems: readonly FindingListProblem[],
  filter: FindingListFilter,
): FindingListProblem[] {
  if (filter === "all") return [...problems];
  if (filter === "blocking") return problems.filter((row) => row.blocking);
  if (filter === "pending") return problems.filter((row) => row.pending);
  return problems.filter((row) => row.resolved);
}

export function problemStatusLabel(members: readonly LedgerFinding[], sha?: string | null): string {
  if (members.length === 0) return "待处理";
  if (members.every((row) => isFindingVerifiedClosed(row, sha))) return "已验证解决";
  if (members.every((row) => row.status === "accepted")) {
    return findingStatusLabel(members[0] as LedgerFinding, sha);
  }
  if (members.every((row) => isFindingVerifiedClosed(row, sha) || row.status === "accepted")) {
    return "已处理（含接受不修）";
  }
  if (members.some((row) => isFindingBlocking(row, sha))) {
    const labels = new Set(members.map((row) => displayStatusLabel(row, sha)));
    if (labels.size === 1) return [...labels][0] ?? "待处理";
    return "待处理";
  }
  const labels = new Set(members.map((row) => displayStatusLabel(row, sha)));
  if (labels.size === 1) return [...labels][0] ?? "待处理";
  return "待处理";
}

export function displayStatusLabel(row: LedgerFinding, sha?: string | null): string {
  const label = findingStatusLabel(row, sha);
  return label === "未解决" ? "待处理" : label;
}

export function compareFindingLedgers(input: {
  current: readonly LedgerFinding[];
  currentSha: string | null;
  against: AgainstLedgerState;
}): LedgerComparison {
  if (input.against.status !== "ready") return { status: input.against.status };
  const priorById = new Map(input.against.findings.map((row) => [row.id, row]));
  const currentById = new Map(input.current.map((row) => [row.id, row]));
  let added = 0;
  let remaining = 0;
  let resolved = 0;
  let accepted = 0;
  for (const row of input.current) {
    if (!priorById.has(row.id)) {
      added += 1;
      continue;
    }
    if (row.status === "accepted" || isFindingVerifiedClosed(row, input.currentSha)) continue;
    remaining += 1;
  }
  for (const prior of input.against.findings) {
    const now = currentById.get(prior.id);
    if (!now) continue;
    const wasPending =
      prior.status !== "accepted" && !isFindingVerifiedClosed(prior, input.against.sha);
    if (!wasPending) continue;
    if (isFindingVerifiedClosed(now, input.currentSha)) resolved += 1;
    else if (now.status === "accepted") accepted += 1;
  }
  return {
    status: "compared",
    added,
    remaining,
    resolved,
    accepted,
    againstRunId: input.against.runId,
  };
}

export function againstLedgerFromDetail(run: {
  runId: string;
  hasFindings?: boolean;
  findings: readonly LedgerFinding[];
  reviewEvidence?: { sha: string | null } | null;
}): AgainstLedgerState {
  if (run.hasFindings !== true && run.findings.length === 0) {
    return { status: "unavailable" };
  }
  return {
    status: "ready",
    runId: run.runId,
    sha: run.reviewEvidence?.sha ?? null,
    findings: run.findings,
  };
}

export function formatLedgerComparison(comparison: LedgerComparison): string | null {
  if (comparison.status === "loading") return "正在读取关联账本…";
  if (comparison.status === "unavailable") return "无法比较：关联账本缺失或读取失败";
  if (comparison.status !== "compared") return null;
  return `对照关联账本：新增 ${comparison.added} · 仍存在 ${comparison.remaining} · 已解决 ${comparison.resolved} · 接受不修 ${comparison.accepted}`;
}

export function reviewCoverageLabel(input: {
  kind: string;
  againstRunId: string | null | undefined;
  evidenceComplete: boolean | undefined;
  uncoveredIds?: readonly string[];
}): string | null {
  if (input.kind !== "review" || !input.againstRunId) return null;
  if (input.evidenceComplete === false) {
    const uncovered = input.uncoveredIds ?? [];
    return uncovered.length > 0
      ? `历史问题评估覆盖不完整，缺 ${uncovered.slice(0, 5).join("、")}`
      : "历史问题评估覆盖不完整";
  }
  if (input.evidenceComplete === true) return "历史问题评估覆盖完整";
  return null;
}

export function reviewRelationLabel(
  kind: string,
  againstRunId: string | null | undefined,
): string | null {
  if (kind !== "review") return null;
  if (!againstRunId) return "本轮新审查，未关联历史修复记录";
  return null;
}

export function formatFindingCountNote(projection: FindingListProjection): string | null {
  if (projection.displayCount === projection.originalCount) return null;
  const merged = projection.originalCount - projection.displayCount;
  return `展示 ${projection.displayCount} 个问题 · 账本 ${projection.originalCount} 条记录，${merged} 条已合并阅读（原始记录保留）`;
}

export function emptyFindingListCopy(filter: FindingListFilter): string {
  if (filter === "blocking") return "没有阻塞问题。可用筛选查看其它待处理或已解决问题。";
  if (filter === "pending") return "没有待处理问题。已验证解决和接受不修可在筛选中查看。";
  if (filter === "resolved") return "没有已验证解决或接受不修的问题。";
  return "这份审查还没有问题记录。";
}

function toProblem(
  members: readonly LedgerFinding[],
  sha: string | null,
  meta: { key: string; origin: FindingListOrigin; basis: string | null },
): FindingListProblem {
  const ordered = sortLedgerFindings([...members]);
  const representative =
    ordered.find((row) => row.severity === highestSeverity(ordered)) ?? ordered[0];
  const blocking = ordered.some((row) => isFindingBlocking(row, sha));
  const settled = ordered.every(
    (row) => isFindingVerifiedClosed(row, sha) || row.status === "accepted",
  );
  const pending = !settled;
  const resolved = settled;
  const sourceTags: Array<"共识" | "独有"> = [];
  if (ordered.some((row) => row.source === "consensus")) sourceTags.push("共识");
  if (ordered.some((row) => row.source === "unique")) sourceTags.push("独有");
  const reviewers = [
    ...new Set(ordered.map((row) => row.reviewer).filter((name): name is string => Boolean(name))),
  ];
  return {
    key: meta.key,
    title: readableFindingTitle(representative?.title ?? ordered[0]?.title ?? meta.key),
    severity: highestSeverity(ordered),
    source: representative?.source ?? "unknown",
    sourceTags,
    reviewers,
    blocking,
    pending,
    resolved,
    statusLabel: problemStatusLabel(ordered, sha),
    members: ordered,
    basis: meta.basis,
    origin: meta.origin,
  };
}

function highestSeverity(members: readonly LedgerFinding[]): FindingSeverity {
  let best: FindingSeverity = "nit";
  for (const row of members) {
    if (compareFindingSeverity(row.severity, best) < 0) best = row.severity;
  }
  return best;
}

function sortProblems(problems: readonly FindingListProblem[]): FindingListProblem[] {
  const rank: Record<FindingListProblem["source"], number> = {
    consensus: 0,
    unique: 1,
    unknown: 2,
  };
  return problems
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const severity = compareFindingSeverity(a.item.severity, b.item.severity);
      if (severity !== 0) return severity;
      if (a.item.blocking !== b.item.blocking) return a.item.blocking ? -1 : 1;
      if (a.item.pending !== b.item.pending) return a.item.pending ? -1 : 1;
      const source = rank[a.item.source] - rank[b.item.source];
      if (source !== 0) return source;
      const title = a.item.title.localeCompare(b.item.title);
      if (title !== 0) return title;
      return a.index - b.index;
    })
    .map((row) => row.item);
}

function inferDuplicateGroups(findings: readonly LedgerFinding[]): LedgerFinding[][] {
  const groups: LedgerFinding[][] = [];
  for (const row of findings) {
    const host = groups.find((group) => group.every((member) => isProvenDuplicate(member, row)));
    if (host) host.push(row);
    else groups.push([row]);
  }
  return groups;
}

export function isProvenDuplicate(left: LedgerFinding, right: LedgerFinding): boolean {
  if (left.id === right.id) return true;
  if (!locationsMatch(primaryLocations(left), primaryLocations(right))) return false;
  return residualEvidence(left.title, right.title);
}

export function readableFindingTitle(title: string): string {
  const line = firstLine(title);
  const loc = parseLocations(line)[0];
  const locLabel = loc
    ? `${baseName(loc.path)}:${loc.start === loc.end ? String(loc.start) : `${loc.start}-${loc.end}`}`
    : null;
  const clause =
    stripLocations(line)
      .replace(/`+/g, " ")
      .replace(/\s*\+\s*/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[—–\-\s:：]+/, "")
      .split(/[。！？\n]/u)[0]
      ?.trim() ?? "";
  const assembled = locLabel && clause ? `${locLabel} — ${clause}` : locLabel || clause || line;
  return truncateDisplayTitle(assembled, FINDING_TITLE_DISPLAY_LIMIT);
}

function primaryLocations(row: LedgerFinding): CitedLocation[] {
  const head = `${firstLine(row.title)}\n${firstLine(row.text)}`;
  const found = parseLocations(head);
  if (found.length > 0) return found;
  const line = firstLineNumber(head);
  if (line === null) return [];
  return row.files
    .filter((file) => file.includes("."))
    .map((path) => ({ path, start: line, end: line }));
}

function parseLocations(text: string): CitedLocation[] {
  const out: CitedLocation[] = [];
  const seen = new Set<string>();
  const re = locationRe();
  let match = re.exec(text);
  while (match) {
    const path = match[1];
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : start;
    if (path && Number.isFinite(start)) {
      const key = `${normalizePath(path)}:${start}-${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ path, start, end });
      }
    }
    match = re.exec(text);
  }
  return out;
}

function locationsMatch(left: readonly CitedLocation[], right: readonly CitedLocation[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (a.start === b.start && a.end === b.end && pathsCompatible(a.path, b.path)) return true;
    }
  }
  return false;
}

function pathsCompatible(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
}

function residualEvidence(leftTitle: string, rightTitle: string): boolean {
  const leftId = residualIdentity(leftTitle);
  const rightId = residualIdentity(rightTitle);
  if (leftId.length === 0 || rightId.length === 0) return false;
  const shared = longestCommonSubstringText(leftId, rightId);
  let coreLeft = leftId;
  let coreRight = rightId;
  if (shared.length >= 6) {
    coreLeft = leftId.replace(shared, "");
    coreRight = rightId.replace(shared, "");
  }
  if (isThinIdentity(coreLeft) || isThinIdentity(coreRight)) return shared.length >= 6;
  return independentFragmentOverlap(identityFragments(coreLeft), identityFragments(coreRight)) >= 1;
}

function residualIdentity(title: string): string {
  const source = residualSource(title);
  const acronyms = Array.from(source.matchAll(/\b[A-Z]{2,8}\b/g), (match) => match[0]);
  const cjk = Array.from(source)
    .filter((char) => /\p{Script=Han}/u.test(char))
    .join("");
  return `${acronyms.join("")}${cjk}`;
}

function residualSource(title: string): string {
  return stripLocations(title)
    .replace(/`[^`]*`/g, " ")
    .replace(/[A-Za-z]+_[A-Za-z0-9_]+/g, " ")
    .replace(/\b[A-Za-z][A-Za-z0-9]*\b/g, (word) =>
      /[a-z]/.test(word) && /[A-Z]/.test(word) ? " " : word,
    )
    .replace(/\b[A-Z][a-z]{2,}\b/g, " ");
}

function isThinIdentity(identity: string): boolean {
  const cjk = Array.from(identity)
    .filter((char) => /\p{Script=Han}/u.test(char))
    .join("");
  return cjk.length < 3 && !/[A-Z]{2,8}/.test(identity);
}

function identityFragments(identity: string): string[] {
  const fragments: string[] = [];
  for (const match of identity.matchAll(/[A-Z]{2,8}/g)) fragments.push(match[0].toLowerCase());
  for (const match of identity.matchAll(/\p{Script=Han}{3,}/gu)) fragments.push(match[0] ?? "");
  return fragments;
}

function independentFragmentOverlap(left: readonly string[], right: readonly string[]): number {
  const used = new Set<number>();
  let matches = 0;
  const ordered = [...left].sort((a, b) => b.length - a.length);
  for (const fragment of ordered) {
    const index = right.findIndex(
      (candidate, pos) => !used.has(pos) && fragmentsMatch(fragment, candidate),
    );
    if (index < 0) continue;
    used.add(index);
    matches += 1;
  }
  return matches;
}

function fragmentsMatch(left: string, right: string): boolean {
  if (left === right) return left.length >= 3;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) >= 3;
  const lcs = longestCommonSubstring(left, right);
  const shorter = Math.min(left.length, right.length);
  return lcs >= 4 && lcs / shorter >= 0.8;
}

function longestCommonSubstring(left: string, right: string): number {
  return longestCommonSubstringText(left, right).length;
}

function longestCommonSubstringText(left: string, right: string): string {
  if (left.length === 0 || right.length === 0) return "";
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  let best = 0;
  let end = 0;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (left[i - 1] !== right[j - 1]) continue;
      const value = (dp[i - 1]?.[j - 1] ?? 0) + 1;
      const row = dp[i];
      if (row) row[j] = value;
      if (value > best) {
        best = value;
        end = i;
      }
    }
  }
  return best === 0 ? "" : left.slice(end - best, end);
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function truncateDisplayTitle(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars
    .slice(0, limit - 1)
    .join("")
    .replace(/[，。；、\s—–\-]+$/u, "")}…`;
}

function stripLocations(title: string): string {
  return title
    .replace(locationRe(), " ")
    .replace(/^[—–\-\s:：]+/, "")
    .trim();
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function firstLineNumber(text: string): number | null {
  const match = /:(\d+)(?:-\d+)?/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function inferredBasis(members: readonly LedgerFinding[]): string {
  const locations = members.flatMap((row) => primaryLocations(row));
  const shown = locations[0];
  if (!shown) return "阅读合并：相近问题描述，原始记录保留";
  const line = shown.start === shown.end ? `${shown.start}` : `${shown.start}-${shown.end}`;
  return `阅读合并：相同定位 ${shown.path}:${line} 与相近问题描述，原始记录保留`;
}

export function severityLabel(severity: FindingSeverity): string {
  const labels: Record<FindingSeverity, string> = {
    critical: "致命",
    major: "重大",
    minor: "次要",
    nit: "琐碎",
  };
  return labels[severity];
}
