/**
 * Credential assignments whose name is a prefixed identifier.
 *
 * `\b` does not split on `_`, so `GITHUB_TOKEN=…`, `OPENAI_API_KEY=…`, and
 * `AWS_SECRET_ACCESS_KEY=…` slip past matchers that only know the bare word
 * `token` / `api_key` / `secret`. The same names, used as object keys, never
 * reach a string matcher at all. `nativeSession` and `personaPrompt` are not
 * credential keys: session is only the whole key or a `_`/`-` suffix, and
 * prompt is not a credential.
 */
import { isAuthorizationCredentialKey } from "./redact-authorization";

const CREDENTIAL_SEGMENTS = new Set([
  "apikey",
  "askpass",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "csrf",
  "password",
  "passwd",
  "secret",
  "token",
]);

const CREDENTIAL_PAIRS = new Set([
  "api_key",
  "auth_token",
  "access_token",
  "client_secret",
  "id_token",
  "private_key",
  "refresh_token",
  "secret_key",
  "session_token",
]);

function knownShapes(): RegExp[] {
  return [
    /\bsk-[A-Za-z0-9_-]{8,}/g,
    /\bghp_[A-Za-z0-9]+/g,
    /\bgho_[A-Za-z0-9]+/g,
    /\bgithub_pat_[A-Za-z0-9_]+/g,
    /\bAIza[0-9A-Za-z_-]{10,}/g,
    /BEGIN [A-Z ]+PRIVATE KEY[\s\S]*?END [A-Z ]+PRIVATE KEY/gi,
  ];
}

