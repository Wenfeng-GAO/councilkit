import { API_VERSION, DRIVER_IDS } from "@shared/runtime/contracts";
import { type HealthResponse, healthResponseSchema } from "@shared/runtime/schemas";
import type { HostServices, Route } from "../server";

/**
 * Minimal public health: version and driver capability states only.
 * Never returns paths, accounts, models or fingerprints.
 */
export function healthRoutes(services: HostServices): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/v1/health",
      auth: "public",
      responseSchema: healthResponseSchema,
      handler: (): HealthResponse => {
        const capabilityProvider = services.driverCapabilities as
          | (() => { driverId: string; capability: string }[])
          | undefined;
        const drivers =
          capabilityProvider?.() ??
          DRIVER_IDS.map((driverId) => ({ driverId, capability: "checking" as const }));
        return {
          apiVersion: API_VERSION,
          hostInstanceId: services.hostInstanceId,
          node: { version: process.version, major: Number.parseInt(process.version.slice(1), 10) },
          drivers: drivers as HealthResponse["drivers"],
        };
      },
    },
  ];
}
