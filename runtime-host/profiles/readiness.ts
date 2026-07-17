import type { DriverCapabilityState } from "@shared/runtime/contracts";
import type {
  ExecutionProfileDto,
  InstallationDto,
  ProfileReadiness,
} from "@shared/runtime/schemas";

/**
 * Static Execution Profile readiness: schema-validated profile + Installation
 * lookup only. No protocol handshake happens in this layer — the final
 * readiness combines this static part with the U3 driver capability via
 * `combineProfileReadiness`. This module is pure (no node imports) so the
 * browser-side tests can exercise the same combination logic.
 */

/** Minimal structural view of the Installation registry (keeps this module pure). */
export interface InstallationLookup {
  get(installationId: string): InstallationDto | undefined;
}

export interface StaticProfileReadiness {
  state: "ready" | "invalid_binding" | "runtime_unavailable";
  detail: string | null;
}

const MAX_ID_IN_DETAIL = 64;

function cleanId(value: string): string {
  return value.replace(/[^ -~]/g, "?").slice(0, MAX_ID_IN_DETAIL);
}

/** Static part only: `model_unavailable` needs the U3 catalog and never occurs here. */
export function assessProfileStatic(
  profile: ExecutionProfileDto,
  registry: InstallationLookup,
): StaticProfileReadiness {
  const installation = registry.get(profile.installationId);
  if (!installation) {
    return {
      state: "invalid_binding",
      detail: `Profile references unknown installation "${cleanId(profile.installationId)}".`,
    };
  }
  if (installation.driverId !== profile.driverId) {
    return {
      state: "invalid_binding",
      detail: `Profile driver "${profile.driverId}" does not match installation driver "${installation.driverId}".`,
    };
  }
  if (installation.state !== "trusted") {
    return {
      state: "runtime_unavailable",
      detail: `Installation is ${installation.state}; a trusted installation is required.`,
    };
  }
  return {
    state: "ready",
    detail: "Static binding is valid; the dynamic driver handshake is still required.",
  };
}

/**
 * Final readiness = static binding + driver capability + model catalog.
 * A failed/pending driver capability (`checking`, `auth_required`,
 * `incompatible`) means the runtime is unavailable; an unknown model maps to
 * `model_unavailable`; only a ready static part, a ready driver and a known
 * model yield `ready`.
 */
export function combineProfileReadiness(
  staticPart: StaticProfileReadiness,
  driverCapability: DriverCapabilityState,
  modelKnown: boolean,
): ProfileReadiness {
  if (staticPart.state !== "ready") {
    return { state: staticPart.state, detail: staticPart.detail };
  }
  if (driverCapability !== "ready") {
    return {
      state: "runtime_unavailable",
      detail: `Driver capability is ${driverCapability}, not ready.`,
    };
  }
  if (!modelKnown) {
    return {
      state: "model_unavailable",
      detail: "Selected modelId is not in the driver model catalog.",
    };
  }
  return { state: "ready", detail: null };
}
