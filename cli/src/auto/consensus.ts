/**
 * Deterministic aggregate shaping.
 *
 * The aggregator model used to mark every no-spec defect as suggest-amend-spec
 * and then conclude `comment`, even when every seat had said changes-requested
 * about the same bug. This module is the gate: with no spec bound, a defect
 * reported by a majority of completed seats (more than half, and at least two)
 * at high severity (critical or major) becomes changes-requested and is labeled
 * separately from a spec violation. A finding from only one seat does not block.
 *
 * With a spec bound, finding judgement is left as the aggregator wrote it.
 * The conclusion section is still moved to the front and tagged when it
 * already names an acceptance id.
 */
import { markdownLines } from "@shared/runtime/aggregator-verdict";
import { summarizeSeatOutput } from "@shared/runtime/seat-result";
import { type ReportAbsence, formatAbsence, formatAbsenceNote } from "./absences";
import type { ReviewTask } from "./templates/review";

export interface ConsensusSeat {
  agentName: string;
  status: string;
  output: string;
}

type Severity = "critical" | "major" | "minor" | "nit";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

const HIGH_SEVERITY = new Set<Severity>(["critical", "major"]);

const TOKEN_STOP = new Set([
  "位置",
  "触发",
  "后果",
  "建议",
  "证据",
  "不变量",
  "反例",
  "验证",
  "发现",
  "结论",
  "问题",
  "这个",
  "一个",
  "以及",
  "如果",
  "因为",
  "所以",
  "应该",
  "需要",
  "已经",
  "没有",
  "不是",
  "可以",
  "进行",
  "相关",
  "以下",
  "其中",
  "修改",
  "改成",
  "改为",
  "变成",
  "删除",
  "返回",
  "结果",
  "函数",
  "代码",
  "实现",
  "逻辑",
  "错误",
  "导致",
  "影响",
  "调用",
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "file",
  "files",
  "finding",
  "findings",
  "issue",
  "issues",
  "major",
  "minor",
  "critical",
  "nit",
]);

interface SeatFinding {
  seat: string;
  severity: Severity;
  title: string;
  body: string;
  tokens: Set<string>;
}

interface FindingCluster {
  findings: SeatFinding[];
  seats: string[];
  severity: Severity;
  title: string;
  detail: string;
}

export function shapeAggregateDeliverable(input: {
  markdown: string;
  task: Pick<ReviewTask, "specSource" | "specText">;
  attempts: readonly ConsensusSeat[];
  absences?: readonly ReportAbsence[];
}): string {
  const specBound = Boolean(input.task.specSource?.trim());
  const drafted = !specBound
    ? (synthesizeNoSpecAggregate(input.markdown, input.attempts) ??
      promoteConclusion(input.markdown))
    : annotateSpecViolations(promoteConclusion(input.markdown), input.task.specText);
  const presentCount = input.attempts.filter((seat) => seat.status === "success").length;
  return applyDesignerOrder(drafted, specBound, input.absences ?? [], presentCount);
}

/** More than half of the completed seats, and at least two. */
export function isMajority(supporters: number, completed: number): boolean {
  return supporters >= 2 && supporters * 2 > completed;
}

