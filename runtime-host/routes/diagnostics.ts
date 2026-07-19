import { API_VERSION, DRIVER_IDS } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import {
  type DiagnosticsResponse,
  type HealthResponse,
  diagnosticsResponseSchema,
} from "@shared/runtime/schemas";
import type { InstallationRegistry } from "../installations/registry";
import type { ScopeManager } from "../scopes/scope-manager";
import { type HostServices, type Route, httpError } from "../server";

/**
 * Diagnostics export (S6): a single-JSON, same-machine operator bundle for
 * self-diagnosis. Sanitized by construction — it NEVER carries prompts, model
 * output, tokens, cookies, secrets or env dumps; Host config paths
 * (distDir/watchdogProgram/driverWorkRoot) stay out. Installations keep their
 * realpaths by explicit decision (Q10): same-machine user data the operator
 * needs to verify CLI discovery. Log lines come from the logger problems
 * ring, where every string was already sanitized at write time.
 */
export function diagnosticsRoutes(services: HostServices): Route[] {
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

  function scopes(): ScopeManager {
    const value = services.scopeManager as ScopeManager | undefined;
    if (!value) {
      throw httpError(500, makeError("INTERNAL", "bootstrap", "Scope manager is not configured."));
    }
    return value;
  }

  return [
    {
      method: "GET",
      pattern: "/api/v1/diagnostics",
      auth: "session",
      responseSchema: diagnosticsResponseSchema,
      handler: (): DiagnosticsResponse => {
        const capabilityProvider = services.driverCapabilities as
          | (() => { driverId: string; capability: string }[])
          | undefined;
        const drivers =
          capabilityProvider?.() ??
          DRIVER_IDS.map((driverId) => ({ driverId, capability: "checking" as const }));
        const node = {
          version: process.version,
          major: Number.parseInt(process.version.slice(1), 10),
        };
        const startedAtMs = Date.parse(services.startedAt);
        const uptimeMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
        return {
          generatedAt: new Date().toISOString(),
          health: {
            apiVersion: API_VERSION,
            hostInstanceId: services.hostInstanceId,
            node,
            drivers: drivers as HealthResponse["drivers"],
          },
          config: {
            mode: services.config.mode,
            port: services.config.port,
            node,
            startedAt: services.startedAt,
            uptimeMs,
          },
          installations: registry().list(),
          scopes: scopes().counts(),
          logs: { recent: [...services.logger.recentProblems(50)] },
        };
      },
    },
  ];
}
