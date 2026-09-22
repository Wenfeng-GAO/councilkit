/**
 * Review-explainer E2E Host — NEVER shipped in production.
 *
 * Supervisor stays alive for Playwright webServer. The worker is a real
 * createRuntimeServer child on 43839. POST /restart exits the worker; the
 * supervisor starts a new process with the same COUNCILKIT_HOME.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DRIVER_IDS, type DriverId } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import type { InstallationDto } from "@shared/runtime/schemas";
import { z } from "zod";
import { loadConfig } from "../../../runtime-host/config";
import type { ParticipantDriver } from "../../../runtime-host/drivers/types";
import { createExecutionRegistry } from "../../../runtime-host/executions/execution-registry";
import {
  InstallationError,
  type InstallationRecord,
  type InstallationRegistry,
} from "../../../runtime-host/installations/registry";
import { createLogger } from "../../../runtime-host/logging";
import { createProfileProbe } from "../../../runtime-host/profiles/probe";
import { cliRunsRoutes } from "../../../runtime-host/routes/cli-runs";
import { diagnosticsRoutes } from "../../../runtime-host/routes/diagnostics";
import { healthRoutes } from "../../../runtime-host/routes/health";
import { installationRoutes } from "../../../runtime-host/routes/installations";
import { modelRoutes } from "../../../runtime-host/routes/models";
import { productJuryRoutes } from "../../../runtime-host/routes/product-jury";
import { reviewJuryRoutes } from "../../../runtime-host/routes/review-jury";
import { scopeRoutes } from "../../../runtime-host/routes/scopes";
import { createScopeManager } from "../../../runtime-host/scopes/scope-manager";
import { createSessionReconciler } from "../../../runtime-host/scopes/session-reconciler";
import { createSessionCapability } from "../../../runtime-host/security/session-capability";
import { type HostServices, type Route, createRuntimeServer } from "../../../runtime-host/server";
import { PR_URL, RUN_ID, TEST_API, prDecisionsPath } from "../../review-explainer/contract";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";
import {
  type SyntheticRepo,
  createSyntheticRepo,
} from "../../review-explainer/fixtures/synthetic-repo";
import { HOST_HEADER, PORT, WORKER_RESTART_CODE } from "./constants";

process.env.COUNCILKIT_MODE = "production";
process.env.COUNCILKIT_E2E = "1";

const TEST_BASE = TEST_API;

const FAKE_INSTALLATIONS: Record<
  string,
  { driverId: DriverId; name: "cld" | "codex" | "kimi" | "grok"; path: string }
> = {
  "claude-e2e-fake01": { driverId: "claude-stream-json", name: "cld", path: "/fake/cld" },
  "codex-e2e-fake001": { driverId: "codex-app-server", name: "codex", path: "/fake/codex" },
  "kimi-e2e-fake001": { driverId: "kimi-stream-json", name: "kimi", path: "/fake/kimi" },
  "grok-e2e-fake001": { driverId: "grok-stream-json", name: "grok", path: "/fake/grok" },
};

function installationDto(installationId: string): InstallationDto {
  const base = FAKE_INSTALLATIONS[installationId];
  if (!base) throw new Error(`unknown fake installation ${installationId}`);
  return {
    installationId,
    driverId: base.driverId,
    state: "trusted",
    executablePath: base.path,
    fingerprint: "sha256:00",
    components: [],
    detail: null,
  };
}

const fakeInstallationRegistry: InstallationRegistry = {
  refresh: () => Object.keys(FAKE_INSTALLATIONS).map(installationDto),
  list: () => Object.keys(FAKE_INSTALLATIONS).map(installationDto),
  get: (installationId: string) =>
    installationId in FAKE_INSTALLATIONS ? installationDto(installationId) : undefined,
  revalidate: (installationId: string) => {
    if (!(installationId in FAKE_INSTALLATIONS)) {
      throw new InstallationError(
        makeError(
          "INSTALLATION_NOT_FOUND",
          "discovery",
          `Unknown installation "${installationId}".`,
          {
            retryable: false,
          },
        ),
      );
    }
    return installationDto(installationId);
  },
  assertExecutable: (installationId: string): InstallationRecord => {
    const base = FAKE_INSTALLATIONS[installationId];
    if (!base) {
      throw new InstallationError(
        makeError(
          "INSTALLATION_NOT_FOUND",
          "discovery",
          `Unknown installation "${installationId}".`,
          {
            retryable: false,
          },
        ),
      );
    }
    return {
      installationId,
      driverId: base.driverId,
      name: base.name,
      discoveredPath: base.path,
      realpath: base.path,
      fingerprint: "sha256:00",
      state: "trusted",
      components: [],
      detail: null,
    };
  },
};

function noopDriver(driverId: DriverId, participantId: string): ParticipantDriver {
  return {
    participantId,
    driverId,
    sessionEpoch: 0,
    prewarm: async () => ({
      canonicalModelId: "e2e-model",
      modelAliases: [],
      capability: { protocol: "e2e-fake" },
      catalog: ["e2e-model"],
    }),
    execute: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
    capabilityState: () => "ready",
    contextWindowTokens: () => null,
  };
}

let explainCalls = 0;
let explainInputs: unknown[] = [];
let explainScript: Record<string, unknown> = {
  behavior: "success",
  body: {
    kind: "flow",
    assertion: "busy after accept",
    evidence: ["one accepted request returned busy"],
    inference: ["a later retry might double-run"],
    canvas: {
      template: "flow",
      nodes: [
        { id: "a", label: "accept", evidence: "assertion" },
        { id: "b", label: "busy", evidence: "evidence" },
      ],
      edges: [{ from: "a", to: "b" }],
    },
  },
};

function userHomeHash(): string | null {
  const userHome = join(process.env.HOME ?? tmpdir(), ".config", "councilkit");
  if (!existsSync(userHome)) return null;
  try {
    const names = readdirSync(userHome).sort().join("\n");
    return createHash("sha256")
      .update(`${names}\n${statSync(userHome).mtimeMs}`)
      .digest("hex");
  } catch {
    return null;
  }
}

function testRoutes(): Route[] {
  return [
    {
      method: "POST",
      pattern: `${TEST_BASE}/reset`,
      auth: "session",
      handler: () => {
        const home = process.env.COUNCILKIT_HOME;
        if (!home || !basename(home).startsWith("ck-explainer-e2e-"))
          throw new Error("Refusing reset outside this test home");
        for (const child of ["runs", "pr-decisions"])
          rmSync(join(home, child), { recursive: true, force: true });
        const template = JSON.parse(
          readFileSync(join(home, "fixture-repo.json"), "utf8"),
        ) as SyntheticRepo;
        execFileSync(
          "git",
          ["-C", template.repo, "commit", "--allow-empty", "-m", "Isolate next test case"],
          { stdio: "ignore" },
        );
        const headSha = execFileSync("git", ["-C", template.repo, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        const seeded = seedReviewRun(home, { runId: RUN_ID, repo: { ...template, headSha } });
        explainCalls = 0;
        explainInputs = [];
        return {
          home,
          runId: seeded.runId,
          pid: process.pid,
          headSha: seeded.repo.headSha,
          baseSha: seeded.repo.baseSha,
          diffHash: seeded.repo.diffHash,
          busyContextLine: seeded.repo.busyContextLine,
          busyNewLine: seeded.repo.busyNewLine,
          staleNewLine: seeded.repo.staleNewLine,
          dupNewLine: seeded.repo.dupNewLine,
          deletedOldLine: seeded.repo.deletedOldLine,
        };
      },
    },
    {
      method: "GET",
      pattern: `${TEST_BASE}/env`,
      auth: "session",
      handler: () => ({
        testPort: PORT,
        hostHeader: HOST_HEADER,
        councilkitHome: process.env.COUNCILKIT_HOME ?? null,
        pid: process.pid,
        userHomeHash: userHomeHash(),
      }),
    },
    {
      method: "GET",
      pattern: `${TEST_BASE}/disk`,
      auth: "session",
      handler: () => {
        const home = process.env.COUNCILKIT_HOME ?? "";
        const decisionsPath = prDecisionsPath(home, PR_URL);
        const explainDir = join(home, "runs", RUN_ID, "review-explainer", "explanations");
        let decisions: unknown = null;
        if (existsSync(decisionsPath)) {
          decisions = JSON.parse(readFileSync(decisionsPath, "utf8"));
        }
        let explanations: unknown = null;
        if (existsSync(explainDir)) {
          explanations = readdirSync(explainDir);
        }
        return { decisions, explanations, pid: process.pid, explainCalls };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/explain-script`,
      auth: "session",
      bodySchema: z.object({
        behavior: z.enum(["success", "fail", "timeout", "invalid"]),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
      handler: ({ body }) => {
        explainScript = body as Record<string, unknown>;
        explainCalls = 0;
        explainInputs = [];
        return { ok: true };
      },
    },
    {
      method: "GET",
      pattern: `${TEST_BASE}/explain-calls`,
      auth: "session",
      handler: () => ({ calls: explainCalls, inputs: explainInputs }),
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/restart`,
      auth: "session",
      handler: () => {
        setTimeout(() => process.exit(WORKER_RESTART_CODE), 40);
        return { restarting: true, pid: process.pid };
      },
    },
  ];
}

async function loadExplainerRoutes(services: HostServices): Promise<Route[]> {
  try {
    const spec = "../../../runtime-host/routes/review-explainer.ts";
    const mod = (await import(spec)) as {
      reviewExplainerRoutes?: (svc: HostServices) => Route[];
    };
    return mod.reviewExplainerRoutes?.(services) ?? [];
  } catch {
    return [];
  }
}

async function runWorker(): Promise<void> {
  const config = loadConfig();
  config.port = PORT;
  config.hostHeader = HOST_HEADER;
  const logger = createLogger({
    sink: (line) => {
      if (process.env.E2E_HOST_LOG) process.stdout.write(`[review-explainer-e2e] ${line}\n`);
    },
  });
  const session = createSessionCapability();
  const executions = createExecutionRegistry({ logger });
  const reconciler = createSessionReconciler();
  const driverFactories = {
    "claude-stream-json": (id: string) => noopDriver("claude-stream-json", id),
    "codex-app-server": (id: string) => noopDriver("codex-app-server", id),
    "kimi-stream-json": (id: string) => noopDriver("kimi-stream-json", id),
    "grok-stream-json": (id: string) => noopDriver("grok-stream-json", id),
    "cursor-stream-json": (id: string) => noopDriver("cursor-stream-json", id),
  };
  const scopeManager = createScopeManager({
    installations: fakeInstallationRegistry,
    executions,
    reconciler,
    driverFactories,
    logger,
    hostInstanceId: "review-explainer-e2e",
  });
  const profileProbe = createProfileProbe({
    installations: fakeInstallationRegistry,
    driverFactories,
    logger,
  });
  const services: HostServices = {
    config,
    logger,
    session,
    hostInstanceId: `review-explainer-e2e-${process.pid}`,
    startedAt: new Date().toISOString(),
    installationRegistry: fakeInstallationRegistry,
    executionRegistry: executions,
    scopeManager,
    profileProbe,
    driverCapabilities: () =>
      DRIVER_IDS.map((driverId) => ({ driverId, capability: "ready" as const })),
    cliRunLauncher: {
      start: () => {
        throw new Error("review-explainer e2e does not spawn councilkit review/repair");
      },
    },
    ...{
      reviewExplainerTimeoutMs: 300,
      reviewExplainerExecutor: {
        modelId: "e2e-explainer",
        async generate(input: unknown) {
          explainCalls += 1;
          explainInputs.push(input);
          if (explainScript.behavior === "fail") throw new Error("injected explainer failure");
          if (explainScript.behavior === "timeout") {
            await new Promise(() => undefined);
          }
          if (explainScript.behavior === "invalid") {
            return { html: "<script>alert(1)</script>", javascript: "1" };
          }
          return explainScript.body;
        },
      },
    },
  };
  const explainer = await loadExplainerRoutes(services);
  const routes: Route[] = [
    ...healthRoutes(services),
    ...installationRoutes(services),
    ...modelRoutes(services),
    ...scopeRoutes(services),
    ...diagnosticsRoutes(services),
    ...cliRunsRoutes(services),
    ...reviewJuryRoutes(),
    ...productJuryRoutes(),
    ...explainer,
    ...testRoutes(),
  ];
  const runtime = createRuntimeServer({ services, routes });
  await runtime.listen(config.port);
  process.stdout.write(`E2E_HOST_READY ${config.hostname}:${config.port} pid=${process.pid}\n`);
  const shutdown = () => {
    void runtime.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function waitHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`INFRA_FAILURE: worker on ${PORT} never became healthy`);
}

async function runSupervisor(): Promise<void> {
  const occupied = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`)
    .then((res) => res.ok)
    .catch(() => false);
  if (occupied) {
    process.stderr.write(
      `INFRA_FAILURE: port ${PORT} is already in use. Record lsof; do not kill foreign processes.\n`,
    );
    process.exit(1);
  }
  const home = mkdtempSync(join(tmpdir(), "ck-explainer-e2e-"));
  process.env.COUNCILKIT_HOME = home;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const template = createSyntheticRepo(join(home, "src"));
  writeFileSync(join(home, "fixture-repo.json"), JSON.stringify(template), { mode: 0o600 });

  const spawnWorker = () =>
    spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      env: {
        ...process.env,
        CK_REVIEW_EXPLAINER_WORKER: "1",
        COUNCILKIT_HOME: home,
        COUNCILKIT_MODE: "production",
        COUNCILKIT_E2E: "1",
      },
      stdio: "inherit",
    });

  let child = spawnWorker();
  let closing = false;
  const attach = () => {
    child.on("exit", (code) => {
      if (closing) return;
      if (code === WORKER_RESTART_CODE) {
        child = spawnWorker();
        attach();
        return;
      }
      process.exit(code ?? 1);
    });
  };
  attach();
  await waitHealth();
  process.stdout.write(`E2E_SUPERVISOR_READY ${PORT} home=${home}\n`);
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    child.once("exit", () => {
      rmSync(home, { recursive: true, force: true });
      process.exit(0);
    });
    child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.env.CK_REVIEW_EXPLAINER_WORKER === "1") {
  void runWorker();
} else {
  void runSupervisor();
}
