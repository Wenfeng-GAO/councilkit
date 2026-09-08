/**
 * Classify provider terminal evidence. Structured JSON/protocol errors beat
 * unrelated stderr warnings. Does not echo secret values.
 */
export type DriverErrorClass = "quota" | "auth" | "model" | "rate" | "transport" | "unknown";

export type DriverTerminal = {
  errorClass: DriverErrorClass;
  retryable: boolean;
  message: string;
};

const QUOTA = /usage[_\s-]?limit|quota[_\s-]?exceeded|insufficient[_\s-]?quota/i;
const AUTH = /auth(?:entication|orization)? (?:failed|error)|unauthorized|invalid api key|401\b/i;
const MODEL = /unsupported model|unknown model|model[_ ]not[_ ]found|invalid model/i;
const RATE = /rate[_ ]limit|too many requests|429\b/i;
const TRANSPORT = /econnreset|etimedout|socket hang up|network error|502\b|503\b/i;

const SK_TOKEN = /sk-[A-Za-z0-9_-]{8,}/g;
const COOKIE_HEADER = /Cookie:\s*[^\r\n]+/gi;
const CSRF_ASSIGN = /csrf=[^\s;,&]+/gi;
const BEARER = /Bearer\s+[^\s]+/gi;
const AUTHORIZATION = /Authorization:\s*[^\s]+/gi;
const SESSION_ASSIGN = /session=[^\s;,&]+/gi;

/** Redact provider diagnostics. Cookie / csrf= / Bearer / Authorization / session= / sk-. */
export function redactDriverDiagnostic(text: string): string {
  return text
    .replace(COOKIE_HEADER, "Cookie: [redacted]")
    .replace(CSRF_ASSIGN, "csrf=[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(AUTHORIZATION, "Authorization: [redacted]")
    .replace(SESSION_ASSIGN, "session=[redacted]")
    .replace(SK_TOKEN, "[redacted]")
    .slice(0, 400);
}

function pickClass(text: string): DriverErrorClass | null {
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (MODEL.test(text)) return "model";
  if (RATE.test(text)) return "rate";
  if (TRANSPORT.test(text)) return "transport";
  return null;
}

function isRetryableClass(errorClass: DriverErrorClass): boolean {
  return errorClass === "rate" || errorClass === "transport" || errorClass === "unknown";
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

function parseJsonErrors(text: string): string[] {
  const hits: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (!isStructuredErrorRow(row)) continue;
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
      hits.push(`${label}${message ? `: ${message}` : ""}`);
    } catch {
      /* ignore non-json */
    }
  }
  return hits;
}

export function classifyDriverTerminal(input: {
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
}): DriverTerminal | null {
  const stdout = input.stdout ?? "";
  const stderr = input.stderr ?? "";
  const structured = parseJsonErrors(`${stdout}\n${stderr}`);
  if (structured.length > 0) {
    const blob = structured.join("\n");
    const errorClass = pickClass(blob) ?? "unknown";
    return {
      errorClass,
      retryable: isRetryableClass(errorClass),
      message: redactDriverDiagnostic(structured[0] || blob),
    };
  }
  // Success-result bodies are never classified. Only stderr leftovers remain.
  const fromStderr = pickClass(stderr);
  if (fromStderr === null) return null;
  return {
    errorClass: fromStderr,
    retryable: isRetryableClass(fromStderr),
    message: redactDriverDiagnostic(stderr),
  };
}

export function isRetryableTerminal(terminal: DriverTerminal | null): boolean {
  return terminal?.retryable !== false;
}
