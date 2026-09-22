/**
 * Squad repair observation DTOs, limits, and pure helpers.
 * Observation is a read-only projection — never mutates repair budget/gate/journal.
 */
import { z } from "zod";

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 hex without node:crypto so this module can load in the browser bundle. */
function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bitLen = msg.length * 8;
  const padLen = (msg.length + 9 + 63) & ~63;
  const padded = new Uint8Array(padLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] ?? 0;
      const w2 = w[t - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) >>> 0);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (SHA256_K[t] ?? 0) + (w[t] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, "0")).join("");
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64UrlEncode(text: string): string {
  const bytes = utf8Bytes(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlDecode(raw: string): string {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export const REPAIR_OBS_SCHEMA_VERSION = 1 as const;
export const REPAIR_OBS_PAGE_LIMIT = 200;
export const REPAIR_OBS_MAX_RESPONSE_BYTES = 512 * 1024;
export const REPAIR_OBS_SUMMARY_MAX = 4 * 1024;
export const REPAIR_OBS_DETAIL_CHUNK = 64 * 1024;
export const REPAIR_OBS_LINE_ISOLATE = 1 * 1024 * 1024;
export const REPAIR_OBS_UI_CACHE_BYTES = Math.floor(2.5 * 1024 * 1024);
export const REPAIR_OBS_UI_WINDOW = 200;
export const REPAIR_OBS_UI_MAX_ROWS = 400;
export const REPAIR_OBS_SILENCE_MS = 180_000;
export const REPAIR_OBS_PROCESS_FRESH_MS = 15_000;
export const REPAIR_OBS_POLL_MS = 1000;
export const REPAIR_OBS_BACKOFF_MS = [2000, 4000, 8000, 16_000, 30_000] as const;
export const REPAIR_OBS_PIN_THRESHOLD_PX = 48;
export const REPAIR_OBS_CURSOR_MAX = 4096;
export const REPAIR_OBS_REDACT = "[REDACTED]";

export const REPAIR_OBS_COPY = {
  waitingFirst: "等待首条记录",
  silentAlive: "暂时没有新活动，进程仍在线",
  processUnknown: "执行进程状态未知",
  connectionLost: "连接已断开",
  quotaAttention: "独立评审额度不足，需要处理",
  needsAttention: "需要处理，请查看执行记录",
  repairFailed: "修复执行失败，需要处理",
  candidatePendingGate: "本地候选完成，等待最终准出",
  approved: "已准出",
  stateEvidenceConflict: "状态与证据不一致",
  stopping: "停止中，等待执行确认",
  stopped: "已停止",
  unfinishedTool: "未收到结束记录",
  goalMissing: "目标未记录",
} as const;

export const repairAvailabilitySchema = z.enum(["available", "partial", "unavailable"]);
export type RepairAvailability = z.infer<typeof repairAvailabilitySchema>;

export const repairProcessStateSchema = z.enum(["alive", "exited", "unknown"]);
export type RepairProcessState = z.infer<typeof repairProcessStateSchema>;

export const repairRoleStatusSchema = z.enum([
  "pending",
  "active",
  "ended",
  "failed",
  "unknown",
]);
export type RepairRoleStatus = z.infer<typeof repairRoleStatusSchema>;

export const repairOpKindSchema = z.enum(["progress", "tool", "file", "command", "state"]);
export type RepairOpKind = z.infer<typeof repairOpKindSchema>;

export const repairOpStatusSchema = z.enum([
  "started",
  "completed",
  "failed",
  "unfinished",
  "unknown",
]);
export type RepairOpStatus = z.infer<typeof repairOpStatusSchema>;

export const repairBusinessResultSchema = z.enum(["approved", "needs_attention", "stopped"]);

export const repairOperationSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    sourceId: z.string().min(1).max(200),
    sourceGeneration: z.string().min(1).max(128),
    executionRef: z.string().min(1).max(200),
    round: z.number().int().positive(),
    roleKey: z.string().min(1).max(80),
    operationId: z.string().min(1).max(400),
    revision: z.number().int().nonnegative(),
    occurredAt: z.string().nullable(),
    receivedAt: z.string().min(1),
    kind: repairOpKindSchema,
    status: repairOpStatusSchema,
    summary: z.string().max(REPAIR_OBS_SUMMARY_MAX),
    detailRef: z.string().nullable(),
    truncated: z.boolean(),
  })
  .strict();
export type RepairOperation = z.infer<typeof repairOperationSchema>;

export const repairRoleSchema = z
  .object({
    roleKey: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    executionGroup: z.string().min(1).max(120),
    executionRef: z.string().nullable(),
    planned: z.boolean(),
    status: repairRoleStatusSchema,
    requestedModel: z.string().nullable(),
    actualModel: z.string().nullable(),
  })
  .strict();
export type RepairRole = z.infer<typeof repairRoleSchema>;

export const repairObservationSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_OBS_SCHEMA_VERSION),
    runId: z.string().min(1).max(80),
    round: z.number().int().positive(),
    currentRound: z.number().int().positive(),
    snapshotVersion: z.string().min(1).max(128),
    serverTime: z.string().min(1),
    observedAt: z.string().min(1),
    availability: repairAvailabilitySchema,
    reasons: z.array(z.string().max(400)).max(32),
    sourceWatermarks: z
      .array(
        z
          .object({
            sourceId: z.string().min(1).max(200),
            generation: z.string().min(1).max(128),
            cursor: z.string().max(REPAIR_OBS_CURSOR_MAX),
          })
          .strict(),
      )
      .max(64),
    task: z
      .object({
        phase: z.string().nullable(),
        businessResult: repairBusinessResultSchema.nullable(),
        candidateSha: z.string().nullable(),
        baseSha: z.string().nullable(),
        goalSummary: z.string().nullable().optional(),
        lastActivityAt: z.string().nullable(),
        lastActivityTimeSource: z.enum(["recorded", "observed_live", "unknown"]),
        process: z
          .object({
            state: repairProcessStateSchema,
            checkedAt: z.string().nullable(),
            startKey: z.string().nullable().optional(),
          })
          .strict(),
        resumeEligible: z.boolean().nullable(),
        budget: z
          .object({
            sourceFixUsed: z.number().int().nonnegative().nullable(),
            sourceFixMax: z.number().int().positive().nullable(),
            tokenUsageComplete: z.boolean().nullable(),
          })
          .strict()
          .nullable()
          .optional(),
        startedAt: z.string().nullable().optional(),
        protocolVersion: z.enum(["v1", "v2"]).nullable().optional(),
        reasonCode: z.string().nullable().optional(),
        stopAckPending: z.boolean().optional(),
      })
      .strict(),
    roles: z.array(repairRoleSchema).max(32),
    upserts: z.array(repairOperationSchema).max(REPAIR_OBS_PAGE_LIMIT),
    nextCursor: z.string().max(REPAIR_OBS_CURSOR_MAX),
    earlierCursor: z.string().nullable(),
    hasMore: z.boolean(),
    reset: z.boolean(),
    observationDone: z.boolean(),
  })
  .strict();
