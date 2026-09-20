/** Compact, poll-safe summary of one attempt's final output. */

export const SEAT_RESULT_SUMMARY_MAX = 240;

export type CliRunAttemptParseStatus = "parsed" | "unparsed" | "empty";

export interface CliRunAttemptResult {
  parseStatus: CliRunAttemptParseStatus;
  summary: string | null;
  findingCount: number | null;
  blockingCount: number | null;
}

const SEVERITY_RE = /\[(critical|major|minor|nit)\]/gi;
const REVIEW_HEADING_RE = /^## (?:概览|发现|共识发现|独有发现|分歧|结论|问题)\s*$/m;

export function summarizeSeatOutput(output: string | null | undefined): CliRunAttemptResult {
  const text = output?.trim() ?? "";
  if (text.length === 0) {
    return { parseStatus: "empty", summary: null, findingCount: null, blockingCount: null };
  }
  const matches = [...text.matchAll(SEVERITY_RE)];
  const findingCount = matches.length;
  const blockingCount = matches.filter((row) => {
    const severity = row[1]?.toLowerCase();
    return severity === "critical" || severity === "major";
  }).length;
  const structured = findingCount > 0 || REVIEW_HEADING_RE.test(text);
  const summary = clipSeatSummary(extractOverview(text) ?? firstParagraph(text));
  if (structured) {
    return { parseStatus: "parsed", summary, findingCount, blockingCount };
  }
  return { parseStatus: "unparsed", summary, findingCount: null, blockingCount: null };
}

export function clipSeatSummary(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const chars = Array.from(trimmed);
  return chars.length > SEAT_RESULT_SUMMARY_MAX
    ? chars.slice(0, SEAT_RESULT_SUMMARY_MAX).join("")
    : trimmed;
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
