/**
 * Parse the deterministic Autonomous Review Report markdown that
 * `councilkit review` writes. Returns null when the document is not that
 * format so the page can fall back to plain document rendering.
 */

export interface ReviewAttemptRow {
  name: string;
  driver: string;
  result: string;
  duration: string;
  tools: string;
}

export interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "nit" | null;
  qualifier: string | null;
  text: string;
}

export interface ReviewSection {
  id: string;
  title: string;
  body: string;
  findings: ReviewFinding[] | null;
}

export interface ParsedReviewReport {
  title: string;
  meta: Record<string, string>;
  attempts: ReviewAttemptRow[];
  preface: string;
  sections: ReviewSection[];
  verdict: "approve" | "changes-requested" | "comment" | null;
}

const SEVERITIES = new Set(["critical", "major", "minor", "nit"]);

export function parseReviewReport(markdown: string): ParsedReviewReport | null {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!/^# Autonomous Review Report\s*$/m.test(text)) return null;

  const dash = text.search(/\n---\n/);
  const header = dash >= 0 ? text.slice(0, dash) : text;
  const rest = dash >= 0 ? text.slice(dash + 5) : "";

  const meta: Record<string, string> = {};
  const leftover: string[] = [];
  for (const line of header.split("\n")) {
    if (line === "# Autonomous Review Report" || line.trim() === "") continue;
    const field = /^- ([A-Za-z][A-Za-z ]*): (.+)$/.exec(line);
    if (field) {
      meta[field[1]] = field[2];
      continue;
    }
    if (line.startsWith("|")) continue;
    leftover.push(line);
  }

  const attempts = parseAttemptsTable(header);
  const sections = splitH2Sections(rest);
  const preface = leftover.join("\n").trim();
  const conclusion = sections.find((section) => section.title === "结论");
  const verdict = extractVerdict(conclusion?.body ?? "");

  return { title: "Autonomous Review Report", meta, attempts, preface, sections, verdict };
}

export function splitH3Blocks(markdown: string): Array<{ title: string; body: string }> {
  const lines = markdown.split("\n");
  const blocks: Array<{ title: string; body: string }> = [];
  let current: { title: string; lines: string[] } | null = null;
  const preface: string[] = [];
  for (const line of lines) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      if (current) blocks.push({ title: current.title, body: current.lines.join("\n").trim() });
      current = { title: heading[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else if (line.trim().length > 0) preface.push(line);
  }
  if (current) blocks.push({ title: current.title, body: current.lines.join("\n").trim() });
  if (preface.length > 0) blocks.unshift({ title: "", body: preface.join("\n").trim() });
  return blocks.filter((block) => block.body.length > 0 || block.title.length > 0);
}

export function splitH2Sections(markdown: string): ReviewSection[] {
  const lines = markdown.split("\n");
  const sections: ReviewSection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      if (current) sections.push(toSection(current.title, current.lines.join("\n")));
      current = { title: heading[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(toSection(current.title, current.lines.join("\n")));
  return sections;
}

function toSection(title: string, raw: string): ReviewSection {
  const body = raw.replace(/^\n+/, "").replace(/\n+$/, "");
  return {
    id: slugify(title),
    title,
    body,
    findings: parseFindings(body),
  };
}

export function parseFindings(body: string): ReviewFinding[] | null {
  const items = splitTopLevelList(body);
  if (items === null) return null;
  return items.map(parseFinding);
}

function parseFinding(item: string): ReviewFinding {
  const restLines = item.split("\n").slice(1).join("\n").trim();
  const first = unwrapEmphasis((item.split("\n")[0] ?? item).replace(/^- /, "").trim());
  const severityMatch =
    /\[((?:critical|major|minor|nit)(?:[\/，,][^\]]+)?)\](?:\[([^\]]+)\])?/i.exec(first);
  if (severityMatch && severityMatch.index !== undefined) {
    const [severityRaw, inlineQualifier] = severityMatch[1].split(/[\/，,]/, 2);
    const before = first
      .slice(0, severityMatch.index)
      .replace(/[：:\s]+$/u, "")
      .trim();
    const after = first
      .slice(severityMatch.index + severityMatch[0].length)
      .replace(/^[：:\s]+/u, "")
      .trim();
    const head = before.length > 0 && after.length > 0 ? `${before} — ${after}` : before || after;
    return {
      severity: severityRaw.toLowerCase() as NonNullable<ReviewFinding["severity"]>,
      qualifier: severityMatch[2] ?? inlineQualifier ?? null,
      text: [head, restLines].filter((part) => part.length > 0).join("\n"),
    };
  }
  const tagged = /^\[([^\]]+)\](?:\[([^\]]+)\])?\s+([\s\S]*)$/.exec(first);
  if (!tagged)
    return {
      severity: null,
      qualifier: null,
      text: [first, restLines].filter((part) => part.length > 0).join("\n"),
    };
  return {
    severity: null,
    qualifier: tagged[2] ? `${tagged[1]}][${tagged[2]}` : tagged[1],
    text: [tagged[3].trim(), restLines].filter((part) => part.length > 0).join("\n"),
  };
}

function unwrapEmphasis(text: string): string {
  return text.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
}

function splitTopLevelList(body: string): string[] | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("- ")) return null;
  const items: string[] = [];
  let current: string[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("- ")) {
      if (current.length > 0) items.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current.length === 0) return null;
    current.push(line);
  }
  if (current.length > 0) items.push(current.join("\n"));
  return items.length > 0 ? items : null;
}

function parseAttemptsTable(header: string): ReviewAttemptRow[] {
  const rows: ReviewAttemptRow[] = [];
  for (const line of header.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (line.includes("Attempt |") || /^\|\s*-{3,}/.test(line)) continue;
    const cells = splitTableRow(line);
    if (cells.length < 5) continue;
    rows.push({
      name: cells[0],
      driver: cells[1],
      result: cells[2],
      duration: cells[3],
      tools: cells[4],
    });
  }
  return rows;
}

function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of inner) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function extractVerdict(body: string): ParsedReviewReport["verdict"] {
  const match = /\b(approve|changes-requested|comment)\b/.exec(body);
  if (match?.[1] === "approve" || match?.[1] === "changes-requested" || match?.[1] === "comment") {
    return match[1];
  }
  return null;
}

function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length > 0 ? ascii : "section";
}
