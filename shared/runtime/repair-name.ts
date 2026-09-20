/** Closed-set local profile id. Safe for browser bundles. */
export function isRepairProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}
