import type { DriverId } from "@shared/runtime/contracts";
import type { InstallationDto, InstallationsResponse } from "@shared/runtime/schemas";
/**
 * Installation resolution (brief §2c, plan-a §4). The CLI never persists an
 * installationId: every doctor/models/run re-requests the installations list and
 * selects a `state === "trusted"` installation matching the Driver Selection's
 * `driverId`.
 *
 * Selection policy (D1):
 *  - zero trusted  → structured NO_TRUSTED_INSTALLATION error (exit 3 pre-run).
 *  - one           → use it.
 *  - many          → use the FIRST in the Host-returned array order and record
 *                    the candidate count + selected id in the output/metadata.
 */
import { errors } from "../errors";

export interface ResolvedInstallation {
  installationId: string;
  driverId: DriverId;
  /** How many trusted candidates matched; >1 means a non-deterministic pick. */
  trustedCandidateCount: number;
}

/** Filter installations to trusted ones for the requested driver, in Host order. */
export function trustedInstallationsFor(
  response: InstallationsResponse,
  driverId: DriverId,
): InstallationDto[] {
  return response.installations.filter(
    (dto) => dto.driverId === driverId && dto.state === "trusted",
  );
}

export function resolveInstallations(
  response: InstallationsResponse,
  driverId: DriverId,
): ResolvedInstallation {
  const trusted = trustedInstallationsFor(response, driverId);
  if (trusted.length === 0) {
    throw errors.hostUnavailable(
      `no trusted installation for driver "${driverId}" (install some software or run the browser once, then retry)`,
      { code: "NO_TRUSTED_INSTALLATION", driverId, trustedCandidates: 0 },
    );
  }
  const chosen = trusted[0];
  return {
    installationId: chosen.installationId,
    driverId: chosen.driverId,
    trustedCandidateCount: trusted.length,
  };
}

/** Build the per-driver list of candidate installations without picking, for
 * `models` (which probes each trusted installation). */
export function listTrusted(
  response: InstallationsResponse,
  driverId: DriverId,
): InstallationDto[] {
  return trustedInstallationsFor(response, driverId);
}
