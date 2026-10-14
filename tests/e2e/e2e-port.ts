import { CANONICAL_PORT } from "../../shared/runtime/contracts";
import { parseCanonicalInt } from "../../shared/runtime/decimal-int";

/**
 * Port the Playwright webServer binds. A padded value such as `043127` is
 * the canonical host with a leading zero, which is the collision this env
 * exists to avoid. Reject it instead of binding 43127.
 */
export function resolveE2ePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return CANONICAL_PORT;
  const port = parseCanonicalInt(raw);
  if (port === null || port < 1 || port > 65535) {
    throw new Error(`COUNCILKIT_E2E_PORT must be a valid TCP port, got "${raw}"`);
  }
  return port;
}