function synthesizeNoSpecAggregate(
  markdown: string,
  attempts: readonly ConsensusSeat[],
): string | null {
  const completed = attempts.filter((seat) => seat.status === "success");
  const findings = completed.flatMap((seat) => parseSeatFindings(seat.agentName, seat.output));
  if (findings.length === 0) return null;
  const clusters = clusterFindings(findings);
  const blocking = clusters.filter(
    (cluster) =>
      isMajority(cluster.seats.length, completed.length) && HIGH_SEVERITY.has(cluster.severity),
  );
  const consensus = clusters.filter((cluster) =>
    isMajority(cluster.seats.length, completed.length),
  );
  const pending = clusters.filter((cluster) => !isMajority(cluster.seats.length, completed.length));
  const verdict = blocking.length > 0 ? "changes-requested" : "comment";
  const lines: string[] = ["## 结论", "", verdict, ""];
  if (blocking.length === 0) {
    lines.push("无规格依据。没有多数席位一致的高严重度缺陷。单席意见见「待确认」。", "");
  } else {
    for (const cluster of sortClusters(blocking)) {
      lines.push(basisLine(cluster.seats.length, completed.length, cluster.seats));
    }
    lines.push("");
  }
  lines.push(`阻塞 ${blocking.length}。`, "");
  const actionable = consensus.filter((cluster) => !HIGH_SEVERITY.has(cluster.severity));
  lines.push("## 阻塞问题", "");
  if (blocking.length === 0) {
    lines.push("无", "");
  } else {
    for (const cluster of sortClusters(blocking)) {
      lines.push(renderCluster(cluster, completed.length), "");
    }
  }
  lines.push("## 需处理的问题", "");
  if (actionable.length === 0) {
    lines.push("无", "");
  } else {
    for (const cluster of sortClusters(actionable)) {
      lines.push(renderCluster(cluster, completed.length), "");
    }
  }
  lines.push("## 待确认", "");
  if (pending.length === 0) {
    lines.push("无", "");
  } else {
    for (const cluster of sortClusters(pending)) {
      lines.push(renderPending(cluster, cluster.seats.join("、") || "未署名"), "");
    }
  }
  const verdicts = completed
    .map((seat) => ({ name: seat.agentName, verdict: readVerdict(seat.output) }))
    .filter((row): row is { name: string; verdict: string } => row.verdict !== null);
  const distinct = new Set(verdicts.map((row) => row.verdict));
  lines.push("## 分歧", "");
  if (distinct.size <= 1) {
    lines.push("无", "");
  } else {
    for (const row of verdicts) {
      lines.push(`- **${row.name}**：${row.verdict}`);
    }
    lines.push("");
  }
  // Preserve a non-empty overview from the model when it is not just the downgrade.
  const overview = sectionBody(markdown, "概览");
  if (overview && !/建议修订规格|suggest-amend-spec|默认不阻塞/.test(overview)) {
    lines.push("## 概览", "", overview.trim(), "");
  }
  // Keep chapters this rewrite does not own (English Overview / Verdict, …)
  // so a report that already named them is not stripped. Skip the Chinese
  // chapters we just emitted, including a downgraded 结论.
  const replaced = new Set([
    "结论",
    "共识发现",
    "阻塞问题",
    "需处理的问题",
    "建议修订规格",
    "待确认",
    "分歧",
    "概览",
  ]);
  for (const section of splitH2(markdown).sections) {
    if (replaced.has(section.title)) continue;
    const body = section.body.trim();
    if (body.length === 0) continue;
    lines.push(`## ${section.title}`, "", body, "");
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function basisLine(supporters: number, completed: number, seats: readonly string[]): string {
  return `无规格依据，依据是 ${supporters}/${completed} 席一致：${seats.join("、")}`;
}

function renderCluster(cluster: FindingCluster, completed: number): string {
  const high = HIGH_SEVERITY.has(cluster.severity);
  const tag = high ? `[多席一致 ${cluster.seats.length}/${completed}] ` : " ";
  const lines = [`- [${cluster.severity}]${tag}${cluster.title}`];
  if (high) lines.push(`  ${basisLine(cluster.seats.length, completed, cluster.seats)}`);
  if (cluster.detail.trim().length > 0) lines.push(indent(cluster.detail));
  return lines.join("\n");
}

function renderPending(cluster: FindingCluster, seat: string): string {
  const lines = [`- [${cluster.severity}][待确认 · ${seat}] ${cluster.title}`];
  if (cluster.detail.trim().length > 0) lines.push(indent(cluster.detail));
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line : `  ${line.trim()}`))
    .join("\n");
}

function sortClusters(clusters: FindingCluster[]): FindingCluster[] {
  return [...clusters].sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    return a.title.localeCompare(b.title, "zh");
  });
}

