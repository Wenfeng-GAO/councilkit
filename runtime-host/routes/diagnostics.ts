import { makeError } from "@shared/runtime/errors";
import { type DiagnosticsResponse, diagnosticsResponseSchema } from "@shared/runtime/schemas";
import { composeHealthResponse } from "../cli-state";
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
        const health = composeHealthResponse(services);
        const startedAtMs = Date.parse(services.startedAt);
        const uptimeMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
        return {
          generatedAt: new Date().toISOString(),
          health,
          config: {
            mode: services.config.mode,
            port: services.config.port,
            node: health.node,
            startedAt: services.startedAt,
            uptimeMs,
          },
          installations: registry().list(),
          scopes: scopes().counts(),
          logs: {
            recent: [...services.logger.recentProblems(50)],
            diagnostics: [...services.logger.diagnostics()],
          },
        };
      },
    },
  ];
}