export function isCredentialKey(key: string): boolean {
  const bare = key.trim().replace(/^['"]+|['"]+$/g, "");
  if (bare.length === 0) return false;
  if (isAuthorizationCredentialKey(bare)) return true;
  if (/^session$/i.test(bare)) return true;
  const segments = splitIdentifier(bare);
  if (segments.length === 0) return false;
  const lower = segments.map((segment) => segment.toLowerCase());
  const last = lower[lower.length - 1] ?? "";
  if (last === "session" && /[_-]/.test(bare)) return true;
  for (let i = 0; i < lower.length; i += 1) {
    const current = lower[i] ?? "";
    if (CREDENTIAL_SEGMENTS.has(current)) return true;
    const next = lower[i + 1] ?? "";
    if (next.length > 0 && CREDENTIAL_PAIRS.has(pairName(current, next))) return true;
  }
  return false;
}

function pairName(left: string, right: string): string {
  const key = right === "keys" ? "key" : right;
  return `${left}_${key}`;
}

function splitIdentifier(key: string): string[] {
  const out: string[] = [];
  for (const part of key.split(/[_-]+/)) {
    if (part.length === 0) continue;
    const bits = part.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g);
    if (bits) out.push(...bits);
    else out.push(part);
  }
  return out;
}

export interface RedactCredentialOptions {
  /** Whole keys redacted in addition to credential names. Logger uses `prompt`. */
  extraExactKeys?: readonly string[];
}

export function redactCredentialMaterial(
  input: string,
  placeholder: string,
  options: RedactCredentialOptions = {},
): string {
  const extra = new Set((options.extraExactKeys ?? []).map((key) => key.toLowerCase()));
  let out = redactAssignments(input, placeholder, extra);
  out = out.replace(/\b(Bearer[ \t]+)[^\s"'}\]]+/gi, `$1${placeholder}`);
  for (const shape of knownShapes()) out = out.replace(shape, placeholder);
  return out;
}

function keyIsSecret(key: string, extra: ReadonlySet<string>): boolean {
  return extra.has(key.toLowerCase()) || isCredentialKey(key);
}

function isCookieName(key: string): boolean {
  const segments = splitIdentifier(key);
  return (segments[segments.length - 1] ?? "").toLowerCase() === "cookie";
}

function redactAssignments(input: string, placeholder: string, extra: ReadonlySet<string>): string {
  const assign = /(["']?)([A-Za-z][A-Za-z0-9_-]*)\1(\s*[:=]\s*)/g;
  let out = "";
  let cursor = 0;
  for (const match of input.matchAll(assign)) {
    const index = match.index ?? 0;
    if (index < cursor) continue;
    const key = match[2];
    const separator = match[3];
    if (!key || !separator || !keyIsSecret(key, extra)) continue;
    const valueStart = index + match[0].length;
    const opener = input[valueStart];
    // An unquoted `Cookie:` / `Set-Cookie:` header is a list of pairs. Stopping
    // at `;` would keep later pairs whose names are not credential keys.
    // A quoted key (`"cookie":`) is JSON, so the value stays one string.
    if (!match[1] && separator.includes(":") && isCookieName(key)) {
      const valueEnd = indexOfLineEnd(input, valueStart);
      out += collapsedAssignment(input, cursor, valueStart, separator, placeholder);
      cursor = valueEnd;
      continue;
    }
    // `{` / `[` on an authorization key is a structured record, not a header
    // value (`{"authorization":{"authority_ref":…}}` stays). Any other
    // credential value that starts with `{` or `[` is the secret itself.
    if ((opener === "{" || opener === "[") && isAuthorizationCredentialKey(key)) continue;
    if (opener === "{" || opener === "[") {
      const valueEnd = scanBracketValueEnd(input, valueStart);
      out += collapsedAssignment(input, cursor, valueStart, separator, placeholder);
      cursor = valueEnd;
      continue;
    }
    if (opener === '"' || opener === "'") {
      const close = scanQuotedEnd(input, valueStart);
      const quoted = close >= 0;
      const valueEnd = quoted ? close : indexOfLineEnd(input, valueStart);
      out += input.slice(cursor, valueStart + 1);
      out += placeholder;
      if (quoted) out += input[valueEnd];
      cursor = quoted ? valueEnd + 1 : valueEnd;
      continue;
    }
    const valueEnd = scanUnquotedValueEnd(input, valueStart);
    out += collapsedAssignment(input, cursor, valueStart, separator, placeholder);
    cursor = valueEnd;
  }
  out += input.slice(cursor);
  return out;
}

function collapsedAssignment(
  input: string,
  cursor: number,
  valueStart: number,
  separator: string,
  placeholder: string,
): string {
  const headEnd = valueStart - separator.length;
  const sep = separator.includes(":") ? separator : "=";
  return input.slice(cursor, headEnd) + sep + placeholder;
}

function scanQuotedEnd(input: string, openIndex: number): number {
  const quote = input[openIndex];
  let i = openIndex + 1;
  while (i < input.length) {
    const char = input[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) return i;
    if (char === "\n" || char === "\r") return -1;
    i += 1;
  }
  return -1;
}

function indexOfLineEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    if (input[i] === "\n" || input[i] === "\r") return i;
  }
  return input.length;
}

function scanBearerTokenEnd(input: string, start: number): number {
  // Comma stays inside the token (`Bearer abc,def`). Quotes and closers do not,
  // so a JSON string around the token keeps its delimiter.
  const match = /^bearer[ \t]+[^\s"'}\]]+/i.exec(input.slice(start));
  if (!match) return -1;
  return start + match[0].length;
}

function scanBracketValueEnd(input: string, start: number): number {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === "\n" || char === "\r") return i;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\n" || char === "\r") return i;
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.length === 0 || stack[stack.length - 1] !== char) return i;
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return input.length;
}

function scanUnquotedValueEnd(input: string, start: number): number {
  const bearerEnd = scanBearerTokenEnd(input, start);
  if (bearerEnd > start) return bearerEnd;
  let i = start;
  while (i < input.length) {
    const char = input[i];
    // A glued `;` is still the value (`password=foo;bar`). A `;` before
    // whitespace is a field separator (`cookie=a; b cookie=c`, `key=v; tail`).
    if (char === ";") {
      const next = input[i + 1];
      if (next === undefined || next === " " || next === "\t" || next === "\n" || next === "\r") {
        return i;
      }
      i += 1;
      continue;
    }
    if (
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\r" ||
      char === "," ||
      char === "&" ||
      char === "}" ||
      char === '"' ||
      char === "'"
    ) {
      return i;
    }
    i += 1;
  }
  return i;
}
