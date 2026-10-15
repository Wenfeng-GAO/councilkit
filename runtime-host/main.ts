import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  DRIVER_IDS,
  type DriverCapabilityState,
  type DriverId,
  TIMEOUTS,
} from "@shared/runtime/contracts";
import { slowGenFromEnv } from "@shared/runtime/slow-gen";
import { checkNodeVersion, loadConfig } from "./config";
import { createClaudeStreamJsonDriver } from "./drivers/claude-stream-json";
import { createCodexAppServerDriver } from "./drivers/codex-app-server";
import { createCursorStreamJsonDriver } from "./drivers/cursor-stream-json";
import { createGrokStreamJsonDriver } from "./drivers/grok-stream-json";
import { createKimiStreamJsonDriver } from "./drivers/kimi-stream-json";
import type { DriverDeps, ParticipantDriver, PrewarmInput, PrewarmResult } from "./drivers/types";
import { createExecutionRegistry } from "./executions/execution-registry";
import { createInstallationRegistry } from "./installations/registry";
import { createLogger } from "./logging";
import { createProcessSupervisor } from "./process/process-supervisor";
import { createProfileProbe } from "./profiles/probe";
import { repairObservationRoutes } from "./repair-observation/routes";
import { cliRunsRoutes } from "./routes/cli-runs";
import { diagnosticsRoutes } from "./routes/diagnostics";
import { healthRoutes } from "./routes/health";
import { installationRoutes } from "./routes/installations";
import { modelRoutes } from "./routes/models";
import { productJuryRoutes } from "./routes/product-jury";
import { reviewExplainerRoutes } from "./routes/review-explainer";
import { reviewJuryRoutes } from "./routes/review-jury";
import { scopeRoutes } from "./routes/scopes";
import { createScopeManager } from "./scopes/scope-manager";
import { createSessionReconciler } from "./scopes/session-reconciler";
import { createSessionCapability } from "./security/session-capability";
import { type HostServices, type Route, createRuntimeServer } from "./server";
import { createSlowGenDriverFactory, slowGenDiscovery, slowGenValidate } from "./slow-gen";

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
  // Test-only QA switch (B4 #279): synthetic trusted installations + fake
  // drivers that slow down only the report turn. Never in --help or the UI.
  const slowGen = slowGenFromEnv();
  if (slowGen) {
    logger.warn("host.slow_gen", { mode: slowGen.mode, intervalMs: slowGen.intervalMs });
    process.stderr.write(
      `[councilkit] COUNCILKIT_SLOW_GEN=${slowGen.mode} (${slowGen.intervalMs}ms): test-only fake models, every run is 示例/demo\n`,
    );
  }
  const installations = createInstallationRegistry(
    slowGen ? { logger, discover: slowGenDiscovery, validate: slowGenValidate } : { logger },
  );
  const executions = createExecutionRegistry({ logger });
  const reconciler = createSessionReconciler();

  // Test-only: shrink the no-progress window (e2e screenshots, QA dry runs).
  const idleOverride = Number(process.env.COUNCILKIT_STREAM_IDLE_MS);
  const timeouts = {
    ...TIMEOUTS,
    ...(Number.isFinite(idleOverride) && idleOverride > 0 ? { streamIdleMs: idleOverride } : {}),
  };
  const driverDeps: DriverDeps = {
    supervisor,
    logger,
    timeouts,
    workRoot: config.driverWorkRoot,
  };
  const capabilityByDriver = new Map<DriverId, DriverCapabilityState>();
  const pick = (
    driverId: DriverId,
    real: (deps: DriverDeps) => (participantId: string) => ParticipantDriver,
  ) => (slowGen ? createSlowGenDriverFactory(driverId, slowGen, timeouts) : real(driverDeps));
  const driverFactories = {
    "claude-stream-json": withCapabilityTracking(
      capabilityByDriver,
      "claude-stream-json",
      pick("claude-stream-json", createClaudeStreamJsonDriver),
    ),
    "codex-app-server": withCapabilityTracking(
      capabilityByDriver,
      "codex-app-server",
      pick("codex-app-server", createCodexAppServerDriver),
    ),
    "kimi-stream-json": withCapabilityTracking(
      capabilityByDriver,
      "kimi-stream-json",
      pick("kimi-stream-json", createKimiStreamJsonDriver),
    ),
    "grok-stream-json": withCapabilityTracking(
      capabilityByDriver,
      "grok-stream-json",
      pick("grok-stream-json", createGrokStreamJsonDriver),
    ),
    "cursor-stream-json": withCapabilityTracking(
      capabilityByDriver,
      "cursor-stream-json",
      pick("cursor-stream-json", createCursorStreamJsonDriver),
    ),
  };

  const scopeManager = createScopeManager({
    installations,
    executions,
    reconciler,
    driverFactories,
    logger,
    hostInstanceId,
    idleScopeTtlMs: config.idleScopeTtlMs,
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
    ...modelRoutes(services),
    ...scopeRoutes(services),
    ...diagnosticsRoutes(services),
    ...cliRunsRoutes(services),
    ...reviewExplainerRoutes(services),
    ...repairObservationRoutes(),
    ...reviewJuryRoutes(),
    ...productJuryRoutes(),
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
