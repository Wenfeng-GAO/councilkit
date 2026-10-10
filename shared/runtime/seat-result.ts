/** Compact, poll-safe summary of one attempt's final output. */
import { markdownLines } from "./aggregator-verdict";

export const SEAT_RESULT_SUMMARY_MAX = 240;

export type CliRunAttemptParseStatus = "parsed" | "unparsed" | "empty";

export interface CliRunAttemptResult {
  parseStatus: CliRunAttemptParseStatus;
  summary: string | null;
  findingCount: number | null;
  blockingCount: number | null;
}

const SEVERITY_RE = /\[(critical|major|minor|nit)\]/gi;
const REVIEW_HEADING_RE = /^## (?:概览|发现|共识发现|建议修订规格|独有发现|分歧|结论|问题)\s*$/m;

export function summarizeSeatOutput(output: string | null | undefined): CliRunAttemptResult {
  const text = output?.trim() ?? "";
  if (text.length === 0) {
    return { parseStatus: "empty", summary: null, findingCount: null, blockingCount: null };
  }
  const visible = textOutsideFences(text);
  const matches = [...visible.matchAll(SEVERITY_RE)];
  const findingCount = matches.length;
  const blockingCount = matches.filter((row, index) => {
    const severity = row[1]?.toLowerCase();
    if (severity !== "critical" && severity !== "major") return false;
    // Scope out-of-spec markers to this finding only (stop at the next severity tag).
    const start = row.index ?? 0;
    const end =
      index + 1 < matches.length ? (matches[index + 1]!.index ?? visible.length) : visible.length;
    const around = visible.slice(start, end).toLowerCase();
    // Out-of-spec / suggest-amend-spec majors are non-blocking by default.
    if (
      around.includes("suggest-amend-spec") ||
      around.includes("out-of-spec") ||
      around.includes("规格外")
    ) {
      return false;
    }
    return true;
  }).length;
  const structured = findingCount > 0 || REVIEW_HEADING_RE.test(visible);
  const summary = clipSeatSummary(extractOverview(visible) ?? firstParagraph(visible));
  if (structured) {
    return { parseStatus: "parsed", summary, findingCount, blockingCount };
  }
  return { parseStatus: "unparsed", summary, findingCount: null, blockingCount: null };
}

export function clipUtf16CodeUnits(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const unit = value.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function clipSeatSummary(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return clipUtf16CodeUnits(trimmed, SEAT_RESULT_SUMMARY_MAX);
}

function textOutsideFences(text: string): string {
  const lines: string[] = [];
  for (const row of markdownLines(text)) {
    if (!row.fenced) lines.push(row.line);
  }
  return lines.join("\n");
}

function extractOverview(text: string): string | null {
  const lines = text.split("\n");
  const body: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (capturing) break;
      capturing = /^## 概览\s*$/.test(line);
      continue;
    }
    if (capturing) body.push(line);
  }
  return capturing ? firstParagraph(body.join("\n")) : null;
}

function firstParagraph(text: string): string | null {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      if (lines.length > 0) break;
      continue;
    }
    if (trimmed.length === 0) {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(trimmed);
  }
  return lines.length > 0 ? lines.join(" ") : null;
}