export type RepairObservation = z.infer<typeof repairObservationSchema>;

export const repairEventDetailSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_OBS_SCHEMA_VERSION),
    eventId: z.string().min(1).max(200),
    operation: repairOperationSchema,
    body: z.string().max(REPAIR_OBS_DETAIL_CHUNK),
    truncated: z.boolean(),
    nextCursor: z.string().nullable(),
    availability: repairAvailabilitySchema,
    reasons: z.array(z.string().max(400)).max(16),
  })
  .strict();
export type RepairEventDetail = z.infer<typeof repairEventDetailSchema>;

export const repairEvidenceItemSchema = z
  .object({
    assertionId: z.string().min(1).max(200),
    label: z.string().min(1).max(400),
    status: z.enum(["passed", "failed", "pending", "insufficient"]),
    candidateSha: z.string().nullable(),
    assertionVersion: z.string().nullable(),
    source: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .strict();
export type RepairEvidenceItem = z.infer<typeof repairEvidenceItemSchema>;

export const repairEvidenceSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_OBS_SCHEMA_VERSION),
    runId: z.string().min(1).max(80),
    round: z.number().int().positive(),
    candidateSha: z.string().nullable(),
    baseSha: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    assertionVersion: z.string().nullable(),
    gateConsistent: z.boolean(),
    exportableAsApproved: z.boolean(),
    items: z.array(repairEvidenceItemSchema).max(200),
    availability: repairAvailabilitySchema,
    reasons: z.array(z.string().max(400)).max(32),
  })
  .strict();
export type RepairEvidence = z.infer<typeof repairEvidenceSchema>;

/** Raw public source record (thinking/reasoning already excluded by reader). */
export type RawSourceRecord = {
  sourceId: string;
  sourceGeneration: string;
  executionRef: string;
  round: number;
  roleKey: string;
  byteOffset: number;
  receivedAt: string;
  occurredAt: string | null;
  type: string;
  callId: string | null;
  name?: string;
  summary?: string;
  text?: string;
  path?: string;
  action?: "read" | "edit";
  status?: string;
  exitCode?: number | null;
  detail?: string;
};

