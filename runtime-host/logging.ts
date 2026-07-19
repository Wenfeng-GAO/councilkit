import { randomUUID } from "node:crypto";
import { LIMITS } from "@shared/runtime/contracts";

/**
 * Structured Host logging and diagnostics.
 *
 * Hard rule: prompts, completions, credentials, cookies, auth tokens, full
 * environment dumps and CLI config contents are never logged. Every string
 * that reaches a log line or diagnostic entry is sanitized (control chars
 * stripped, length capped) before writing; entries kept in the problems ring
 * (exported by the diagnostics route) additionally get secret-shape redaction
 * (see SECRET_PATTERNS).
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips C0/DEL control characters from untrusted diagnostics
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

// ---------------------------------------------------------------------------
// Secret-shape redaction for the problems ring (F1).
//
// Maintenance rule: when a new credential-ish key name shows up in driver
// stderr or CLI config dumps, add it to SECRET_KEYS; the matched shapes stay
// the three below (key=value, key: value, "key":"value") plus the HTTP
// `Bearer <token>` form. Only the VALUE part is replaced with "[redacted]" —
// the key name stays for debuggability. Absolute paths are deliberately NOT
// stripped: same-machine self-diagnosis needs them (Q10 boundary spirit;
// installations realpath is the precedent). Matching is intentionally
// shape-based and over-redacts prose like `prompt: ...` — the safe direction
// for an exported diagnostics bundle.
// ---------------------------------------------------------------------------
const SECRET_KEYS =
  "(?:api[-_]?key|authorization|bearer|cookie|csrf|password|prompt|secret|session|token)";

const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  {
    // "key":"value" / 'key': 'value' — quoted form, value may contain spaces
    pattern: new RegExp(`\\b(${SECRET_KEYS})\\b(\\s*["']?\\s*[:=]\\s*)(["'])[^"']*\\3`, "gi"),
    replacement: "$1$2$3[redacted]$3",
  },
  {
    // HTTP Authorization header form: Bearer <token>
    pattern: /\b(Bearer[ \t]+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: "$1[redacted]",
  },
  {
    // key=value / key: value — unquoted value up to whitespace/quote/comma/&/}
    pattern: new RegExp(`\\b(${SECRET_KEYS})\\b(\\s*["']?\\s*[:=]\\s*["']?)[^\\s"',}&]+`, "gi"),
    replacement: "$1$2[redacted]",
  },
];

function redactSecrets(input: string): string {
  let out = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactValueSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValueSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValueSecrets(item);
    }
    return out;
  }
  return value;
}

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

/** One sanitized warn/error line retained for the diagnostics export (S6). */
export interface LogRecord {
  at: string;
  level: "warn" | "error";
  event: string;
  context?: Record<string, unknown>;
}

export interface Logger {
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  error(event: string, context?: Record<string, unknown>): void;
  diagnostic(kind: string, message: string, context?: Record<string, unknown>): DiagnosticEntry;
  diagnostics(): readonly DiagnosticEntry[];
  /** Most recent warn/error lines (oldest first), capped by the ring size. */
  recentProblems(limit?: number): readonly LogRecord[];
}

export function createLogger(
  options: { sink?: (line: string) => void; ringSize?: number; problemRingSize?: number } = {},
): Logger {
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ringSize = options.ringSize ?? 256;
  const problemRingSize = options.problemRingSize ?? 50;
  const ring: DiagnosticEntry[] = [];
  const problemRing: LogRecord[] = [];

  function write(level: string, event: string, context?: Record<string, unknown>) {
    const at = new Date().toISOString();
    const safeEvent = sanitizeString(event, 128);
    const safeContext = context ? (sanitizeValue(context) as Record<string, unknown>) : undefined;
    // S6 problems ring (pure increment): warn/error lines — already sanitized
    // above — are also kept in a bounded buffer for the diagnostics route.
    // diagnostic() entries land here too via its internal warn write.
    // F1: the ring is exported off-machine, so event and every context string
    // additionally go through secret-shape redaction; the sink line (local
    // stderr, same-machine boundary) intentionally keeps the sanitized form.
    if (level === "warn" || level === "error") {
      problemRing.push({
        at,
        level,
        event: redactSecrets(safeEvent),
        ...(safeContext
          ? { context: redactValueSecrets(safeContext) as Record<string, unknown> }
          : {}),
      });
      if (problemRing.length > problemRingSize) {
        problemRing.splice(0, problemRing.length - problemRingSize);
      }
    }
    const line = JSON.stringify({
      at,
      level,
      event: safeEvent,
      ...(safeContext ? { context: safeContext } : {}),
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
    recentProblems: (limit) => problemRing.slice(-(limit ?? problemRingSize)),
  };
}
