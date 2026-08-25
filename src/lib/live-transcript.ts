import type { AttemptLiveEvent } from "@shared/runtime/attempt-live-events";

export type TimelineBlock =
  | { kind: "text"; text: string; at: string }
  | { kind: "thinking"; text: string; at: string }
  | {
      kind: "tool";
      name: string;
      summary: string;
      status: "started" | "completed";
      at: string;
      endAt?: string;
    }
  | { kind: "truncated"; dropped: number; at: string };

export interface SilentToolTally {
  name: string;
  count: number;
}

const PATH_TOOL_NAMES = new Set(["read", "readfile", "glob", "listdir", "searchfiles"]);

/** Fold deltas and pair tool.started with the matching tool.completed. */
export function foldLiveEvents(events: readonly AttemptLiveEvent[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  for (const event of events) {
    const last = blocks[blocks.length - 1];
    if (event.type === "text.delta") {
      if (last?.kind === "text") last.text += event.text;
      else blocks.push({ kind: "text", text: event.text, at: event.at });
    } else if (event.type === "thinking.delta") {
      if (last?.kind === "thinking") last.text += event.text;
      else blocks.push({ kind: "thinking", text: event.text, at: event.at });
    } else if (event.type === "tool.started") {
      blocks.push({
        kind: "tool",
        name: event.name,
        summary: event.summary,
        status: "started",
        at: event.at,
      });
    } else if (event.type === "tool.completed") {
      const open = findOpenTool(blocks, event.name);
      const fallback = isGenericToolName(event.name)
        ? findGenericCompletionTarget(blocks, event.summary)
        : -1;
      const idx = open >= 0 ? open : fallback;
      if (idx >= 0) {
        const prev = blocks[idx];
        if (prev?.kind === "tool") {
          blocks[idx] = {
            kind: "tool",
            name: isGenericToolName(event.name) ? prev.name : event.name,
            summary: event.summary.length > 0 ? event.summary : prev.summary,
            status: "completed",
            at: prev.at,
            endAt: event.at,
          };
        }
      } else {
        blocks.push({
          kind: "tool",
          name: event.name,
          summary: event.summary,
          status: "completed",
          at: event.at,
        });
      }
    } else if (event.type === "truncated") {
      blocks.push({ kind: "truncated", dropped: event.dropped, at: event.at });
    }
  }
  return blocks;
}

/**
 * Tools with no path/command don't earn a timeline row. Count them for a
 * header strip so 27 empty Reads don't bury the actual commands.
 */
export function silentToolTally(blocks: readonly TimelineBlock[]): {
  tally: SilentToolTally[];
  timeline: TimelineBlock[];
} {
  const counts = new Map<string, number>();
  const timeline: TimelineBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "tool" && block.summary.length === 0) {
      counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
      continue;
    }
    timeline.push(block);
  }
  return {
    tally: [...counts].map(([name, count]) => ({ name, count })),
    timeline,
  };
}

const JURY_HEADING =
  /^(?:# Autonomous Review Report\b|## (?:概览|共识发现|独有发现|分歧|结论)(?:\s|$))/m;

/** Long multi-heading markdown that restates the jury report. */
export function isDeliverableText(text: string): boolean {
  if (JURY_HEADING.test(text) && Array.from(text).length >= 280) return true;
  const headings = text.match(/^#{1,3} .+/gm) ?? [];
  if (headings.length >= 2 && Array.from(text).length >= 800) return true;
  return isJsonDeliverable(text);
}

/** Planner/squad structured JSON that would otherwise flood the inspector. */
export function isJsonDeliverable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 280 || trimmed[0] !== "{" || !trimmed.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    return (
      keys.length >= 3 &&
      (keys.includes("claims") ||
        keys.includes("schema_version") ||
        keys.includes("invariants") ||
        keys.length >= 5)
    );
  } catch {
    return false;
  }
}

function isGenericToolName(name: string): boolean {
  const token = name.trim().toLowerCase();
  return token.length === 0 || token === "tool";
}

function findOpenTool(blocks: readonly TimelineBlock[], name: string): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind === "tool" && block.name === name && block.status === "started") return i;
  }
  return -1;
}

function findLastOpenTool(blocks: readonly TimelineBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind === "tool" && block.status === "started") return i;
  }
  return -1;
}

function looksLikePath(summary: string): boolean {
  const trimmed = summary.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return true;
  }
  return /^[\w./-]+\.\w{1,8}$/.test(trimmed);
}

