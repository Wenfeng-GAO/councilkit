import { DRIVER_IDS, type DriverId } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import { type ModelCatalogResponse, modelCatalogResponseSchema } from "@shared/runtime/schemas";
import { InstallationError } from "../installations/registry";
import type { ProfileProbe } from "../profiles/probe";
import { type HostServices, type Route, httpError } from "../server";

/**
 * Model catalog (U6): the closed canonical model set a Driver reports for one
 * trusted Installation. Settings uses it as the only modelId source for Agent
 * forms — model catalogs come from the live Driver handshake, never from
 * user-typed strings. Session-authenticated read: no mutation, no CSRF.
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
        if (!(DRIVER_IDS as readonly string[]).includes(driverId) || installationId.length < 1) {
          throw httpError(
            400,
            makeError(
              "BAD_REQUEST",
              "security",
              "Query requires a valid driverId and a non-empty installationId.",
            ),
          );
        }
        try {
          return await probe().catalog(driverId as DriverId, installationId);
        } catch (error) {
          asHttpError(error);
        }
      },
    },
  ];
}
