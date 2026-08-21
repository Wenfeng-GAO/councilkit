/**
 * Sidecar live-transcript events for an Autonomous Run attempt.
 * Written by the CLI under runs/<runId>/live/<attemptId>.jsonl; the Host only
 * reads them. Bad lines are skipped — never thrown on.
 */

export const LIVE_SUMMARY_MAX = 240;

/** Closed attemptId token used as a sidecar filename. */
export const CLI_RUN_ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type AttemptLiveEventPayload =
  | { type: "text.delta"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "tool.started"; name: string; summary: string }
  | { type: "tool.completed"; name: string; summary: string }
  | { type: "truncated"; dropped: number };

export type AttemptLiveEvent = AttemptLiveEventPayload & {
  seq: number;
  at: string;
};

export function clipLiveSummary(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const chars = Array.from(trimmed);
  return chars.length > LIVE_SUMMARY_MAX ? chars.slice(0, LIVE_SUMMARY_MAX).join("") : trimmed;
}

export function parseAttemptLiveEventLine(line: string): AttemptLiveEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let rec: unknown;
  try {
    rec = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (rec === null || typeof rec !== "object") return null;
  const row = rec as Record<string, unknown>;
  if (typeof row.seq !== "number" || !Number.isInteger(row.seq) || row.seq < 0) return null;
  if (typeof row.at !== "string" || row.at.length === 0) return null;
  const type = row.type;
  if (type === "text.delta" || type === "thinking.delta") {
    if (typeof row.text !== "string") return null;
    return { seq: row.seq, at: row.at, type, text: row.text };
  }
  if (type === "tool.started" || type === "tool.completed") {
    if (typeof row.name !== "string" || row.name.length === 0) return null;
    if (typeof row.summary !== "string") return null;
    return {
      seq: row.seq,
      at: row.at,
      type,
      name: row.name,
      summary: clipLiveSummary(row.summary),
    };
  }
  if (type === "truncated") {
    if (typeof row.dropped !== "number" || !Number.isInteger(row.dropped) || row.dropped < 0) {
      return null;
    }
    return { seq: row.seq, at: row.at, type, dropped: row.dropped };
  }
  return null;
}
