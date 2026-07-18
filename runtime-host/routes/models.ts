import { DRIVER_IDS, type DriverId } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import {
  type ModelCatalogResponse,
  claudeRouteSchema,
  modelCatalogResponseSchema,
} from "@shared/runtime/schemas";
import { InstallationError } from "../installations/registry";
import type { ProfileProbe } from "../profiles/probe";
import { type HostServices, type Route, httpError } from "../server";

/**
 * Model catalog (U6): the closed canonical model set a Driver reports for one
 * trusted Installation. Settings uses it as the only modelId source for Agent
 * forms — model catalogs come from the live Driver handshake, never from
 * user-typed strings. Session-authenticated read: no mutation, no CSRF. The
 * claude catalog is route-specific; pass `route` for those profiles.
 */
export function modelRoutes(services: HostServices): Route[] {
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
    const runtimeCode = (error as { runtimeCode?: string } | null)?.runtimeCode;
    if (runtimeCode === "MODEL_UNAVAILABLE" || runtimeCode === "INCOMPATIBLE_DRIVER") {
      throw httpError(
        409,
        makeError(
          runtimeCode,
          "prewarm",
          error instanceof Error ? error.message.slice(0, 256) : "catalog handshake failed",
        ),
      );
    }
    if (runtimeCode === "AUTH_REQUIRED") {
      throw httpError(
        403,
        makeError(
          runtimeCode,
          "prewarm",
          error instanceof Error ? error.message.slice(0, 256) : "driver login required",
        ),
      );
    }
    throw error;
  }

  return [
    {
      method: "GET",
      pattern: "/api/v1/models/catalog",
      auth: "session",
      responseSchema: modelCatalogResponseSchema,
      handler: async (ctx): Promise<ModelCatalogResponse> => {
        const driverId = ctx.query.get("driverId") ?? "";
        const installationId = ctx.query.get("installationId") ?? "";
        const routeRaw = ctx.query.get("route");
        const routeParsed = routeRaw === null ? undefined : claudeRouteSchema.safeParse(routeRaw);
        if (
          !(DRIVER_IDS as readonly string[]).includes(driverId) ||
          installationId.length < 1 ||
          (routeRaw !== null && !routeParsed?.success)
        ) {
          throw httpError(
            400,
            makeError(
              "BAD_REQUEST",
              "security",
              "Query requires a valid driverId, a non-empty installationId and an optional valid route.",
            ),
          );
        }
        try {
          return await probe().catalog(
            driverId as DriverId,
            installationId,
            routeParsed?.success ? routeParsed.data : undefined,
            { refresh: ctx.query.get("refresh") === "1" },
          );
        } catch (error) {
          asHttpError(error);
        }
      },
    },
  ];
}
