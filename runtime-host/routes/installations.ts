import { makeError } from "@shared/runtime/errors";
import {
  type InstallationDto,
  type InstallationsResponse,
  type ResolveProfileRequest,
  type ResolveProfileResponse,
  installationDtoSchema,
  installationsResponseSchema,
  resolveProfileRequestSchema,
  resolveProfileResponseSchema,
} from "@shared/runtime/schemas";
import { InstallationError, type InstallationRegistry } from "../installations/registry";
import type { ProfileProbe } from "../profiles/probe";
import { type HostServices, type Route, httpError } from "../server";

/**
 * Session-authenticated Installation inventory and dynamic Profile readiness.
 *
 * Reads require the session capability; the Profile readiness mutation
 * additionally requires Origin + CSRF. Revalidation is read-only metadata
 * work (no promotion, no spawn), so it stays at session level. Profile
 * readiness is dynamic: the route delegates to the profile probe, which runs
 * the same Driver handshake as execution on a throwaway driver and reports
 * failures as readiness states — never as fabricated bindings.
 */
export function installationRoutes(services: HostServices): Route[] {
  function registry(): InstallationRegistry {
    const value = services.installationRegistry as InstallationRegistry | undefined;
    if (!value) {
      throw httpError(
        500,
        makeError("INTERNAL", "discovery", "Installation registry is not configured."),
      );
    }
    return value;
  }

  function probe(): ProfileProbe {
    const value = services.profileProbe as ProfileProbe | undefined;
    if (!value) {
      throw httpError(500, makeError("INTERNAL", "prewarm", "Profile probe is not configured."));
    }
    return value;
  }

  function asHttpError(error: unknown): never {
    if (error instanceof InstallationError) {
      const code = error.runtimeError.code;
      const status =
        code === "INSTALLATION_NOT_FOUND" ? 404 : code === "INSTALLATION_CHANGED" ? 409 : 403;
      throw httpError(status, error.runtimeError);
    }
    throw error;
  }

  return [
    {
      method: "GET",
      pattern: "/api/v1/installations",
      auth: "session",
      responseSchema: installationsResponseSchema,
      handler: (): InstallationsResponse => ({ installations: registry().list() }),
    },
    {
      method: "POST",
      pattern: "/api/v1/installations/:installationId/revalidate",
      auth: "session",
      responseSchema: installationDtoSchema,
      handler: (ctx): InstallationDto => {
        try {
          const dto = registry().revalidate(ctx.params.installationId ?? "");
          // Probe cache keys referencing this installation go stale at once;
          // soft-skip when no probe is assembled (installation-only rigs).
          (services.profileProbe as ProfileProbe | undefined)?.invalidateInstallation?.(
            dto.installationId,
          );
          return dto;
        } catch (error) {
          asHttpError(error);
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/profiles/readiness",
      auth: "mutation",
      bodySchema: resolveProfileRequestSchema,
      responseSchema: resolveProfileResponseSchema,
      handler: async (ctx): Promise<ResolveProfileResponse> => {
        // bodySchema already rejected executable/argv/shell/env/token
        // injection with 400 BAD_REQUEST; only the typed DTO reaches here.
        const { profile, modelId } = ctx.body as ResolveProfileRequest;
        return probe().readiness(profile, modelId, {
          refresh: ctx.query.get("refresh") === "1",
        });
      },
    },
  ];
}
