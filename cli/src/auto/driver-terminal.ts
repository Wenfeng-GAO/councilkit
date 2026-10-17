import { redactAuthorizationMaterial } from "@shared/runtime/redact-authorization";
import { redactCredentialMaterial } from "@shared/runtime/redact-credential";
import { clipUtf16 } from "@shared/text/clip-utf16";

/**
 * Classify provider terminal evidence. Structured JSON/protocol errors beat
 * unrelated stderr warnings. Does not echo secret values.
 */
export type DriverErrorClass = "quota" | "auth" | "model" | "rate" | "transport" | "unknown";

export type DriverTerminal = {
  errorClass: DriverErrorClass;
  retryable: boolean;
  message: string;
  /** `structured` is a protocol error event. `stderr` is an explicit phrase. */
  source: "structured" | "stderr";
};

const QUOTA = /usage[_\s-]?limit|quota[_\s-]?exceeded|insufficient[_\s-]?quota/i;
const AUTH_PHRASE =
  /auth(?:entication|orization)? (?:failed|error)|unauthorized|invalid api key|not logged in|please (?:run )?\S* ?login|AUTH_REQUIRED/i;
const MODEL = /unsupported model|unknown model|model[_ ]not[_ ]found|invalid model/i;
const RATE_PHRASE = /rate[_ ]limit|too many requests/i;
const TRANSPORT_PHRASE =
  /econnreset|etimedout|socket hang up|network error|bad gateway|service unavailable/i;

/** Diff hunks and name-status lines are tool output, not a provider error. */
const TOOL_OUTPUT = /^(?:diff --git |[MADRC]\t)|@@ -\d+/m;

const STATUS_FIELDS = ["status", "statusCode", "status_code", "httpStatus", "http_status"] as const;

/** Redact provider diagnostics before any failure/transcript/report persistence. */
export function redactDriverDiagnostic(text: string): string {
  const redacted = redactCredentialMaterial(
    redactAuthorizationMaterial(text, "[redacted]"),
    "[redacted]",
  );
  return clipUtf16(redacted, 400);
}

function pickClass(text: string): DriverErrorClass | null {
  if (QUOTA.test(text)) return "quota";
  if (AUTH_PHRASE.test(text)) return "auth";
  if (MODEL.test(text)) return "model";
  if (RATE_PHRASE.test(text)) return "rate";
  if (TRANSPORT_PHRASE.test(text)) return "transport";
  return null;
}

function phraseFor(text: string, errorClass: DriverErrorClass): string | null {
  const pattern =
    errorClass === "quota"
      ? QUOTA
      : errorClass === "auth"
        ? AUTH_PHRASE
        : errorClass === "model"
          ? MODEL
          : errorClass === "rate"
            ? RATE_PHRASE
            : errorClass === "transport"
              ? TRANSPORT_PHRASE
              : null;
  return pattern?.exec(text)?.[0] ?? null;
}

function fallbackSentence(errorClass: DriverErrorClass): string {
  switch (errorClass) {
    case "auth":
      return "authentication failed";
    case "quota":
      return "quota exceeded";
    case "rate":
      return "rate limit";
    case "transport":
      return "transport error";
    case "model":
      return "model unavailable";
    default:
      return "driver failed";
  }
}

/** Provider phrase or a fixed sentence. Never a slice of tool output. */
function failureMessage(text: string, errorClass: DriverErrorClass, structured: boolean): string {
  const phrase = phraseFor(text, errorClass);
  if (!structured || TOOL_OUTPUT.test(text)) {
    return redactDriverDiagnostic(phrase ?? fallbackSentence(errorClass));
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return fallbackSentence(errorClass);
  return redactDriverDiagnostic(trimmed);
}

function numericStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^(?:401|403|429|502|503)$/.test(value)) return Number(value);
  return null;
}

function rowStatusCode(row: Record<string, unknown>): number | null {
  const nests = [row];
  const error = row.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    nests.push(error as Record<string, unknown>);
  }
  for (const obj of nests) {
    for (const key of STATUS_FIELDS) {
      const code = numericStatus(obj[key]);
      if (code !== null) return code;
    }
    const code = numericStatus(obj.code);
    if (code !== null) return code;
  }
  return null;
}

function classForStatus(code: number): DriverErrorClass | null {
  if (code === 401 || code === 403) return "auth";
  if (code === 429) return "rate";
  if (code === 502 || code === 503) return "transport";
  return null;
}

function isRetryableClass(errorClass: DriverErrorClass): boolean {
  return errorClass === "rate" || errorClass === "transport" || errorClass === "unknown";
}

/** Codex CLI prints this while it retries a dropped app-server stream. */
const CODEX_RECONNECT =
  /reconnecting\.\.\.\s*\d+\s*\/\s*\d+|stream disconnected before completion/i;