function clusterFindings(findings: SeatFinding[]): FindingCluster[] {
  const parent = findings.map((_, index) => index);
  const find = (index: number): number => {
    const next = parent[index] ?? index;
    if (next === index) return index;
    const root = find(next);
    parent[index] = root;
    return root;
  };
  const unite = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[a] = b;
  };
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const left = findings[i];
      const right = findings[j];
      if (!left || !right) continue;
      if (sameDefect(left.tokens, right.tokens)) unite(i, j);
    }
  }
  const groups = new Map<number, SeatFinding[]>();
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    if (!finding) continue;
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(finding);
    groups.set(root, list);
  }
  const clusters: FindingCluster[] = [];
  for (const group of groups.values()) {
    const seats: string[] = [];
    for (const finding of group) {
      if (!seats.includes(finding.seat)) seats.push(finding.seat);
    }
    const strongest = [...group].sort((a, b) => {
      const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rank !== 0) return rank;
      return b.title.length - a.title.length;
    })[0];
    if (!strongest) continue;
    clusters.push({
      findings: group,
      seats,
      severity: strongest.severity,
      title: strongest.title,
      detail: detailLines(strongest.body),
    });
  }
  return clusters;
}

function detailLines(body: string): string {
  const kept = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^\[(?:suggest-amend-spec|act-on)\]/i.test(line))
    .filter((line) => !/无规格依据/.test(line))
    .slice(0, 6);
  return kept.join("\n");
}

export function sameDefect(left: Set<string>, right: Set<string>): boolean {
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  if (shared < 2) return false;
  const coefficient = shared / Math.min(left.size, right.size);
  return coefficient >= 0.34;
}

const FIELD_LABEL_RE = /^\s*(?:触发与后果|触发|后果|建议|证据|不变量|反例|验证)\s*[:：]\s*/;

export function defectTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  // Location lines and field labels are template boilerplate. A shared file
  // stem or the label 「触发与后果」 must not glue two different defects.
  const cleaned = text
    .split("\n")
    .filter((line) => !/^\s*位置\s*[:：]/.test(line))
    .map((line) => line.replace(FIELD_LABEL_RE, ""))
    .join("\n");
  const lower = cleaned.toLowerCase();
  for (const match of lower.matchAll(/\b[a-z][a-z0-9_]{2,}\b/g)) {
    const word = match[0];
    if (!word || TOKEN_STOP.has(word)) continue;
    tokens.add(word);
  }
  for (const match of lower.matchAll(/[a-z]\s*[+\-*/]\s*[a-z]/g)) {
    const expr = match[0]?.replace(/\s+/g, "");
    if (expr) tokens.add(expr);
  }
  for (const match of cleaned.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0];
    if (!run || TOKEN_STOP.has(run)) continue;
    for (let i = 0; i < run.length - 1; i++) {
      const gram = run.slice(i, i + 2);
      if (TOKEN_STOP.has(gram)) continue;
      tokens.add(gram);
    }
  }
  return tokens;
}

function parseSeatFindings(seat: string, output: string): SeatFinding[] {
  const scoped = sectionBody(output, "发现") ?? sectionBody(output, "findings") ?? output;
  const items = splitTopLevelItems(scoped);
  const findings: SeatFinding[] = [];
  for (const item of items) {
    const first = item.split("\n")[0] ?? item;
    const match = /^- \[(critical|major|minor|nit)\](?:\[[^\]]*\])*\s*(.*)$/i.exec(first.trim());
    if (!match?.[1]) continue;
    const severity = match[1].toLowerCase() as Severity;
    const title = (match[2] ?? "").trim();
    if (title.length === 0) continue;
    const body = item.split("\n").slice(1).join("\n");
    const tokens = defectTokens(`${title}\n${body}`);
    findings.push({ seat, severity, title, body, tokens });
  }
  return findings;
}

function splitTopLevelItems(body: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  for (const line of body.split("\n")) {
    if (/^- \S/.test(line) && !line.startsWith("  ")) {
      if (current.length > 0) items.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current.length > 0) current.push(line);
  }
  if (current.length > 0) items.push(current.join("\n"));
  return items;
}

