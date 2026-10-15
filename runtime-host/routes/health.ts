import { type HealthResponse, healthResponseSchema } from "@shared/runtime/schemas";
import { composeHealthResponse } from "../cli-state";
import type { HostServices, Route } from "../server";

/**
 * Public health: version, Host checkout path, and per-driver CLI state.
 * No accounts, models or fingerprints. `?refresh=1` restarts CLI probes.
 */
export function healthRoutes(services: HostServices): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/v1/health",
      auth: "public",
      responseSchema: healthResponseSchema,
      handler: (ctx): HealthResponse =>
        composeHealthResponse(services, { refresh: ctx.query.get("refresh") === "1" }),
    },
  ];
}
