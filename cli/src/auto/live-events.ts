/**
 * Incremental driver-stdout → AttemptLiveEvent collector and sidecar writer.
 * Observational only: IO errors are swallowed and never fail a review.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  type AttemptLiveEvent,
  type AttemptLiveEventPayload,
  CLI_RUN_ATTEMPT_ID_RE,
  clipLiveSummary,
  parseAttemptLiveEventLine,
} from "@shared/runtime/attempt-live-events";
import { stripProxyPrefix } from "./driver-commands";

export type RawLiveEvent = Exclude<AttemptLiveEventPayload, { type: "truncated" }>;

const LINE_CAP = 16 * 1024 * 1024;
const DEFAULT_MERGE_WINDOW_MS = 250;
const DEFAULT_MERGE_BYTES = 2 * 1024;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class LiveEventCollector {
  private buf = "";
  private readonly decoder = new StringDecoder("utf8");
  private discarding = false;
  private ended = false;
  /** Kimi: last assistant content is the final deliverable — emit prior frames only. */
  private pendingKimiContent: string | null = null;

  constructor(private readonly driverId: string) {}

  feed(chunk: Buffer): RawLiveEvent[] {
    if (this.ended) return [];
    const out: RawLiveEvent[] = [];
    this.buf += this.decoder.write(chunk);
    let idx = this.buf.indexOf("\n");
    while (idx >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (this.discarding) {
        this.discarding = false;
      } else {
        this.consider(line, out);
      }
      idx = this.buf.indexOf("\n");
    }
    if (this.buf.length > LINE_CAP) {
      this.buf = "";
      this.discarding = true;
    }
    return out;
  }

  end(): RawLiveEvent[] {
    if (this.ended) return [];
    this.ended = true;
    const out: RawLiveEvent[] = [];
    const rest = this.buf + this.decoder.end();
    this.buf = "";
    if (this.discarding) {
      this.discarding = false;
    } else if (rest.length > 0 && rest.length <= LINE_CAP) {
      this.consider(rest, out);
    }
    // Live sidecar is observational: flush the last kimi frame so the inspector
    // can show the deliverable. extractFinalOutput still reads stdout itself.
    if (this.pendingKimiContent !== null) {
      out.push({ type: "text.delta", text: this.pendingKimiContent });
      this.pendingKimiContent = null;
    }
    return out;
  }

  private consider(line: string, out: RawLiveEvent[]): void {
    const obj = parseJsonLine(line);
    if (obj === null) return;
    switch (this.driverId) {
      case "claude-stream-json":
      // grok review/apply/fix streams the same Anthropic-wire frames
      // (streaming-messages-json), so it shares the claude parser.
      case "grok-stream-json":
        this.considerClaude(obj, out);
        return;
      case "kimi-stream-json":
        this.considerKimi(obj, out);
        return;
      case "codex-app-server":
        this.considerCodex(obj, out);
        return;
      default:
        return;
    }
  }

  private considerClaude(obj: Record<string, unknown>, out: RawLiveEvent[]): void {
    if (obj.type === "stream_event") {
      const event = asRecord(obj.event);
      if (event === null || event.type !== "content_block_delta") return;
      const delta = asRecord(event.delta);
      if (delta === null) return;
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        out.push({ type: "text.delta", text: delta.text });
      } else if (delta.type === "thinking_delta") {
        const text =
          typeof delta.thinking === "string"
            ? delta.thinking
            : typeof delta.text === "string"
              ? delta.text
              : "";
        if (text.length > 0) out.push({ type: "thinking.delta", text });
      }
      return;
    }
    if (obj.type !== "assistant") return;
    const message = asRecord(obj.message);
    if (message === null || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      const b = asRecord(block);
      if (b === null || b.type !== "tool_use") continue;
      const name = typeof b.name === "string" && b.name.length > 0 ? b.name : "tool";
      out.push({ type: "tool.completed", name, summary: pickToolSummary(asRecord(b.input)) });
    }
  }

  private considerKimi(obj: Record<string, unknown>, out: RawLiveEvent[]): void {
    if (obj.role !== "assistant") return;
    if (this.pendingKimiContent !== null) {
      out.push({ type: "text.delta", text: this.pendingKimiContent });
      this.pendingKimiContent = null;
    }
    const content = asText(obj.content);
    if (content !== null) this.pendingKimiContent = content;
    if (!Array.isArray(obj.tool_calls)) return;
    for (const call of obj.tool_calls) {
      const c = asRecord(call);
      if (c === null) continue;
      const fn = asRecord(c.function);
      const name =
        (typeof c.name === "string" && c.name.length > 0 ? c.name : null) ??
        (fn !== null && typeof fn.name === "string" && fn.name.length > 0 ? fn.name : null) ??
        "tool";
      let summary = pickToolSummary(asRecord(c.args));
      if (summary.length === 0 && fn !== null && typeof fn.arguments === "string") {
        summary = pickToolSummary(parseJsonLine(fn.arguments));
      }
      out.push({ type: "tool.completed", name, summary });
    }
  }

  private considerCodex(obj: Record<string, unknown>, out: RawLiveEvent[]): void {
    if (typeof obj.type !== "string" || !obj.type.startsWith("item.")) return;
    const item = asRecord(obj.item);
    if (item === null) return;
    const itemType = typeof item.type === "string" ? item.type : "";
    const isTool =
      itemType === "command_execution" || itemType === "mcp_tool_call" || itemType === "web_search";
    if (obj.type === "item.started") {
      if (!isTool) return;
      out.push({
        type: "tool.started",
        name: toolName(item, itemType),
        summary: pickToolSummary(item),
      });
      return;
    }
    if (obj.type !== "item.completed") return;
    if (isTool) {
      out.push({
        type: "tool.completed",
        name: toolName(item, itemType),
        summary: pickToolSummary(item),
      });
      return;
    }
    if (itemType === "reasoning") {
      const text = asText(item.text);
      if (text !== null) out.push({ type: "thinking.delta", text });
      return;
    }
    if (itemType === "agent_message") {
      const text = asText(item.text);
      if (text !== null) out.push({ type: "text.delta", text });
    }
  }
}

