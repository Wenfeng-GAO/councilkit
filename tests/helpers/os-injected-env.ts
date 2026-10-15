/**
 * Env keys the operating system itself adds to every exec'd process, even
 * when the parent passes an explicitly empty env. They are NOT inherited from
 * the parent, so env-isolation tests tolerate exactly these and nothing else.
 *
 * - __CF_USER_TEXT_ENCODING: injected by macOS (CoreFoundation) at exec.
 *
 * Keep this list minimal; adding a key here weakens the "child never inherits
 * parent env" guarantee (CI-01, verified on macos-latest).
 */
export const OS_INJECTED_ENV_KEYS: readonly string[] = ["__CF_USER_TEXT_ENCODING"];

/** Parse an `ENV <json>` line and drop only the allowlisted OS-injected keys. */
export function childEnvFromLine(line: string): Record<string, string> {
  if (!line.startsWith("ENV ")) throw new Error(`expected an ENV line, got: ${line}`);
  const env = JSON.parse(line.slice(4)) as Record<string, string>;
  for (const key of OS_INJECTED_ENV_KEYS) delete env[key];
  return env;
}
