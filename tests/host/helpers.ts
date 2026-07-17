import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "@host/config";
import { type Logger, createLogger } from "@host/logging";
import { healthRoutes } from "@host/routes/health";
import { type SessionCapability, createSessionCapability } from "@host/security/session-capability";
import {
  type HostServices,
  type Route,
  type RuntimeServer,
  createRuntimeServer,
} from "@host/server";
import { CANONICAL_HOST_HEADER, CANONICAL_PORT } from "@shared/runtime/contracts";

export interface TestHost {
  runtime: RuntimeServer;
  services: HostServices;
  session: SessionCapability;
  logger: Logger;
  logLines: string[];
  baseUrl: string;
  cleanup(): Promise<void>;
}

export interface TestHostOptions {
  mode?: "development" | "production";
  routes?: Route[];
  /** Routes that need the assembled services object (module routes). */
  routesFactory?: (services: HostServices) => Route[];
  withIndexHtml?: boolean;
  extraServices?: Record<string, unknown>;
}

export async function createTestHost(options: TestHostOptions = {}): Promise<TestHost> {
  const mode = options.mode ?? "production";
  const logLines: string[] = [];
  const logger = createLogger({ sink: (line) => logLines.push(line) });
  const session = createSessionCapability();
  const tempRoot = await mkdtemp(join(tmpdir(), "councilkit-test-host-"));
  const distDir = join(tempRoot, "dist");
  await mkdir(join(distDir, "assets"), { recursive: true });
  if (options.withIndexHtml !== false) {
    await writeFile(
      join(distDir, "index.html"),
      '<!doctype html><html><head><title>t</title></head><body><div id="root"></div>' +
        '<script type="module" src="/assets/index.js"></script></body></html>',
    );
    await writeFile(join(distDir, "assets", "index.js"), "console.log('ok');\n");
  }
  const config: HostConfig = {
    mode,
    hostname: "127.0.0.1",
    port: CANONICAL_PORT,
    hostHeader: CANONICAL_HOST_HEADER,
    distDir,
    watchdogProgram: join(tempRoot, "watchdog-child.mjs"),
    driverWorkRoot: join(tempRoot, "work"),
  };
  const services: HostServices = {
    config,
    logger,
    session,
    hostInstanceId: "test-host-instance",
    startedAt: new Date().toISOString(),
    ...(options.extraServices ?? {}),
  };
  const routes = [
    ...healthRoutes(services),
    ...(options.routes ?? []),
    ...(options.routesFactory?.(services) ?? []),
  ];
  const runtime = createRuntimeServer({ services, routes });
  await runtime.listen();
  return {
    runtime,
    services,
    session,
    logger,
    logLines,
    baseUrl: `http://${CANONICAL_HOST_HEADER}`,
    async cleanup() {
      await runtime.close().catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function authedHeaders(host: TestHost, extra: Record<string, string> = {}) {
  return {
    Host: CANONICAL_HOST_HEADER,
    Cookie: host.session.sessionCookieValue().split(";")[0] as string,
    "x-councilkit-csrf": host.session.csrfToken,
    Origin: "http://127.0.0.1:43127",
    "Content-Type": "application/json",
    ...extra,
  };
}