function findGenericCompletionTarget(blocks: readonly TimelineBlock[], summary: string): number {
  const pathish = looksLikePath(summary);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "tool" || block.status !== "started") continue;
    const name = block.name.toLowerCase();
    if (pathish && isPathTool(block.name)) return i;
    if (
      !pathish &&
      (name === "execute" || name === "shell" || name === "bash" || name === "command_execution")
    ) {
      return i;
    }
  }
  return findLastOpenTool(blocks);
}

/** True when a markdown code fence is still open — keep `<pre>` while streaming. */
export function hasUnmatchedFence(text: string): boolean {
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) count += 1;
  }
  return count % 2 === 1;
}

export function isPathTool(name: string): boolean {
  return PATH_TOOL_NAMES.has(name.toLowerCase().replace(/[-_]/g, ""));
}

const SHELL_WRAPPER = /^(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)\s+-(?:l)?c\s+/i;

/** Drop `zsh -lc "…"` / `zsh -c "…"` wrapping so copied/shown commands are the inner payload. */
export function unwrapShellSummary(summary: string): string {
  const trimmed = summary.trim();
  const match = SHELL_WRAPPER.exec(trimmed);
  if (match === null) return trimmed;
  let inner = trimmed.slice(match[0].length);
  const quote = inner[0];
  if (quote === '"' || quote === "'") {
    if (inner.length >= 2 && inner.endsWith(quote)) inner = inner.slice(1, -1);
    else inner = inner.slice(1);
  }
  const cleaned = inner.trim();
  return cleaned.length > 0 ? cleaned : trimmed;
}

const LAST_ACTIVITY_DISPLAY_MAX = 80;

/** Hide JSON receipt blobs and empty/`tool` placeholders from last-activity lines. */
export function displayLastActivity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = unwrapShellSummary(raw).trim();
  if (!text || text.toLowerCase() === "tool") return null;
  if (/^[{}\[\]:,."'\s]+$/.test(text)) return null;
  if (text.startsWith("{") && looksLikeEnvelopeJson(text)) return null;
  if (text.startsWith("```") || /^#{1,3} /.test(text)) return null;
  const shortened = shortenActivityPath(text);
  const chars = Array.from(shortened);
  if (chars.length <= LAST_ACTIVITY_DISPLAY_MAX) return shortened;
  return `${chars.slice(0, LAST_ACTIVITY_DISPLAY_MAX).join("")}…`;
}

function looksLikeEnvelopeJson(text: string): boolean {
  if (text.includes("schema_version") || text.includes("run_id") || text.includes("receipt_hash")) {
    return true;
  }
  return text.length >= 40 && /"(?:approved_paths|invariants|claims)"/.test(text);
}

export interface LiveEventSpan {
  spanMs: number | null;
  hasTimeline: boolean;
  eventCount: number;
}

/** First-to-last live timestamp span. Single backfilled `at` is not a timeline. */
export function liveEventSpan(events: readonly { at: string }[]): LiveEventSpan {
  const times: number[] = [];
  for (const event of events) {
    const parsed = Date.parse(event.at);
    if (Number.isFinite(parsed)) times.push(parsed);
  }
  if (times.length === 0) return { spanMs: null, hasTimeline: false, eventCount: events.length };
  const min = Math.min(...times);
  const max = Math.max(...times);
  const spanMs = Math.max(0, max - min);
  const hasTimeline = new Set(times).size >= 2 && spanMs >= 1000;
  return { spanMs: hasTimeline ? spanMs : null, hasTimeline, eventCount: events.length };
}

/** Collapse a bare absolute path to the last two segments for seat cards. */
export function shortenActivityPath(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || /[\s;|&]/.test(trimmed)) return trimmed;
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts.length <= 2) return trimmed;
  return parts.slice(-2).join("/");
}

export function displayToolName(name: string): string {
  return name.toLowerCase() === "command_execution" ? "shell" : name;
}

/** Elapsed from the first sidecar event, second resolution. Empty if unparseable. */
export function formatElapsed(originAt: string, at: string): string {
  const start = Date.parse(originAt);
  const then = Date.parse(at);
  if (!Number.isFinite(start) || !Number.isFinite(then) || then < start) return "";
  const total = Math.floor((then - start) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatSpan(startAt: string, endAt: string): string {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";
  const total = Math.floor((end - start) / 1000);
  if (total < 1) return "";
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export function originAt(events: readonly { at: string }[]): string {
  return events[0]?.at ?? "";
}

export function showsTick(block: TimelineBlock, collapseDeliverable: boolean): boolean {
  if (block.kind === "tool") return true;
  if (block.kind === "text" && collapseDeliverable && isDeliverableText(block.text)) return true;
  return false;
}