function readVerdict(output: string): string | null {
  const body = sectionBody(output, "结论");
  if (body === null) return null;
  for (const line of body.split("\n")) {
    const token = line.trim().toLowerCase();
    if (token === "approve" || token === "changes-requested" || token === "comment") return token;
  }
  return null;
}

interface H2Section {
  title: string;
  body: string;
}

const DESIGNER_FINDING_TITLES = new Set([
  "共识发现",
  "独有发现",
  "建议修订规格",
  "阻塞问题",
  "需处理的问题",
  "待确认",
  "consensus findings",
  "unique findings",
]);

/**
 * 结论, then 阻塞问题, then 需处理的问题, then 待确认. Other chapters follow.
 * The per-seat appendix is appended by the report renderer and stays last.
 */
export function applyDesignerOrder(
  markdown: string,
  specBound: boolean,
  absences: readonly ReportAbsence[],
  presentCount = 0,
): string {
  const split = splitH2(markdown);
  const buckets: Record<"blocking" | "actionable" | "pending", string[]> = {
    blocking: [],
    actionable: [],
    pending: [],
  };
  const rest: H2Section[] = [];
  let conclusion: H2Section | null = null;
  for (const section of split.sections) {
    if (section.title === "结论") {
      if (!conclusion) conclusion = section;
      continue;
    }
    if (!DESIGNER_FINDING_TITLES.has(section.title)) {
      rest.push(section);
      continue;
    }
    const items = splitTopLevelItems(section.body).filter((item) => item.trim().length > 0);
    const tagged = items.filter((item) => /\[[^\]]+\]/.test(item.split("\n")[0] ?? ""));
    const plain = items.filter((item) => !tagged.includes(item));
    for (const item of tagged) {
      buckets[classifyDesignerItem(item, section.title, specBound)].push(item.trim());
    }
    if (plain.length > 0) {
      rest.push({ title: section.title, body: plain.join("\n") });
    } else if (
      tagged.length === 0 &&
      section.body.trim().length > 0 &&
      section.body.trim() !== "无"
    ) {
      rest.push(section);
    }
  }
  const withAbsences = injectAbsences(conclusion?.body ?? "", absences, presentCount);
  const ordered: H2Section[] = [
    { title: "结论", body: withAbsences },
    { title: "阻塞问题", body: buckets.blocking.join("\n\n") || "无" },
    { title: "需处理的问题", body: buckets.actionable.join("\n\n") || "无" },
    { title: "待确认", body: buckets.pending.join("\n\n") || "无" },
    ...rest,
  ];
  const body = ordered
    .map((section) => `## ${section.title}\n\n${section.body.trim()}`)
    .join("\n\n");
  const lead = split.lead.trim();
  const draft = [lead, body]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
  return refreshBlockingCount(draft);
}

