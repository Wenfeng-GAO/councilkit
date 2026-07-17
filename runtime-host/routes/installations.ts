import { makeError } from "@shared/runtime/errors";
import {
  type InstallationDto,
  type InstallationsResponse,
  type ProfileReadiness,
  type ResolveProfileRequest,
  type ResolveProfileResponse,
  installationDtoSchema,
  installationsResponseSchema,
  resolveProfileRequestSchema,
  resolveProfileResponseSchema,
} from "@shared/runtime/schemas";
import { InstallationError, type InstallationRegistry } from "../installations/registry";
import { assessProfileStatic } from "../profiles/readiness";
import { type HostServices, type Route, httpError } from "../server";

/**
 * Session-authenticated Installation inventory and static Profile readiness.
 *
 * Reads require the session capability; the Profile readiness mutation
 * additionally requires Origin + CSRF. Revalidation is read-only metadata
 * work (no promotion, no spawn), so it stays at session level. U2 never
 * fabricates a ResolvedBinding and never reports final readiness: the dynamic
 * driver handshake and binding digest land in U3.
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
          return registry().revalidate(ctx.params.installationId ?? "");
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
      handler: (ctx): ResolveProfileResponse => {
        // bodySchema already rejected executable/argv/shell/env/token
        // injection with 400 BAD_REQUEST; only the typed DTO reaches here.
        const { profile } = ctx.body as ResolveProfileRequest;
        const staticPart = assessProfileStatic(profile, registry());
        const readiness: ProfileReadiness =
          staticPart.state === "ready"
            ? { state: "runtime_unavailable", detail: "dynamic driver handshake required (U3)" }
            : { state: staticPart.state, detail: staticPart.detail };
        return { readiness, binding: null };
      },
    },
  ];
}
