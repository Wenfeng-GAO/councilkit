/**
 * A git positional taken from outside this process.
 * Git treats a leading "-" as an option. `git clone` and `git ls-remote`
 * execute `--upload-pack=<path>` when that string sits in the repository slot.
 */
export const GIT_POSITIONAL_MAX_CHARS = 4096;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function gitPositional(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > GIT_POSITIONAL_MAX_CHARS) return null;
  if (value.startsWith("-")) return null;
  if (hasControlChar(value)) return null;
  return value;
}
