import { randomUUID } from "node:crypto";
import type {
  ExecutionProfileDto,
  ParticipantSpec,
  ResolveProfileResponse,
} from "@shared/runtime/schemas";
import type { ParticipantDriver } from "../drivers/types";
import {
  InstallationError,
  type InstallationRecord,
  type InstallationRegistry,
} from "../installations/registry";
import type { Logger } from "../logging";
import { buildBinding, resolveStatic } from "./resolver";

/**
 * Dynamic Profile readiness probe. Runs the exact handshake execution uses —
 * `resolveStatic` → `assertExecutable` (fresh fingerprint revalidation) →
 * `driver.prewarm` → `buildBinding` — against a throwaway probe driver that
 * is always closed, so no CLI process can leak. The probe never touches
 * scopes, the execution registry or the reconciler, and nothing is cached in
 * V1: every call pays a fresh handshake. Composed once in `main.ts` (and in
 * tests) via `createProfileProbe`; the readiness route resolves it from
 * `services.profileProbe`.
 */

export interface ProfileProbeDeps {
  installations: InstallationRegistry;
  /** Same composed per-driver factories the scope manager receives. */
  driverFactories: Record<string, (participantId: string) => ParticipantDriver>;
  logger: Logger;
}

export interface ProfileProbe {
  readiness(profile: ExecutionProfileDto, modelId: string): Promise<ResolveProfileResponse>;
}

const MAX_DETAIL = 256;

export function createProfileProbe(deps: ProfileProbeDeps): ProfileProbe {
  const { installations, driverFactories, logger } = deps;

  function installationGateError(error: InstallationError): ResolveProfileResponse {
    const code = error.runtimeError.code;
    return {
      readiness: {
        // Drift detected by the fresh revalidation (or a vanished installation)
        // invalidates the static binding; anything else (e.g. untrusted) means
        // the runtime cannot serve it right now.
        state:
          code === "INSTALLATION_CHANGED" || code === "INSTALLATION_NOT_FOUND"
            ? "invalid_binding"
            : "runtime_unavailable",
        detail: error.message.slice(0, MAX_DETAIL),
      },
      binding: null,
    };
  }

  async function readiness(
    profile: ExecutionProfileDto,
    modelId: string,
  ): Promise<ResolveProfileResponse> {
    // Static gate first: schema-valid DTO + trusted installation, no spawn.
    const staticResolution = resolveStatic(profile, modelId, installations);
    if (!staticResolution.installation || staticResolution.readiness.state !== "ready") {
      return { readiness: staticResolution.readiness, binding: null };
    }

    // Same spawn gate as execution: fresh fingerprint revalidation.
    let installation: InstallationRecord;
    try {
      installation = installations.assertExecutable(staticResolution.installation.installationId);
    } catch (error) {
      if (error instanceof InstallationError) return installationGateError(error);
      throw error;
    }

    const factory = driverFactories[profile.driverId];
    if (!factory) {
      return {
        readiness: {
          state: "runtime_unavailable",
          detail: `No driver factory is registered for "${profile.driverId}".`,
        },
        binding: null,
      };
    }

    const participantId = `probe-${randomUUID()}`;
    const spec: ParticipantSpec = { participantId, profile, modelId };
    const driver = factory(participantId);
    try {
      const prewarm = await driver.prewarm({ participantId, spec, installation });
      return buildBinding(spec, installation, prewarm);
    } catch (error) {
      // Same mapping as the scope manager: driver-reported unavailability
      // becomes a readiness state, never an HTTP error.
      const runtimeCode = (error as { runtimeCode?: string }).runtimeCode;
      logger.warn("profile.probe_failed", {
        driverId: profile.driverId,
        code: runtimeCode ?? "UNKNOWN",
      });
      return {
        readiness: {
          state: runtimeCode === "MODEL_UNAVAILABLE" ? "model_unavailable" : "runtime_unavailable",
          detail: error instanceof Error ? error.message.slice(0, MAX_DETAIL) : "prewarm failed",
        },
        binding: null,
      };
    } finally {
      // Best effort: a probe must never leak a CLI process.
      await driver.close().catch(() => undefined);
    }
  }

  return { readiness };
}