function classifyDesignerItem(
  item: string,
  section: string,
  specBound: boolean,
): "blocking" | "actionable" | "pending" {
  if (section === "待确认" || /\[待确认\s*·/.test(item)) return "pending";
  if (section === "建议修订规格" || /suggest-amend-spec/i.test(item)) return "actionable";
  const severity = /\b(critical|major|minor|nit)\b/i
    .exec(item.split("\n")[0] ?? "")?.[1]
    ?.toLowerCase();
  const high = severity === "critical" || severity === "major";
  if (!high) return "actionable";
  if (section === "需处理的问题") return "actionable";
  if (specBound) return "blocking";
  if (section === "阻塞问题" || /多席一致/.test(item)) return "blocking";
  return "actionable";
}

function injectAbsences(
  body: string,
  absences: readonly ReportAbsence[],
  presentCount: number,
): string {
  const cleaned = body
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("缺席：") && !trimmed.startsWith("这份报告只汇总了其余");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (absences.length === 0) return cleaned;
  const block = [...absences.map(formatAbsence), formatAbsenceNote(presentCount)].join("\n");
  if (/阻塞\s*\d+/.test(cleaned)) {
    return cleaned.replace(/阻塞\s*\d+。?/, `${block}\n\n$&`).trim();
  }
  return `${cleaned}\n\n${block}`.trim();
}

function refreshBlockingCount(markdown: string): string {
  const split = splitH2(markdown);
  const conclusion = split.sections.find((section) => section.title === "结论");
  if (!conclusion) return markdown;
  if (!conclusion.body.trim()) return markdown;
  const count = summarizeSeatOutput(markdown).blockingCount ?? 0;
  const next = /阻塞\s*\d+/.test(conclusion.body)
    ? conclusion.body.replace(/阻塞\s*\d+。?/, `阻塞 ${count}。`)
    : `${conclusion.body.trim()}\n\n阻塞 ${count}。`;
  if (next === conclusion.body) return markdown;
  const sections = split.sections.map((section) =>
    section.title === "结论" && section === conclusion
      ? { title: section.title, body: next }
      : section,
  );
  const body = sections
    .map((section) => `## ${section.title}\n\n${section.body.trim()}`)
    .join("\n\n");
  const lead = split.lead.trim();
  return [lead, body]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}

export function promoteConclusion(markdown: string): string {
  const split = splitH2(markdown);
  const index = split.sections.findIndex((section) => section.title === "结论");
  if (index < 0) return markdown;
  const conclusion = split.sections[index];
  if (!conclusion) return markdown;
  const rest = split.sections.filter((_, sectionIndex) => sectionIndex !== index);
  const ordered = [ensureBlockingCount(conclusion, rest), ...rest.map(sortSectionFindings)];
  const body = ordered
    .map((section) => `## ${section.title}\n\n${section.body.trim()}`)
    .join("\n\n");
  const lead = split.lead.trim();
  return [lead, body]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}

function ensureBlockingCount(conclusion: H2Section, rest: readonly H2Section[]): H2Section {
  if (/阻塞\s*\d+/.test(conclusion.body)) return conclusion;
  const probe = [
    "## 结论",
    conclusion.body,
    ...rest.map((section) => `## ${section.title}\n${section.body}`),
  ].join("\n");
  const count = summarizeSeatOutput(probe).blockingCount ?? 0;
  const body = `${conclusion.body.trim()}\n\n阻塞 ${count}。`.trim();
  return { title: conclusion.title, body };
}

function sortSectionFindings(section: H2Section): H2Section {
  if (!/^(?:共识发现|独有发现|建议修订规格|待确认)$/.test(section.title)) return section;
  const items = splitTopLevelItems(section.body);
  if (items.length < 2) return section;
  const ranked = items.map((item) => ({ item, rank: severityRank(item) }));
  if (ranked.every((row) => row.rank === 99)) return section;
  ranked.sort((a, b) => a.rank - b.rank);
  return { title: section.title, body: ranked.map((row) => row.item.trim()).join("\n") };
}

function severityRank(item: string): number {
  const match = /\[(critical|major|minor|nit)\]/i.exec(item);
  const severity = match?.[1]?.toLowerCase() as Severity | undefined;
  if (!severity || !(severity in SEVERITY_RANK)) return 99;
  return SEVERITY_RANK[severity];
}

function annotateSpecViolations(markdown: string, specText: string | undefined): string {
  const split = splitH2(markdown);
  const sections = split.sections.map((section) => {
    if (!/^(?:共识发现|独有发现|阻塞问题|需处理的问题)$/.test(section.title)) return section;
    const items = splitTopLevelItems(section.body);
    if (items.length === 0) return section;
    const next = items.map((item) => annotateSpecItem(item, specText));
    return { title: section.title, body: next.join("\n") };
  });
  const body = sections
    .map((section) => `## ${section.title}\n\n${section.body.trim()}`)
    .join("\n\n");
  const lead = split.lead.trim();
  return [lead, body]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}

function annotateSpecItem(item: string, specText: string | undefined): string {
  if (!/\[act-on\]/i.test(item)) return stripReportJargon(item);
  if (/suggest-amend-spec/i.test(item)) return stripReportJargon(item);
  const labeled = /(?:不变量|不变式|invariant)\s*[:：]\s*`?([A-Za-z][A-Za-z0-9_-]{0,40})`?/i.exec(
    item,
  );
  const tagged = /违反规格\s*·\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(item);
  const acceptanceId = labeled?.[1]?.trim() || tagged?.[1]?.trim();
  if (!acceptanceId) return stripReportJargon(item);
  const acceptance = specText ? acceptanceTextForId(specText, acceptanceId) : null;
  const basis = acceptance ? `违反了规格里的 ${acceptanceId}：${acceptance}` : null;
  const existingBasis = item
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("违反了规格里的"));
  const lines = item.split("\n").filter((line) => {
    if (basis && /^\s*(?:不变量|不变式|invariant)\s*[:：]/i.test(line)) return false;
    if (/违反了规格里的/.test(line)) return false;
    return true;
  });
  const label = `违反规格 · ${acceptanceId}`;
  if (!lines.some((line) => line.includes(label))) lines.splice(1, 0, `  ${label}`);
  const keptBasis = basis ?? existingBasis ?? null;
  if (keptBasis) lines.splice(1, 0, `  ${keptBasis.replace(/^\s+/, "")}`);
  return stripReportJargon(lines.join("\n"));
}