export interface LiveEventWriterOptions {
  mergeWindowMs?: number;
  mergeBytes?: number;
  maxBytes?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface AttemptWriteState {
  nextSeq: number;
  bytes: number;
  dropped: number;
  truncatedWritten: boolean;
  pending: { type: "text.delta" | "thinking.delta"; text: string } | null;
  timer: unknown;
}

export class LiveEventWriter {
  private readonly mergeWindowMs: number;
  private readonly mergeBytes: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly states = new Map<string, AttemptWriteState>();
  private dirReady = false;

  constructor(
    private readonly runDir: string,
    opts: LiveEventWriterOptions = {},
  ) {
    this.mergeWindowMs = opts.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;
    this.mergeBytes = opts.mergeBytes ?? DEFAULT_MERGE_BYTES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  append(attemptId: string, events: readonly RawLiveEvent[]): void {
    try {
      if (!CLI_RUN_ATTEMPT_ID_RE.test(attemptId)) return;
      const state = this.state(attemptId);
      for (const event of events) {
        if (event.type === "text.delta" || event.type === "thinking.delta") {
          if (state.truncatedWritten) {
            state.dropped++;
            continue;
          }
          if (state.pending !== null && state.pending.type === event.type) {
            state.pending.text += event.text;
          } else {
            this.flushPending(attemptId);
            state.pending = { type: event.type, text: event.text };
            this.armTimer(attemptId);
          }
          if (Buffer.byteLength(state.pending?.text ?? "", "utf8") >= this.mergeBytes) {
            this.flushPending(attemptId);
          }
        } else {
          this.flushPending(attemptId);
          this.writePayload(attemptId, event);
        }
      }
    } catch {
      // sidecar must never fail the review
    }
  }

  flush(attemptId?: string): void {
    try {
      if (attemptId !== undefined) {
        this.flushPending(attemptId);
        return;
      }
      for (const id of this.states.keys()) this.flushPending(id);
    } catch {
      // sidecar must never fail the review
    }
  }

  private state(attemptId: string): AttemptWriteState {
    const existing = this.states.get(attemptId);
    if (existing !== undefined) return existing;
    const created: AttemptWriteState = {
      nextSeq: 1,
      bytes: 0,
      dropped: 0,
      truncatedWritten: false,
      pending: null,
      timer: undefined,
    };
    this.hydrateFromDisk(attemptId, created);
    this.states.set(attemptId, created);
    return created;
  }

  private hydrateFromDisk(attemptId: string, state: AttemptWriteState): void {
    try {
      const text = readFileSync(this.filePath(attemptId), "utf8");
      state.bytes = Buffer.byteLength(text, "utf8");
      let maxSeq = 0;
      for (const line of text.split("\n")) {
        const parsed = parseAttemptLiveEventLine(line);
        if (parsed === null) continue;
        if (parsed.seq > maxSeq) maxSeq = parsed.seq;
        if (parsed.type === "truncated") state.truncatedWritten = true;
      }
      state.nextSeq = maxSeq + 1;
      if (state.bytes >= this.maxBytes) state.truncatedWritten = true;
    } catch {
      // missing file is the common first-write path
    }
  }

  private armTimer(attemptId: string): void {
    const state = this.state(attemptId);
    if (state.timer !== undefined) return;
    state.timer = this.setTimeoutFn(() => {
      state.timer = undefined;
      try {
        this.flushPending(attemptId);
      } catch {
        // sidecar must never fail the review
      }
    }, this.mergeWindowMs);
  }

  private clearTimer(state: AttemptWriteState): void {
    if (state.timer === undefined) return;
    this.clearTimeoutFn(state.timer);
    state.timer = undefined;
  }

  private flushPending(attemptId: string): void {
    const state = this.states.get(attemptId);
    if (state === undefined) return;
    this.clearTimer(state);
    const pending = state.pending;
    state.pending = null;
    if (pending === null || pending.text.length === 0) return;
    this.writePayload(attemptId, pending);
  }

  private writePayload(attemptId: string, payload: AttemptLiveEventPayload): void {
    const state = this.state(attemptId);
    const isDelta = payload.type === "text.delta" || payload.type === "thinking.delta";
    if (isDelta && (state.truncatedWritten || state.bytes >= this.maxBytes)) {
      state.dropped++;
      this.writeTruncated(attemptId);
      return;
    }
    const event: AttemptLiveEvent = {
      seq: state.nextSeq,
      at: new Date(this.now()).toISOString(),
      ...payload,
    };
    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (isDelta && state.bytes + size > this.maxBytes) {
      state.dropped++;
      this.writeTruncated(attemptId);
      return;
    }
    this.writeLine(attemptId, line, size);
  }

  private writeTruncated(attemptId: string): void {
    const state = this.state(attemptId);
    if (state.truncatedWritten) return;
    state.truncatedWritten = true;
    const event: AttemptLiveEvent = {
      seq: state.nextSeq,
      at: new Date(this.now()).toISOString(),
      type: "truncated",
      dropped: Math.max(1, state.dropped),
    };
    const line = `${JSON.stringify(event)}\n`;
    this.writeLine(attemptId, line, Buffer.byteLength(line, "utf8"));
  }

  private writeLine(attemptId: string, line: string, size: number): void {
    const state = this.state(attemptId);
    this.ensureDir();
    appendFileSync(this.filePath(attemptId), line);
    state.bytes += size;
    state.nextSeq += 1;
  }

  private ensureDir(): void {
    if (this.dirReady) return;
    mkdirSync(join(this.runDir, "live"), { recursive: true });
    this.dirReady = true;
  }

  private filePath(attemptId: string): string {
    return join(this.runDir, "live", `${attemptId}.jsonl`);
  }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const parts = value
      .map((b) =>
        typeof b === "string"
          ? b
          : ((b as { text?: string })?.text ?? (b as { content?: string })?.content ?? ""),
      )
      .filter((p) => p.length > 0);
    const joined = parts.join("\n");
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function toolName(item: Record<string, unknown>, fallback: string): string {
  if (typeof item.name === "string" && item.name.length > 0) return item.name;
  if (typeof item.tool === "string" && item.tool.length > 0) return item.tool;
  return fallback.length > 0 ? fallback : "tool";
}

const TOOL_SUMMARY_KEYS = [
  "command",
  "cmd",
  "file_path",
  "target_file",
  "path",
  "file",
  "query",
  "pattern",
  "glob",
] as const;

function pickToolSummary(source: Record<string, unknown> | null): string {
  if (source === null) return "";
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return formatSummary(value);
  }
  return "";
}

function formatSummary(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const { text } = stripProxyPrefix(raw.trimStart());
  const folded = text.replace(/\s+/g, " ").trim();
  return clipLiveSummary(folded);
}
