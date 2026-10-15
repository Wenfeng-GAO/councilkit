import { DRIVER_IDS, type DriverId } from "@shared/runtime/contracts";
import { type HealthResponse, healthResponseSchema } from "@shared/runtime/schemas";
import { composeHealthResponse } from "../cli-state";
import type { HostServices, Route } from "../server";

/**
 * Public health: version, Host checkout path, and per-driver CLI state.
 * No accounts, models or fingerprints. `?refresh=1` restarts CLI probes;
 * `?refresh=1&driver=<driverId>` restarts only that row (#321). An unknown
 * `driver` refreshes nothing rather than every row.
 */
export function healthRoutes(services: HostServices): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/v1/health",
      auth: "public",
      responseSchema: healthResponseSchema,
      handler: (ctx): HealthResponse => {
        const refresh = ctx.query.get("refresh") === "1";
        const driver = ctx.query.get("driver");
        if (refresh && driver !== null) {
          if (!(DRIVER_IDS as readonly string[]).includes(driver)) {
            return composeHealthResponse(services);
          }
          return composeHealthResponse(services, {
            refresh: true,
            refreshDriverId: driver as DriverId,
          });
        }
        return composeHealthResponse(services, { refresh });
      },
    },
  ];
}
