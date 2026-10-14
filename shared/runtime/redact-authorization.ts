/**
 * Authorization values are the whole field, not the scheme word.
 *
 * An unquoted `;` ends the field. The host logger strips newlines before
 * redaction, and exported lines already separate assignments with `;`.
 * That separator is not a credential boundary when it sits inside quotes
 * (`realm="ex;ample"`) or inside an AWS `SignedHeaders` list
 * (`host;x-amz-date`). A `"` or `'` between the key and `:`/`=` is the JSON
 * form (`"authorization":"Bearer …"`); the quoted value is replaced, escapes
 * included. A `{` or `[` value is structured data, not a header credential.
 */

const AUTHORIZATION_KEY = /^(?:proxy[-_])?authorization$/i;
const HEADER_KEY = /\b(?:proxy[-_])?authorization\b/gi;
const BASIC_CREDENTIAL = /\bBasic\s+[A-Za-z0-9+/=._-]+/gi;
const ASSIGNMENT_AFTER_SEMI = /^[A-Za-z_][A-Za-z0-9_.-]*\s*[:=]/;

export function isAuthorizationCredentialKey(key: string): boolean {
  return AUTHORIZATION_KEY.test(key);
}

export function redactAuthorizationMaterial(input: string, placeholder: string): string {
  let out = "";
  let cursor = 0;
  HEADER_KEY.lastIndex = 0;
  for (const match of input.matchAll(HEADER_KEY)) {
    const keyStart = match.index;
    if (keyStart < cursor) continue;
    const field = parseAuthorizationField(input, keyStart + match[0].length);
    if (!field) continue;
    out += input.slice(cursor, field.valueStart);
    out += placeholder;
    if (field.closeQuote) out += input[field.valueEnd];
    cursor = field.closeQuote ? field.valueEnd + 1 : field.valueEnd;
  }
  out += input.slice(cursor);
  return out.replace(BASIC_CREDENTIAL, () => `Basic ${placeholder}`);
}

type FieldSpan = { valueStart: number; valueEnd: number; closeQuote: boolean };

function parseAuthorizationField(input: string, keyEnd: number): FieldSpan | null {
  let i = skipHorizontalSpace(input, keyEnd);
  if (i < input.length && (input[i] === '"' || input[i] === "'")) {
    i = skipHorizontalSpace(input, i + 1);
  }
  if (i >= input.length || (input[i] !== ":" && input[i] !== "=")) return null;
  i = skipHorizontalSpace(input, i + 1);
  if (i >= input.length) return { valueStart: i, valueEnd: i, closeQuote: false };
  const opener = input[i];
  if (opener === "{" || opener === "[") return null;
  if (opener === '"' || opener === "'") {
    const close = scanQuotedEnd(input, i);
    if (close < 0) {
      return { valueStart: i, valueEnd: indexOfLineEnd(input, i), closeQuote: false };
    }
    return { valueStart: i + 1, valueEnd: close, closeQuote: true };
  }
  return { valueStart: i, valueEnd: scanUnquotedValueEnd(input, i), closeQuote: false };
}

function skipHorizontalSpace(input: string, index: number): number {
  let i = index;
  while (i < input.length && (input[i] === " " || input[i] === "\t")) i += 1;
  return i;
}

function indexOfLineEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i += 1) {
    if (input[i] === "\n" || input[i] === "\r") return i;
  }
  return input.length;
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

function scanUnquotedValueEnd(input: string, start: number): number {
  let quote: string | null = null;
  let i = start;
  while (i < input.length) {
    const char = input[i];
    if (quote) {
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      i += 1;
      continue;
    }
    if (char === "\n" || char === "\r") return i;
    if (char === ";") {
      if (semicolonContinuesSignedHeaders(input, i, input.slice(start, i))) {
        i += 1;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return i;
}

function semicolonContinuesSignedHeaders(
  input: string,
  semicolonIndex: number,
  valueSoFar: string,
): boolean {
  if (!currentParameterIsSignedHeaders(valueSoFar)) return false;
  let j = semicolonIndex + 1;
  while (j < input.length && (input[j] === " " || input[j] === "\t")) j += 1;
  if (j >= input.length) return true;
  const rest = input.slice(j);
  if (ASSIGNMENT_AFTER_SEMI.test(rest)) return false;
  return /^[A-Za-z0-9-]+/.test(rest);
}

function currentParameterIsSignedHeaders(valueSoFar: string): boolean {
  let quote: string | null = null;
  let segmentStart = 0;
  for (let i = 0; i < valueSoFar.length; i += 1) {
    const char = valueSoFar[i];
    if (quote) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") segmentStart = i + 1;
  }
  return /^SignedHeaders\s*=/i.test(valueSoFar.slice(segmentStart).trim());
}
