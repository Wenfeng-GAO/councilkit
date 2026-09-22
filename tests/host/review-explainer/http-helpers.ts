import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "@host/config";
import { createLogger } from "@host/logging";
import { cliRunsRoutes } from "@host/routes/cli-runs";
import { healthRoutes } from "@host/routes/health";
import { createSessionCapability } from "@host/security/session-capability";
import { type HostServices, type Route, createRuntimeServer } from "@host/server";
import { DRIVER_IDS } from "@shared/runtime/contracts";
import { MODULES } from "../../review-explainer/contract";
import {
  FeatureMissingError,
  importFeature,
  requireExport,
} from "../../review-explainer/load-feature";

export interface ExplainerHttpHost {
  baseUrl: string;
  hostHeader: string;
  origin: string;
  csrf: string;
  cookie: string;
  home: string;
  headers(extra?: Record<string, string>): Record<string, string>;
  close(): Promise<void>;
}

export async function tryExplainerRoutes(
  services: HostServices,
): Promise<{ routes: Route[]; missing: string | null }> {
  try {
    const mod = await importFeature<Record<string, unknown>>(MODULES.hostRoutes);
    const factory = requireExport<(svc: HostServices) => Route[]>(
      mod,
      "reviewExplainerRoutes",
      MODULES.hostRoutes,
    );
    return { routes: factory(services), missing: null };
  } catch (error) {
    if (!(error instanceof FeatureMissingError)) throw error;
    return {
      routes: [],
      missing: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createExplainerHttpHost(opts: {
  home: string;
  /** Additive live-smoke option: serve the actual built UI without replacing it. */
  uiDistDir?: string;
  extraRoutes?: Route[];
  extraServices?: Record<string, unknown>;
}): Promise<ExplainerHttpHost> {
  const tempRoot = await mkdtemp(join(tmpdir(), "ck-explainer-http-"));
  const distDir = join(tempRoot, "dist");
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(
    join(distDir, "index.html"),
    '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>',
  );
  const logger = createLogger({ sink: () => undefined });
  const session = createSessionCapability();
  const config: HostConfig = {
    mode: "production",
    hostname: "127.0.0.1",
    port: 0,
    hostHeader: "127.0.0.1:0",
    distDir: opts.uiDistDir ?? distDir,
    watchdogProgram: join(tempRoot, "watchdog-child.mjs"),
    driverWorkRoot: join(tempRoot, "work"),
  };
  const services: HostServices = {
    config,
    logger,
    session,
    hostInstanceId: "review-explainer-http",
    startedAt: new Date().toISOString(),
    driverCapabilities: () =>
      DRIVER_IDS.map((driverId) => ({ driverId, capability: "ready" as const })),
    ...(opts.extraServices ?? {}),
  };
  const loaded = await tryExplainerRoutes(services);
  const routes: Route[] = [
    ...healthRoutes(services),
    ...cliRunsRoutes(services),
    ...loaded.routes,
    ...(opts.extraRoutes ?? []),
  ];
  const runtime = createRuntimeServer({ services, routes });
  await runtime.listen(0, "127.0.0.1");
  const addr = runtime.server.address() as AddressInfo | null;
  if (!addr || typeof addr.port !== "number") {
    await runtime.close().catch(() => undefined);
    throw new Error("INFRA_FAILURE: explainer HTTP host did not bind an ephemeral port");
  }
  if (addr.port === 43127) {
    await runtime.close().catch(() => undefined);
    throw new Error("INFRA_FAILURE: explainer HTTP host bound 43127");
  }
  config.port = addr.port;
  config.hostHeader = `127.0.0.1:${addr.port}`;
  const origin = `http://${config.hostHeader}`;
  const cookie = session.sessionCookieValue().split(";")[0] as string;
  return {
    baseUrl: origin,
    hostHeader: config.hostHeader,
    origin,
    csrf: session.csrfToken,
    cookie,
    home: opts.home,
    headers(extra = {}) {
      return {
        Host: config.hostHeader,
        Cookie: cookie,
        "x-councilkit-csrf": session.csrfToken,
        Origin: origin,
        "Content-Type": "application/json",
        ...extra,
      };
    },
    async close() {
      await runtime.close().catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
