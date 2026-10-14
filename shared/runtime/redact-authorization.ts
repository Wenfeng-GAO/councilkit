/**
 * An Authorization field value runs to the next header separator, not to the
 * first word. `Basic <token>` and `Digest username="…", response="…"` both
 * put the credential after a scheme word. Callers that keep only `\S+` store
 * the scheme and leave the secret in logs and exports.
 *
 * Newlines are not a reliable separator: the host logger strips C0 controls,
 * including `\n`, before redaction, so two headers can arrive as one line.
 * `;` is the separator these logs already use between assignments.
 */
const HEADER_FIELD = /\b((?:proxy-)?authorization)\b(\s*[:=]\s*)[^\r\n;]*/gi;
const BASIC_CREDENTIAL = /\bBasic\s+[A-Za-z0-9+/=._-]+/gi;

export function redactAuthorizationMaterial(input: string, placeholder: string): string {
  const header = input.replace(HEADER_FIELD, (_match, key: string, separator: string) => {
    return `${key}${separator}${placeholder}`;
  });
  return header.replace(BASIC_CREDENTIAL, () => `Basic ${placeholder}`);
}
