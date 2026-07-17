import { randomUUID } from "node:crypto";
import type { DriverId } from "@shared/runtime/contracts";
import type {
  ClaudeRoute,
  ExecutionProfileDto,
  ModelCatalogResponse,
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
 * tests) via `createProfileProbe`; the readiness and model-catalog routes
 * resolve it from `services.profileProbe`.
 */

export interface ProfileProbeDeps {
  installations: InstallationRegistry;
  /** Same composed per-driver factories the scope manager receives. */
  driverFactories: Record<string, (participantId: string) => ParticipantDriver>;
  logger: Logger;
}

export interface ProfileProbe {
  readiness(profile: ExecutionProfileDto, modelId: string): Promise<ResolveProfileResponse>;
  /**
   * Closed canonical model catalog of a trusted installation's driver. The
   * catalog is model-agnostic, so the probe prewarms with a placeholder
   * modelId and returns `prewarm.catalog` verbatim. For claude-stream-json
   * the catalog is route-specific — pass the profile's `route` (defaults to
   * `ant-glm5.2`). A driver whose handshake validates the requested model
   * (codex) rejects the placeholder with MODEL_UNAVAILABLE carrying the
   * served catalog — the probe returns that catalog, which is exactly the
   * data the choose-model repair path needs. Throws `InstallationError`
   * (unknown/changed/untrusted installation) or an Error carrying
   * `runtimeCode` for other handshake failures — the route maps those to
   * HTTP errors; a catalog is never fabricated.
   */
  catalog(
    driverId: DriverId,
    installationId: string,
    route?: ClaudeRoute,
  ): Promise<ModelCatalogResponse>;
}

const MAX_DETAIL = 256;

/** Placeholder modelId for the model-agnostic catalog handshake. */
const CATALOG_PROBE_MODEL_ID = "__catalog__";

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

  /**
   * Shared static gate + fresh fingerprint revalidation + probe driver
   * construction. Throws `InstallationError` on any installation gate failure
   * and `Error` when no factory is registered for the driver.
   */
  function gateProbeDriver(
    profile: ExecutionProfileDto,
    modelId: string,
  ): { driver: ParticipantDriver; installation: InstallationRecord; spec: ParticipantSpec } {
    const staticResolution = resolveStatic(profile, modelId, installations);
    if (!staticResolution.installation || staticResolution.readiness.state !== "ready") {
      throw new InstallationError(
        staticResolution.readiness.state === "invalid_binding"
          ? {
              code: "INSTALLATION_NOT_FOUND",
              phase: "discovery",
              retryable: false,
              message: staticResolution.readiness.detail ?? "static binding failed",
            }
          : {
              code: "INSTALLATION_UNTRUSTED",
              phase: "discovery",
              retryable: false,
              message: staticResolution.readiness.detail ?? "installation is not trusted",
            },
      );
    }

    // Same spawn gate as execution: fresh fingerprint revalidation.
    const installation = installations.assertExecutable(
      staticResolution.installation.installationId,
    );

    const factory = driverFactories[profile.driverId];
    if (!factory) {
      throw new Error(`No driver factory is registered for "${profile.driverId}".`);
    }

    const participantId = `probe-${randomUUID()}`;
    const spec: ParticipantSpec = { participantId, profile, modelId };
    return { driver: factory(participantId), installation, spec };
  }

  async function readiness(
    profile: ExecutionProfileDto,
    modelId: string,
  ): Promise<ResolveProfileResponse> {
    // Static gate first: schema-valid DTO + trusted installation, no spawn.
    let gated: ReturnType<typeof gateProbeDriver>;
    try {
      gated = gateProbeDriver(profile, modelId);
    } catch (error) {
      if (error instanceof InstallationError) return installationGateError(error);
      // No registered factory: a runtime gap, not an HTTP error.
      return {
        readiness: {
          state: "runtime_unavailable",
          detail: error instanceof Error ? error.message.slice(0, MAX_DETAIL) : "probe failed",
        },
        binding: null,
      };
    }

    const { driver, installation, spec } = gated;
    try {
      const prewarm = await driver.prewarm({
        participantId: spec.participantId,
        spec,
        installation,
      });
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

  async function catalog(
    driverId: DriverId,
    installationId: string,
    route?: ClaudeRoute,
  ): Promise<ModelCatalogResponse> {
    // Catalog needs no real profile options beyond the claude route; the
    // schema-valid minimal DTO only carries the binding target.
    const profile: ExecutionProfileDto =
      driverId === "claude-stream-json"
        ? {
            driverId,
            installationId,
            credentialMode: "installation-managed",
            options: { route: route ?? "ant-glm5.2" },
          }
        : {
            driverId,
            installationId,
            credentialMode: "installation-managed",
            options: {},
          };
    const { driver, installation, spec } = gateProbeDriver(profile, CATALOG_PROBE_MODEL_ID);
    try {
      const prewarm = await driver.prewarm({
        participantId: spec.participantId,
        spec,
        installation,
      });
      return { catalog: prewarm.catalog };
    } catch (error) {
      // A model-validating handshake (codex) rejects the placeholder but
      // attaches the served catalog — that catalog IS the answer.
      const served = (error as { catalog?: unknown }).catalog;
      if (
        (error as { runtimeCode?: string }).runtimeCode === "MODEL_UNAVAILABLE" &&
        Array.isArray(served) &&
        served.length > 0
      ) {
        return { catalog: served as string[] };
      }
      throw error;
    } finally {
      // Best effort: a probe must never leak a CLI process.
      await driver.close().catch(() => undefined);
    }
  }

  return { readiness, catalog };
}
