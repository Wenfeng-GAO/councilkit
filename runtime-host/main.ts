import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  DRIVER_IDS,
  type DriverCapabilityState,
  type DriverId,
  TIMEOUTS,
} from "@shared/runtime/contracts";
import { checkNodeVersion, loadConfig } from "./config";
import { createClaudeStreamJsonDriver } from "./drivers/claude-stream-json";
import { createCodexAppServerDriver } from "./drivers/codex-app-server";
import type { DriverDeps, ParticipantDriver, PrewarmInput, PrewarmResult } from "./drivers/types";
import { createExecutionRegistry } from "./executions/execution-registry";
import { createInstallationRegistry } from "./installations/registry";
import { createLogger } from "./logging";
import { createProcessSupervisor } from "./process/process-supervisor";
import { createProfileProbe } from "./profiles/probe";
import { healthRoutes } from "./routes/health";
import { installationRoutes } from "./routes/installations";
import { scopeRoutes } from "./routes/scopes";
import { createScopeManager } from "./scopes/scope-manager";
import { createSessionReconciler } from "./scopes/session-reconciler";
import { createSessionCapability } from "./security/session-capability";
import { type HostServices, type Route, createRuntimeServer } from "./server";

/**
 * CouncilKit Runtime Host entry point.
 *
 * Foreground Node.js 22 process serving the Web UI and the same-origin
 * /api/v1 from the fixed canonical origin. Startup failures (wrong Node
 * version, occupied port) are structured and fatal — the origin never moves.
 */

/** Tracks the latest live handshake outcome per driver for the health surface. */
function withCapabilityTracking(
  capabilityByDriver: Map<DriverId, DriverCapabilityState>,
  driverId: DriverId,
  factory: (participantId: string) => ParticipantDriver,
): (participantId: string) => ParticipantDriver {
  return (participantId: string): ParticipantDriver => {
    const driver = factory(participantId);
    const prewarm = driver.prewarm.bind(driver);
    driver.prewarm = async (input: PrewarmInput): Promise<PrewarmResult> => {
      try {
        const result = await prewarm(input);
        capabilityByDriver.set(driverId, driver.capabilityState());
        return result;
      } catch (error) {
        const code = (error as { runtimeCode?: string }).runtimeCode;
        capabilityByDriver.set(
          driverId,
          code === "AUTH_REQUIRED"
            ? "auth_required"
            : code === "INCOMPATIBLE_DRIVER"
              ? "incompatible"
              : "checking",
        );
        throw error;
      }
    };
    return driver;
  };
}

async function main(): Promise<void> {
  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: nodeCheck.error })}\n`);
    process.exit(1);
  }

  const config = loadConfig();
  const logger = createLogger();
  const session = createSessionCapability();
  const hostInstanceId = randomUUID();

  const supervisor = createProcessSupervisor({ config, logger });
  const installations = createInstallationRegistry({ logger });
  const executions = createExecutionRegistry({ logger });
  const reconciler = createSessionReconciler();

  const driverDeps: DriverDeps = {
    supervisor,
    logger,
    timeouts: TIMEOUTS,
    workRoot: config.driverWorkRoot,
  };
  const capabilityByDriver = new Map<DriverId, DriverCapabilityState>();
  const driverFactories = {
    "claude-stream-json": withCapabilityTracking(
      capabilityByDriver,
      "claude-stream-json",
      createClaudeStreamJsonDriver(driverDeps),
    ),
    "codex-app-server": withCapabilityTracking(
      capabilityByDriver,
      "codex-app-server",
      createCodexAppServerDriver(driverDeps),
    ),
  };

  const scopeManager = createScopeManager({
    installations,
    executions,
    reconciler,
    driverFactories,
    logger,
    hostInstanceId,
  });

  // Dynamic Profile readiness: same factories/handshake as execution.
  const profileProbe = createProfileProbe({ installations, driverFactories, logger });

  const services: HostServices = {
    config,
    logger,
    session,
    hostInstanceId,
    startedAt: new Date().toISOString(),
    installationRegistry: installations,
    executionRegistry: executions,
    scopeManager,
    profileProbe,
    driverCapabilities: () =>
      DRIVER_IDS.map((driverId) => ({
        driverId,
        capability: capabilityByDriver.get(driverId) ?? ("checking" as const),
      })),
  };

  const routes: Route[] = [
    ...healthRoutes(services),
    ...installationRoutes(services),
    ...scopeRoutes(services),
  ];

  let viteMiddlewares:
    | ((req: IncomingMessage, res: ServerResponse, next: () => void) => void)
    | undefined;
  let transformIndexHtml: ((url: string, html: string) => Promise<string>) | undefined;
  let viteDevServer: { close(): Promise<void> } | undefined;

  if (config.mode === "development") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
      root: resolve("."),
    });
    viteDevServer = vite;
    viteMiddlewares = vite.middlewares as unknown as typeof viteMiddlewares;
    transformIndexHtml = (url, html) => vite.transformIndexHtml(url, html);
  }

  const runtime = createRuntimeServer({
    services,
    routes,
    viteMiddlewares,
    transformIndexHtml,
    indexHtmlPath: resolve("index.html"),
  });

  try {
    await runtime.listen();
  } catch (error) {
    const structured =
      error instanceof Error && "runtimeError" in error
        ? (error as { runtimeError: unknown }).runtimeError
        : { code: "INTERNAL", message: String(error) };
    process.stderr.write(`${JSON.stringify({ ok: false, error: structured })}\n`);
    process.exit(1);
  }

  logger.info("host.started", {
    mode: config.mode,
    hostInstanceId: services.hostInstanceId,
    port: config.port,
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info("host.shutdown", { signal });
    void (async () => {
      await scopeManager.closeAll("host-shutdown").catch(() => undefined);
      await supervisor.shutdownAll().catch(() => undefined);
      await viteDevServer?.close().catch(() => undefined);
      await runtime.close().catch(() => undefined);
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
