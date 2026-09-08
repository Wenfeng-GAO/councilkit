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

function redactish(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 400);
}

function pickClass(text: string): DriverErrorClass | null {
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (MODEL.test(text)) return "model";
  if (RATE.test(text)) return "rate";
  if (TRANSPORT.test(text)) return "transport";
  return null;
}

function parseJsonErrors(text: string): string[] {
  const hits: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof row.type === "string" ? row.type : "";
      const error =
        row.error && typeof row.error === "object" ? (row.error as Record<string, unknown>) : null;
      const nestedType = error && typeof error.type === "string" ? error.type : "";
      const message =
        (error && typeof error.message === "string" ? error.message : null) ??
        (typeof row.message === "string" ? row.message : null);
      if (
        type.includes("error") ||
        type === "turn.failed" ||
        nestedType === "usage_limit_exceeded" ||
        type === "task_complete.error"
      ) {
        hits.push(`${nestedType || type}${message ? `: ${message}` : ""}`);
      }
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
  const structured = parseJsonErrors(`${input.stdout ?? ""}\n${input.stderr ?? ""}`);
  const blob = structured.join("\n") || `${input.stderr ?? ""}\n${input.stdout ?? ""}`;
  const errorClass = pickClass(blob) ?? (structured.length > 0 ? "unknown" : null);
  if (errorClass === null) return null;
  const retryable = errorClass === "rate" || errorClass === "transport" || errorClass === "unknown";
  return {
    errorClass,
    retryable,
    message: redactish(structured[0] || blob),
  };
}

export function isRetryableTerminal(terminal: DriverTerminal | null): boolean {
  return terminal?.retryable !== false;
}
