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
  if (trimmed.length <= LIVE_SUMMARY_MAX) return trimmed;
  // Host zod `.max(240)` counts UTF-16 code units (JS string.length), not code points.
  let end = LIVE_SUMMARY_MAX;
  const unit = trimmed.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  return trimmed.slice(0, end);
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
