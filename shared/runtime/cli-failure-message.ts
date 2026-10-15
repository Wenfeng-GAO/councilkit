/**
 * Message from a councilkit CLI `--json` failure.
 *
 * `execFile` rejects with the child stdout when the process exits non-zero.
 * Those failures are `{ error: { message } }`. Anything else is null so the
 * caller can use its own fallback.
 */
export function cliFailureMessage(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("stdout" in error)) return null;
  const stdout = String(error.stdout).trim();
  if (stdout.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const message = (parsed as { error?: { message?: unknown } }).error?.message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}
