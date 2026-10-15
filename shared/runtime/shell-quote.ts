/**
 * POSIX single quotes for a shell token.
 *
 * Resume commands and repair export commands use this same spelling.
 * An embedded single quote is the standard `'\''` sequence. `$` stays literal.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