/** The acceptance sentence that follows an id in the bound spec. */
export function acceptanceTextForId(specText: string, id: string): string | null {
  for (const raw of specText.split(/\r?\n/)) {
    const line = raw.trim();
    if (findId(line, id) < 0) continue;
    if (line.includes("|")) {
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
      const index = cells.findIndex((cell) => findId(cell, id) >= 0);
      const next = cells
        .slice(index + 1)
        .find((cell) => cell.length > 0 && !/^:?-{3,}:?$/.test(cell));
      if (next) return cleanAcceptance(next);
    }
    const withoutMarks = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*]\s+\[[ xX]\]\s+/, "")
      .replace(/^[-*]\s+/, "");
    const start = findId(withoutMarks, id);
    if (start < 0) continue;
    const rest = withoutMarks
      .slice(start + id.length)
      .replace(/^[\s：:.\-·—|]+/, "")
      .trim();
    if (rest.length > 0) return cleanAcceptance(rest);
  }
  return null;
}

function findId(line: string, id: string): number {
  let from = 0;
  while (from < line.length) {
    const at = line.indexOf(id, from);
    if (at < 0) return -1;
    const before = at === 0 ? "" : (line[at - 1] ?? "");
    const after = line[at + id.length] ?? "";
    if (!/[\w-]/.test(before) && !/[\w-]/.test(after)) return at;
    from = at + id.length;
  }
  return -1;
}

function cleanAcceptance(text: string): string {
  return text
    .replace(/[`*_]/g, "")
    .replace(/[。．.]\s*$/, "")
    .trim();
}

function stripReportJargon(text: string): string {
  return text
    .replace(/规格合同减法/g, "对照规格")
    .replace(/合同内\s*Act On/gi, "违反规格")
    .replace(/不变量\s*ID/g, "验收编号");
}

function splitH2(markdown: string): { lead: string; sections: H2Section[] } {
  const sections: H2Section[] = [];
  const lead: string[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const { line, fenced } of markdownLines(markdown)) {
    const heading = fenced ? null : /^## ([^#].*)$/.exec(line);
    if (heading?.[1]) {
      if (current) sections.push({ title: current.title, body: current.lines.join("\n") });
      current = { title: heading[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else lead.push(line);
  }
  if (current) sections.push({ title: current.title, body: current.lines.join("\n") });
  return { lead: lead.join("\n"), sections };
}

function sectionBody(markdown: string, title: string): string | null {
  const split = splitH2(markdown);
  const found = split.sections.find(
    (section) => section.title.toLowerCase() === title.toLowerCase(),
  );
  return found ? found.body : null;
}

/** True when this aggregate was rewritten by the no-spec majority rule. */
export function isNoSpecShapedReport(markdown: string): boolean {
  const conclusion = sectionBody(markdown, "结论");
  if (conclusion === null) return false;
  return conclusion.includes("无规格依据");
}