export function isCodexReconnectDiagnostic(text: string): boolean {
  return CODEX_RECONNECT.test(text);
}

function isStructuredErrorRow(row: Record<string, unknown>): boolean {
  const type = typeof row.type === "string" ? row.type : "";
  const subtype = typeof row.subtype === "string" ? row.subtype : "";
  const error =
    row.error && typeof row.error === "object" ? (row.error as Record<string, unknown>) : null;
  const nestedType = error && typeof error.type === "string" ? error.type : "";
  if (
    type.includes("error") ||
    type === "turn.failed" ||
    nestedType === "usage_limit_exceeded" ||
    nestedType.includes("error") ||
    type === "task_complete.error"
  ) {
    return true;
  }
  if (type === "result" && (row.is_error === true || subtype.includes("error"))) {
    return true;
  }
  return false;
}

function isStructuredSuccessRow(row: Record<string, unknown>): boolean {
  const type = typeof row.type === "string" ? row.type : "";
  const subtype = typeof row.subtype === "string" ? row.subtype : "";
  if (type === "item.completed") {
    const item = row.item && typeof row.item === "object" ? (row.item as { type?: unknown }) : null;
    return item?.type === "agent_message";
  }
  if (type === "turn.completed") return true;
  if (type !== "result") return false;
  if (row.is_error === true || subtype.includes("error")) return false;
  return subtype === "success" || subtype.length === 0 || row.is_error === false;
}

function structuredLabel(row: Record<string, unknown>): string {
  const type = typeof row.type === "string" ? row.type : "";
  const subtype = typeof row.subtype === "string" ? row.subtype : "";
  const error =
    row.error && typeof row.error === "object" ? (row.error as Record<string, unknown>) : null;
  const nestedType = error && typeof error.type === "string" ? error.type : "";
  const message =
    (error && typeof error.message === "string" ? error.message : null) ??
    (typeof row.message === "string" ? row.message : null) ??
    (typeof row.result === "string" ? row.result : null);
  const label = nestedType || subtype || type;
  return `${label}${message ? `: ${message}` : ""}`;
}

type StructuredHit = { label: string; row: Record<string, unknown> };

/** A JSON object that is only an HTTP status, not a tool or assistant event. */
function isBareStatusPayload(row: Record<string, unknown>): boolean {
  if (
    row.role !== undefined ||
    row.item !== undefined ||
    row.content !== undefined ||
    row.tool_calls !== undefined
  ) {
    return false;
  }
  const type = typeof row.type === "string" ? row.type : "";
  if (
    type === "result" ||
    type === "assistant" ||
    type === "item.completed" ||
    type === "turn.completed" ||
    type === "tool_call" ||
    type === "stream_event" ||
    type === "system"
  ) {
    return false;
  }
  return classForStatus(rowStatusCode(row) ?? Number.NaN) !== null;
}

function classifyStructured(hit: StructuredHit): DriverErrorClass {
  const fromStatus = classForStatus(rowStatusCode(hit.row) ?? Number.NaN);
  const fromPhrase = pickClass(hit.label);
  if (fromPhrase === "quota" || fromPhrase === "auth") return fromPhrase;
  return fromStatus ?? fromPhrase ?? "unknown";
}

function parseStructuredTerminal(text: string): { errors: StructuredHit[]; success: boolean } {
  const errors: StructuredHit[] = [];
  let success = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (isStructuredSuccessRow(row)) {
        success = true;
        continue;
      }
      if (isStructuredErrorRow(row) || isBareStatusPayload(row)) {
        const label = structuredLabel(row);
        if (!isCodexReconnectDiagnostic(label)) errors.push({ label, row });
      }
    } catch {
      /* ignore non-json */
    }
  }
  return { errors, success };
}

export function classifyDriverTerminal(input: {
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
}): DriverTerminal | null {
  const stdout = input.stdout ?? "";
  const stderr = input.stderr ?? "";
  // Structured terminal (success or error) beats unrelated stderr warnings.
  const structured = parseStructuredTerminal(`${stdout}\n${stderr}`);
  if (structured.errors.length > 0) {
    const hit = structured.errors[0];
    if (hit === undefined) return null;
    const errorClass = classifyStructured(hit);
    return {
      errorClass,
      retryable: isRetryableClass(errorClass),
      message: failureMessage(hit.label, errorClass, true),
      source: "structured",
    };
  }
  if (structured.success) return null;
  const fromStderr = pickClass(stderr);
  if (fromStderr === null) return null;
  if (fromStderr === "transport" && isCodexReconnectDiagnostic(stderr)) return null;
  return {
    errorClass: fromStderr,
    retryable: isRetryableClass(fromStderr),
    message: failureMessage(stderr, fromStderr, false),
    source: "stderr",
  };
}

export function isRetryableTerminal(terminal: DriverTerminal | null): boolean {
  return terminal?.retryable !== false;
}
