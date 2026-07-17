import { randomUUID } from "node:crypto";
import { LIMITS } from "@shared/runtime/contracts";

/**
 * Structured Host logging and diagnostics.
 *
 * Hard rule: prompts, completions, credentials, cookies, auth tokens, full
 * environment dumps and CLI config contents are never logged. Every string
 * that reaches a log line or diagnostic entry is sanitized (control chars
 * stripped, length capped) before writing.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips C0/DEL control characters from untrusted diagnostics
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export function sanitizeString(input: string, maxBytes = LIMITS.diagnosticStringBytes): string {
  const stripped = input.replace(CONTROL_CHARS, "");
  const encoder = new TextEncoder();
  if (encoder.encode(stripped).byteLength <= maxBytes) {
    return stripped;
  }
  // Truncate on a UTF-8 boundary within the byte cap.
  let out = "";
  let bytes = 0;
  for (const char of stripped) {
    const size = encoder.encode(char).byteLength;
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return `${out}…(truncated)`;
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
      out[sanitizeString(key, 128)] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface DiagnosticEntry {
  diagnosticId: string;
  at: string;
  kind: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface Logger {
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  error(event: string, context?: Record<string, unknown>): void;
  diagnostic(kind: string, message: string, context?: Record<string, unknown>): DiagnosticEntry;
  diagnostics(): readonly DiagnosticEntry[];
}

export function createLogger(
  options: { sink?: (line: string) => void; ringSize?: number } = {},
): Logger {
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ringSize = options.ringSize ?? 256;
  const ring: DiagnosticEntry[] = [];

  function write(level: string, event: string, context?: Record<string, unknown>) {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      event: sanitizeString(event, 128),
      ...(context ? { context: sanitizeValue(context) } : {}),
    });
    sink(line);
  }

  return {
    info: (event, context) => write("info", event, context),
    warn: (event, context) => write("warn", event, context),
    error: (event, context) => write("error", event, context),
    diagnostic(kind, message, context) {
      const entry: DiagnosticEntry = {
        diagnosticId: randomUUID(),
        at: new Date().toISOString(),
        kind: sanitizeString(kind, 64),
        message: sanitizeString(message),
        ...(context ? { context: sanitizeValue(context) as Record<string, unknown> } : {}),
      };
      ring.push(entry);
      if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
      write("warn", `diagnostic.${entry.kind}`, {
        diagnosticId: entry.diagnosticId,
        message: entry.message,
      });
      return entry;
    },
    diagnostics: () => ring,
  };
}