export type ObservationCursor = {
  runId: string;
  round: number;
  direction: "forward" | "earlier";
  watermarks: Array<{ sourceId: string; generation: string; offset: number }>;
};

export function encodeObservationCursor(cursor: ObservationCursor): string {
  const json = JSON.stringify(cursor);
  if (json.length > REPAIR_OBS_CURSOR_MAX) {
    throw new Error("cursor too large");
  }
  return base64UrlEncode(json);
}

export function decodeObservationCursor(
  raw: string | null | undefined,
  expected: { runId: string; round: number },
): { ok: true; cursor: ObservationCursor } | { ok: false; reason: string } {
  if (raw === null || raw === undefined || raw.length === 0) {
    return {
      ok: true,
      cursor: {
        runId: expected.runId,
        round: expected.round,
        direction: "forward",
        watermarks: [],
      },
    };
  }
  if (raw.length > REPAIR_OBS_CURSOR_MAX) {
    return { ok: false, reason: "cursor too large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(raw));
  } catch {
    return { ok: false, reason: "invalid cursor encoding" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid cursor shape" };
  }
  const row = parsed as Record<string, unknown>;
  if (row.runId !== expected.runId) return { ok: false, reason: "cursor run mismatch" };
  if (row.round !== expected.round) return { ok: false, reason: "cursor round mismatch" };
  if (row.direction !== "forward" && row.direction !== "earlier") {
    return { ok: false, reason: "invalid cursor direction" };
  }
  if (!Array.isArray(row.watermarks)) return { ok: false, reason: "invalid watermarks" };
  const watermarks: ObservationCursor["watermarks"] = [];
  for (const item of row.watermarks) {
    if (item === null || typeof item !== "object") {
      return { ok: false, reason: "invalid watermark" };
    }
    const w = item as Record<string, unknown>;
    if (typeof w.sourceId !== "string" || typeof w.generation !== "string") {
      return { ok: false, reason: "invalid watermark fields" };
    }
    if (typeof w.offset !== "number" || !Number.isInteger(w.offset) || w.offset < 0) {
      return { ok: false, reason: "invalid watermark offset" };
    }
    watermarks.push({
      sourceId: w.sourceId,
      generation: w.generation,
      offset: w.offset,
    });
  }
  return {
    ok: true,
    cursor: {
      runId: expected.runId,
      round: expected.round,
      direction: row.direction,
      watermarks,
    },
  };
}

export function buildOperationId(input: {
  executionRef: string;
  sourceGeneration: string;
  callId: string | null;
  byteOffset: number;
  subIndex?: number;
}): string {
  const callPart =
    input.callId && input.callId.length > 0
      ? input.callId
      : `off:${input.byteOffset}${input.subIndex !== undefined ? `.${input.subIndex}` : ""}`;
  return `${input.executionRef}|${input.sourceGeneration}|${callPart}`;
}

export function buildEventId(operationId: string, revision: number): string {
  const digest = sha256Hex(`${operationId}#${revision}`).slice(0, 24);
  return `evt_${digest}`;
}

const TERMINAL_STATUS = new Set<RepairOpStatus>(["completed", "failed"]);

export function mergeOperationRevision(
  existing: RepairOperation | undefined,
  next: RepairOperation,
): RepairOperation {
  if (!existing) return next;
  if (existing.operationId !== next.operationId) return next;
  // Late started must not roll back a terminal status.
  if (TERMINAL_STATUS.has(existing.status) && next.status === "started") {
    return {
      ...existing,
      revision: Math.max(existing.revision, next.revision),
      receivedAt: next.receivedAt > existing.receivedAt ? next.receivedAt : existing.receivedAt,
    };
  }
  if (next.revision < existing.revision) return existing;
  return {
    ...next,
    revision: Math.max(existing.revision, next.revision),
    eventId: existing.eventId,
  };
}

export function upsertOperations(existing: RepairOperation[], incoming: RepairOperation[]): RepairOperation[] {
  const byOp = new Map<string, RepairOperation>();
  for (const row of existing) byOp.set(row.operationId, row);
  for (const row of incoming) {
    byOp.set(row.operationId, mergeOperationRevision(byOp.get(row.operationId), row));
  }
  return [...byOp.values()].sort((a, b) => {
    if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    return a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0;
  });
}

/** Fold public text fragments; drop thinking/reasoning. */
export function foldPublicText(records: RawSourceRecord[]): RepairOperation[] {
  const out: RepairOperation[] = [];
  let buffer: RawSourceRecord[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const first = buffer[0]!;
    const text = buffer
      .map((r) => r.text ?? r.summary ?? "")
      .join("")
      .trim();
    buffer = [];
    if (text.length === 0) return;
    const operationId = buildOperationId({
      executionRef: first.executionRef,
      sourceGeneration: first.sourceGeneration,
      callId: first.callId,
      byteOffset: first.byteOffset,
    });
    const summary = clipSummary(text);
    out.push({
      eventId: buildEventId(operationId, 1),
      sourceId: first.sourceId,
      sourceGeneration: first.sourceGeneration,
      executionRef: first.executionRef,
      round: first.round,
      roleKey: first.roleKey,
      operationId,
      revision: 1,
      occurredAt: first.occurredAt,
      receivedAt: first.receivedAt,
      kind: "progress",
      status: "completed",
      summary,
      detailRef: null,
      truncated: text.length > REPAIR_OBS_SUMMARY_MAX,
    });
  };

  for (const record of records) {
    const type = record.type.toLowerCase();
    if (type.includes("thinking") || type.includes("reasoning")) continue;
    if (type === "assistant") {
      flush();
      buffer.push(record);
      flush();
      continue;
    }
    if (type === "text" || type === "text.delta" || type === "progress") {
      if (
        buffer.length > 0 &&
        (buffer[0]!.executionRef !== record.executionRef ||
          buffer[0]!.roleKey !== record.roleKey)
      ) {
        flush();
      }
      buffer.push(record);
      continue;
    }
    flush();
  }
  flush();
  return out;
}

export function normalizeToolRecords(records: RawSourceRecord[]): RepairOperation[] {
  const byOp = new Map<string, RepairOperation>();
  for (const record of records) {
    const type = record.type.toLowerCase();
    if (type.includes("thinking") || type.includes("reasoning")) continue;
    const isTool =
      type.startsWith("tool") ||
      type === "command" ||
      type === "file" ||
      type.includes("toolcall");
    if (!isTool && type !== "state") continue;

    const callId = record.callId;
    const operationId = buildOperationId({
      executionRef: record.executionRef,
      sourceGeneration: record.sourceGeneration,
      callId,
      byteOffset: record.byteOffset,
    });
    const toolName = (record.name ?? "").toLowerCase();
    let kind: RepairOpKind = "tool";
    if (type === "file" || record.action === "read" || record.action === "edit" || toolName.includes("read") || toolName.includes("edit")) {
      kind = "file";
    } else if (type === "command" || type.includes("command") || toolName.includes("shell") || toolName.includes("command")) {
      kind = "command";
    } else if (type === "state") kind = "state";

    let status: RepairOpStatus = "started";
    if (type.endsWith("completed") || record.status === "completed") status = "completed";
    if (type.endsWith("failed") || record.status === "failed" || (record.exitCode ?? 0) > 0) {
      status = "failed";
    }
    if (record.status === "unfinished") status = "unfinished";

    const fileAction = record.action === "read" ? "读取" : record.action === "edit" ? "修改" : "文件";
    const fileNote =
      record.action === "edit" ? (record.detail ? "已记录差异" : "未记录") : "";
    const baseSummary =
      kind === "file"
        ? `${fileAction} ${record.path ?? ""} ${fileNote}`.trim()
        : (record.summary ?? record.name ?? record.text ?? kind);
    const detailNote =
      record.detail && (record.detail.includes(REPAIR_OBS_REDACT) || record.detail.length <= 120)
        ? record.detail
        : "";
    const summary = clipSummary(detailNote ? `${baseSummary} ${detailNote}` : baseSummary);

    const next: RepairOperation = {
      eventId: buildEventId(operationId, status === "started" ? 1 : 2),
      sourceId: record.sourceId,
      sourceGeneration: record.sourceGeneration,
      executionRef: record.executionRef,
      round: record.round,
      roleKey: record.roleKey,
      operationId,
      revision: status === "started" ? 1 : 2,
      occurredAt: record.occurredAt,
      receivedAt: record.receivedAt,
      kind,
      status,
      summary: summary.length > 0 ? summary : kind,
      detailRef: record.detail ? `detail:${operationId}` : null,
      truncated: false,
    };
    byOp.set(operationId, mergeOperationRevision(byOp.get(operationId), next));
  }
  return [...byOp.values()];
}

export function markUnfinishedTools(
  ops: RepairOperation[],
  nowMs: number,
  unfinishedAfterMs = 180_000,
): RepairOperation[] {
  return ops.map((op) => {
    if (op.status !== "started") return op;
    if (op.kind !== "tool" && op.kind !== "command") return op;
    const base = Date.parse(op.occurredAt ?? op.receivedAt);
    if (!Number.isFinite(base)) return op;
    if (nowMs - base < unfinishedAfterMs) return op;
    return {
      ...op,
      status: "unfinished",
      summary: op.summary.includes(REPAIR_OBS_COPY.unfinishedTool)
        ? op.summary
        : `${op.summary} · ${REPAIR_OBS_COPY.unfinishedTool}`,
      revision: Math.max(op.revision, 2),
    };
  });
}

export function clipSummary(value: string): string {
  if (value.length <= REPAIR_OBS_SUMMARY_MAX) return value;
  return value.slice(0, REPAIR_OBS_SUMMARY_MAX);
}

const SECRET_VALUE_KEYS =
  /^(authorization|cookie|csrf|token|password|secret|credential|api[_-]?key|x-api-key)$/i;
const AUTH_HEADER = /(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi;
const COOKIE_HEADER = /(cookie\s*[:=]\s*)[^;\n]+/gi;
const API_KEY = /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|AIza[0-9A-Za-z_-]{10,})\b/g;
const ASSIGNED_SECRET = /\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi;
const URL_QUERY_SECRET =
  /([?&](?:token|key|api[_-]?key|access_token|auth|password|secret)=)[^&\s"']+/gi;

export function redactObservationText(input: string): string {
  let out = input.replace(AUTH_HEADER, `$1$2${REPAIR_OBS_REDACT}`);
  out = out.replace(COOKIE_HEADER, `$1${REPAIR_OBS_REDACT}`);
  out = out.replace(API_KEY, REPAIR_OBS_REDACT);
  out = out.replace(ASSIGNED_SECRET, `$1${REPAIR_OBS_REDACT}`);
  out = out.replace(URL_QUERY_SECRET, `$1${REPAIR_OBS_REDACT}`);
  return out;
}

export function redactObservationValue(value: unknown): unknown {
  if (typeof value === "string") return redactObservationText(value);
  if (Array.isArray(value)) return value.map((item) => redactObservationValue(item));
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      if (SECRET_VALUE_KEYS.test(key)) {
        out[key] = REPAIR_OBS_REDACT;
      } else {
        out[key] = redactObservationValue(row[key]);
      }
    }
    return out;
  }
  return value;
}

export function containsObservationSecret(input: string, sentinel: string): boolean {
  return sentinel.length > 0 && input.includes(sentinel);
}

export type ProcessEvidence = {
  executionRef: string | null;
  pid: number | null;
  startKey: string | null;
  checkedAt: string | null;
  alive: boolean;
};

export function deriveProcessState(input: {
  // Business completion is intentionally not process-liveness evidence.
  authoritativeTerminal: boolean;
  currentExecutionRef: string | null;
  evidence: ProcessEvidence | null;
  nowMs: number;
}): { state: RepairProcessState; checkedAt: string | null } {
  const evidence = input.evidence;
  if (!evidence || !evidence.checkedAt) {
    return { state: "unknown", checkedAt: null };
  }
  const checkedMs = Date.parse(evidence.checkedAt);
  if (!Number.isFinite(checkedMs) || input.nowMs - checkedMs > REPAIR_OBS_PROCESS_FRESH_MS) {
    return { state: "unknown", checkedAt: evidence.checkedAt };
  }
  if (
    !input.currentExecutionRef ||
    evidence.executionRef !== input.currentExecutionRef
  ) {
    return { state: "unknown", checkedAt: evidence.checkedAt };
  }
  // Same PID with a different startKey is not proof of the current execution.
  if (evidence.startKey === null && evidence.pid !== null) {
    return { state: "unknown", checkedAt: evidence.checkedAt };
  }
  if (evidence.alive && evidence.executionRef === input.currentExecutionRef) {
    return { state: "alive", checkedAt: evidence.checkedAt };
  }
  if (!evidence.alive) return { state: "exited", checkedAt: evidence.checkedAt };
  return { state: "unknown", checkedAt: evidence.checkedAt };
}

export function deriveSilenceAttention(input: {
  nowMs: number;
  lastActivityAt: string | null;
  processState: RepairProcessState;
}): "silent_alive" | "process_unknown" | null {
  if (!input.lastActivityAt) return null;
  const lastMs = Date.parse(input.lastActivityAt);
  if (!Number.isFinite(lastMs)) return null;
  if (input.nowMs - lastMs < REPAIR_OBS_SILENCE_MS) return null;
  if (input.processState === "alive") return "silent_alive";
  return "process_unknown";
}

export function evaluateApprovalConsistency(input: {
  businessResult: "approved" | "needs_attention" | "stopped" | null;
  candidateSha: string | null;
  baseSha: string | null;
  evidenceCandidateSha: string | null;
  requiredItems: Array<{ status: RepairEvidenceItem["status"]; candidateSha: string | null }>;
}): {
  display: "approved" | "conflict" | "candidate_pending" | "needs_attention" | "stopped" | "running";
  exportableAsApproved: boolean;
  gateConsistent: boolean;
} {
  if (input.businessResult === "stopped") {
    return { display: "stopped", exportableAsApproved: false, gateConsistent: true };
  }
  if (input.businessResult === "needs_attention") {
    return { display: "needs_attention", exportableAsApproved: false, gateConsistent: true };
  }
  if (input.businessResult === "approved") {
    const shaOk =
      Boolean(input.candidateSha) &&
      Boolean(input.baseSha) &&
      input.evidenceCandidateSha === input.candidateSha;
    const allPassed =
      input.requiredItems.length > 0 &&
      input.requiredItems.every(
        (item) =>
          item.status === "passed" &&
          (item.candidateSha === null || item.candidateSha === input.candidateSha),
      );
    if (shaOk && allPassed) {
      return { display: "approved", exportableAsApproved: true, gateConsistent: true };
    }
    return { display: "conflict", exportableAsApproved: false, gateConsistent: false };
  }
  const allEnded =
    input.requiredItems.length > 0 &&
    input.requiredItems.every((item) => item.status === "passed" || item.status === "failed");
  if (allEnded && input.candidateSha) {
    return { display: "candidate_pending", exportableAsApproved: false, gateConsistent: true };
  }
  return { display: "running", exportableAsApproved: false, gateConsistent: true };
}

export function filterOperations(
  ops: RepairOperation[],
  filter: { roleKey?: string | null; kind?: string | null; query?: string | null },
): RepairOperation[] {
  const role = filter.roleKey && filter.roleKey !== "all" ? filter.roleKey : null;
  const kind = filter.kind && filter.kind !== "all" ? filter.kind : null;
  const query = filter.query?.trim().toLowerCase() ?? "";
  return ops.filter((op) => {
    if (role && op.roleKey !== role && op.executionRef !== role) return false;
    if (kind) {
      if (kind === "tool") {
        if (op.kind !== "tool" && op.kind !== "file" && op.kind !== "command") return false;
      } else if (op.kind !== kind) return false;
    }
    if (query.length > 0 && !op.summary.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function countNewOperations(
  previousIds: ReadonlySet<string>,
  next: RepairOperation[],
  options?: { ignoreReplay?: boolean },
): { count: number; ids: Set<string> } {
  const ids = new Set(previousIds);
  let count = 0;
  for (const op of next) {
    if (ids.has(op.operationId)) continue;
    ids.add(op.operationId);
    if (options?.ignoreReplay) continue;
    count += 1;
  }
  return { count, ids };
}

export function applyUiWindow(
  ops: RepairOperation[],
  visibleCount: number,
  cacheBudget = REPAIR_OBS_UI_CACHE_BYTES,
): { window: RepairOperation[]; hiddenCount: number; truncatedCache: boolean } {
  const capped = Math.min(Math.max(visibleCount, REPAIR_OBS_UI_WINDOW), REPAIR_OBS_UI_MAX_ROWS);
  let bytes = 0;
  const kept: RepairOperation[] = [];
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const row = ops[i]!;
    const size = utf8Bytes(JSON.stringify(row)).byteLength;
    if (bytes + size > cacheBudget && kept.length >= capped) break;
    kept.push(row);
    bytes += size;
  }
  kept.reverse();
  const window = kept.slice(Math.max(0, kept.length - capped));
  return {
    window,
    hiddenCount: Math.max(0, ops.length - window.length),
    truncatedCache: kept.length < ops.length,
  };
}

export function nextPollDelayMs(failures: number): number {
  if (failures <= 0) return REPAIR_OBS_POLL_MS;
  const idx = Math.min(failures - 1, REPAIR_OBS_BACKOFF_MS.length - 1);
  return REPAIR_OBS_BACKOFF_MS[idx]!;
}

export function isStaleRequest(requestSeq: number, currentSeq: number): boolean {
  return requestSeq !== currentSeq;
}

export function observationDone(input: {
  parentTerminal: boolean;
  sourcesExhausted: boolean;
}): boolean {
  return input.parentTerminal && input.sourcesExhausted;
}

export function resolveAttentionCopy(input: {
  connectionLost: boolean;
  display: ReturnType<typeof evaluateApprovalConsistency>["display"];
  silence: ReturnType<typeof deriveSilenceAttention>;
  emptyActive: boolean;
  stopAckPending: boolean;
  reasonCode?: string | null;
}): string | null {
  if (input.connectionLost) return REPAIR_OBS_COPY.connectionLost;
  if (input.stopAckPending) return REPAIR_OBS_COPY.stopping;
  if (input.display === "stopped") return REPAIR_OBS_COPY.stopped;
  if (input.display === "conflict") return REPAIR_OBS_COPY.stateEvidenceConflict;
  if (input.display === "approved") return REPAIR_OBS_COPY.approved;
  if (input.display === "candidate_pending") return REPAIR_OBS_COPY.candidatePendingGate;
  if (input.display === "needs_attention") {
    if (input.reasonCode?.toLowerCase().includes("quota")) return REPAIR_OBS_COPY.quotaAttention;
    if (input.reasonCode === "squad_failed" || input.reasonCode === "source_fix_failed") {
      return REPAIR_OBS_COPY.repairFailed;
    }
    return REPAIR_OBS_COPY.needsAttention;
  }
  if (input.silence === "silent_alive") return REPAIR_OBS_COPY.silentAlive;
  if (input.silence === "process_unknown") return REPAIR_OBS_COPY.processUnknown;
  if (input.emptyActive) return REPAIR_OBS_COPY.waitingFirst;
  return null;
}

export function exportEvidenceMarkdown(evidence: RepairEvidence): string {
  const lines = [
    `# Repair evidence · ${evidence.runId}`,
    "",
    `- round: ${evidence.round}`,
    `- candidateSha: ${evidence.candidateSha ?? "null"}`,
    `- baseSha: ${evidence.baseSha ?? "null"}`,
    `- assertionVersion: ${evidence.assertionVersion ?? "null"}`,
    `- verifiedAt: ${evidence.verifiedAt ?? "null"}`,
    `- exportableAsApproved: ${evidence.exportableAsApproved}`,
    "",
  ];
  for (const item of evidence.items) {
    lines.push(`## ${item.label}`);
    lines.push(`- id: ${item.assertionId}`);
    lines.push(`- status: ${item.status}`);
    lines.push(`- candidateSha: ${item.candidateSha ?? "null"}`);
    lines.push(`- source: ${item.source ?? "null"}`);
    if (item.detail) lines.push(`- detail: ${redactObservationText(item.detail)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function readCursorPayload(row: Record<string, unknown>): {
  skip: boolean;
  text?: string;
  name?: string;
  summary?: string;
  path?: string;
  action?: "read" | "edit";
  detail?: string;
  exitCode?: number | null;
} {
  const message = row.message;
  if (message !== null && typeof message === "object" && !Array.isArray(message)) {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      let sawHidden = false;
      for (const block of content) {
        if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
        const item = block as Record<string, unknown>;
        const blockType = typeof item.type === "string" ? item.type.toLowerCase() : "";
        if (blockType === "thinking" || blockType === "reasoning") {
          sawHidden = true;
          continue;
        }
        if (blockType === "text" && typeof item.text === "string") texts.push(item.text);
      }
      if (texts.length === 0 && sawHidden) return { skip: true };
      if (texts.length > 0) return { skip: false, text: texts.join(""), summary: texts.join("") };
    }
  }

  const toolCall = row.tool_call;
  if (toolCall !== null && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const entries = Object.entries(toolCall as Record<string, unknown>);
    const first = entries[0];
    if (first) {
      const [name, body] = first;
      const payload = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const args =
        payload.args !== null && typeof payload.args === "object" && !Array.isArray(payload.args)
          ? (payload.args as Record<string, unknown>)
          : payload;
      const result =
        payload.result !== null && typeof payload.result === "object" && !Array.isArray(payload.result)
          ? (payload.result as Record<string, unknown>)
          : null;
      const success =
        result?.success !== null && typeof result?.success === "object" && !Array.isArray(result?.success)
          ? (result.success as Record<string, unknown>)
          : null;
      const command =
        (typeof args.command === "string" && args.command) ||
        (typeof result?.command === "string" && result.command) ||
        (typeof success?.command === "string" && success.command) ||
        undefined;
      const path =
        (typeof args.path === "string" && args.path) ||
        (typeof args.file_path === "string" && args.file_path) ||
        (typeof result?.path === "string" && result.path) ||
        (typeof success?.path === "string" && success.path) ||
        undefined;
      const detail =
        (typeof result?.stdout === "string" && result.stdout) ||
        (typeof result?.stderr === "string" && result.stderr) ||
        (typeof result?.output === "string" && result.output) ||
        (typeof success?.diff === "string" && success.diff) ||
        (typeof success?.content === "string" && success.content) ||
        undefined;
      const exitCode = typeof result?.exitCode === "number" ? result.exitCode : null;
      const lower = name.toLowerCase();
      const action = lower.includes("read") ? "read" : lower.includes("edit") || lower.includes("write") ? "edit" : undefined;
      if (path?.includes("..") || path?.includes("\0")) {
        return { skip: false, name, summary: "路径不可用", action, exitCode };
      }
      const summary = [name, command ?? path].filter(Boolean).join(" ");
      return { skip: false, name, summary, path, action, detail, exitCode };
    }
  }
  return { skip: false };
}

export function parsePublicSourceLine(
  line: string,
  meta: {
    sourceId: string;
    sourceGeneration: string;
    executionRef: string;
    round: number;
    roleKey: string;
    byteOffset: number;
    receivedAt: string;
  },
): RawSourceRecord | "skip" | "bad" {
  const trimmed = line.trim();
  if (trimmed.length === 0) return "skip";
  let rec: unknown;
  try {
    rec = JSON.parse(trimmed);
  } catch {
    return "bad";
  }
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return "bad";
  const row = rec as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type : typeof row.kind === "string" ? row.kind : null;
  if (!type) return "bad";
  const lower = type.toLowerCase();
  if (lower.includes("thinking") || lower.includes("reasoning")) return "skip";

  const callId =
    (typeof row.callId === "string" && row.callId) ||
    (typeof row.call_id === "string" && row.call_id) ||
    (typeof row.toolCallId === "string" && row.toolCallId) ||
    (typeof row.id === "string" && row.id) ||
    null;
  const roleKey =
    (typeof row.roleKey === "string" && row.roleKey) ||
    (typeof row.role === "string" && row.role) ||
    meta.roleKey;
  const occurredAt =
    (typeof row.at === "string" && row.at) ||
    (typeof row.occurredAt === "string" && row.occurredAt) ||
    (typeof row.timestamp === "string" && row.timestamp) ||
    null;
  const cursor = readCursorPayload(row);
  if (cursor.skip) return "skip";

  return {
    sourceId: meta.sourceId,
    sourceGeneration: meta.sourceGeneration,
    executionRef:
      (typeof row.executionRef === "string" && row.executionRef) || meta.executionRef,
    round: meta.round,
    roleKey,
    byteOffset: meta.byteOffset,
    receivedAt: meta.receivedAt,
    occurredAt,
    type,
    callId,
    name: cursor.name ?? (typeof row.name === "string" ? row.name : undefined),
    summary: cursor.summary ?? (typeof row.summary === "string" ? row.summary : undefined),
    text:
      cursor.text ??
      (typeof row.text === "string" ? row.text : typeof row.message === "string" ? row.message : undefined),
    path:
      cursor.path ??
      (typeof row.path === "string" ? row.path : typeof row.file === "string" ? row.file : undefined),
    action:
      row.action === "read" || row.action === "edit"
        ? row.action
        : cursor.action
          ? cursor.action
          : lower.includes("read")
            ? "read"
            : lower.includes("edit") || lower.includes("write")
              ? "edit"
              : undefined,
    status:
      typeof row.status === "string"
        ? row.status
        : row.subtype === "completed" || row.subtype === "failed" || row.subtype === "started"
          ? row.subtype
          : undefined,
    exitCode: typeof row.exitCode === "number" ? row.exitCode : cursor.exitCode ?? null,
    detail:
      cursor.detail ??
      (typeof row.detail === "string" ? row.detail : typeof row.output === "string" ? row.output : undefined),
  };
}

export function fingerprintSource(stat: {
  size: number;
  mtimeMs: number;
  ino?: number | null;
}): string {
  // Appends change size and mtime; generation changes only when the file identity does.
  // Shrink/replace is detected separately by the reader when the cursor passes EOF.
  return sha256Hex(`ino:${stat.ino ?? 0}`).slice(0, 24);
}

export function roleLabel(roleKey: string): string {
  switch (roleKey) {
    case "all":
      return "全部活动";
    case "builder":
    case "orchestrator":
    case "planner_a":
    case "coder":
      return "编排与开发";
    case "planner_b":
      return "规划 B";
    case "reviewer":
      return "独立评审";
    case "verifier":
      return "独立验证";
    case "final_review":
      return "终验复审";
    default:
      return roleKey;
  }
}

export function executionGroupForRole(roleKey: string): string {
  if (roleKey === "orchestrator" || roleKey === "planner_a" || roleKey === "coder" || roleKey === "builder") {
    return "builder";
  }
  if (roleKey === "final_review" || roleKey.startsWith("jury-")) return "final_review";
  if (roleKey === "reviewer") return "reviewer";
  if (roleKey === "verifier") return "verifier";
  if (roleKey === "planner_b") return "planner_b";
  return roleKey;
}
