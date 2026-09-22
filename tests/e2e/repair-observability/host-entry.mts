/**
 * Repair-observability E2E Host entry — NEVER shipped in production.
 *
 * Mirrors tests/e2e/host-entry.mts: real createRuntimeServer (production dist,
 * session/CSRF, real cliRunsRoutes) plus repairObservationRoutes and a
 * test-only /api/v1/__test__/repair-observation/* producer control plane.
 *
 * Port/hostHeader overridden to 43837 after loadConfig(). Does not touch 43127.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  type HostServices,
  type Route,
  createRuntimeServer,
} from "../../../runtime-host/server";
import { repairObservationRoutes } from "../../../runtime-host/repair-observation/routes";
import {
  type FixtureName,
  HOST_HEADER,
  PORT,
  T0_MS,
  TASK_ID_ROUND2,
} from "./constants";
import {
  type CursorLine,
  lineJson,
  textProgress,
} from "./fixtures/cursor-events";
import {
  appendOrchestratorLines,
  chmodPath,
  hashFileSafe,
  materializeFixture,
  rotateOrchestratorLog,
} from "./fixtures/write-fixture";

process.env.COUNCILKIT_MODE = "production";
process.env.COUNCILKIT_E2E = "1";

// ---------------------------------------------------------------------------
 // Virtual clock + case home (shared by observation routes + producer)
// ---------------------------------------------------------------------------

const clock = {
  nowMs: T0_MS,
  useReal: false,
  now(): Date {
    return new Date(this.useReal ? Date.now() : this.nowMs);
  },
  advance(ms: number): Date {
    if (!this.useReal) this.nowMs += ms;
    return this.now();
  },
  set(isoOrMs: string | number): Date {
    this.nowMs = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
    return this.now();
  },
};

interface CaseState {
  home: string;
  runId: string;
  fixture: FixtureName;
  seq: number;
  taskDirRound2: string;
  authorityHashes: Record<string, string | null>;
  tempHomes: string[];
}

let caseState: CaseState | null = null;

const launcherLog: Array<{
  action: string;
  runId: string;
  at: string;
  logPath?: string;
}> = [];

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

function installationFailure(code: "INSTALLATION_NOT_FOUND", message: string): InstallationError {
  return new InstallationError(makeError(code, "discovery", message, { retryable: false }));
}

const fakeInstallationRegistry: InstallationRegistry = {
  refresh: () => Object.keys(FAKE_INSTALLATIONS).map(installationDto),
  list: () => Object.keys(FAKE_INSTALLATIONS).map(installationDto),
  get: (installationId: string) =>
    installationId in FAKE_INSTALLATIONS ? installationDto(installationId) : undefined,
  revalidate: (installationId: string) => {
    if (!(installationId in FAKE_INSTALLATIONS)) {
      throw installationFailure("INSTALLATION_NOT_FOUND", `Unknown installation "${installationId}".`);
    }
    return installationDto(installationId);
  },
  assertExecutable: (installationId: string): InstallationRecord => {
    if (!(installationId in FAKE_INSTALLATIONS)) {
      throw installationFailure("INSTALLATION_NOT_FOUND", `Unknown installation "${installationId}".`);
    }
    const base = FAKE_INSTALLATIONS[installationId];
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

function snapshotAuthority(home: string, runId: string): Record<string, string | null> {
  const runDir = join(home, "runs", runId);
  return {
    repairJson: hashFileSafe(join(runDir, "repair.json")),
    statusJson: hashFileSafe(join(runDir, "status.json")),
    journal: hashFileSafe(join(runDir, "journal.jsonl")),
  };
}

function flushSync(): void {
  // Disk writes in this producer are sync; seq ack means durable for readers.
}

async function resetCase(fixture: FixtureName): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), "ck-repair-obs-"));
  clock.useReal = false;
  clock.set(T0_MS);
  launcherLog.length = 0;
  const written = await materializeFixture(home, fixture);
  process.env.COUNCILKIT_HOME = home;
  caseState = {
    home,
    runId: written.runId,
    fixture,
    seq: 0,
    taskDirRound2: written.taskDirRound2,
    authorityHashes: snapshotAuthority(home, written.runId),
    tempHomes: [...(caseState?.tempHomes ?? []), home],
  };
  flushSync();
  return {
    flushed: true,
    seq: caseState.seq,
    home,
    runId: written.runId,
    fixture,
    logBytes: written.logBytes ?? null,
    operationCount: written.operationCount ?? null,
    taskDirRound2: written.taskDirRound2,
    sourceReviewId: written.sourceReviewId,
    childReviewId: written.childReviewId,
    serverTime: clock.now().toISOString(),
  };
}

const TEST_BASE = "/api/v1/__test__/repair-observation";

function producerRoutes(): Route[] {
  return [
    {
      method: "POST",
      pattern: `${TEST_BASE}/reset`,
      auth: "session",
      bodySchema: z.object({
        fixture: z.string().min(1),
      }),
      handler: async ({ body }) => {
        const fixture = (body as { fixture: FixtureName }).fixture;
        return resetCase(fixture);
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/append`,
      auth: "session",
      bodySchema: z.object({
        taskId: z.string().min(1).optional(),
        lines: z.array(z.record(z.string(), z.unknown())).optional(),
        raw: z.string().optional(),
        halfLine: z.string().optional(),
        completeHalf: z.boolean().optional(),
      }),
      handler: ({ body }) => {
        if (!caseState) throw new Error("no active case; call reset first");
        const input = body as {
          taskId?: string;
          lines?: CursorLine[];
          raw?: string;
          halfLine?: string;
          completeHalf?: boolean;
        };
        const taskId = input.taskId ?? TASK_ID_ROUND2;
        let bytesWritten = 0;
        if (input.raw !== undefined) {
          const result = appendOrchestratorLines(caseState.home, taskId, input.raw);
          bytesWritten += result.bytesWritten;
        }
        if (input.lines !== undefined && input.lines.length > 0) {
          const result = appendOrchestratorLines(caseState.home, taskId, input.lines);
          bytesWritten += result.bytesWritten;
        }
        if (input.halfLine !== undefined) {
          const result = appendOrchestratorLines(caseState.home, taskId, input.halfLine);
          bytesWritten += result.bytesWritten;
        }
        if (input.completeHalf) {
          const result = appendOrchestratorLines(caseState.home, taskId, "\n");
          bytesWritten += result.bytesWritten;
        }
        caseState.seq += 1;
        flushSync();
        return {
          flushed: true,
          seq: caseState.seq,
          bytesWritten,
          serverTime: clock.now().toISOString(),
        };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/advance`,
      auth: "session",
      bodySchema: z.object({
        ms: z.number().optional(),
        to: z.string().optional(),
        useRealClock: z.boolean().optional(),
      }),
      handler: ({ body }) => {
        const input = body as { ms?: number; to?: string; useRealClock?: boolean };
        if (input.useRealClock === true) clock.useReal = true;
        if (input.useRealClock === false) clock.useReal = false;
        if (input.to !== undefined) clock.set(input.to);
        if (input.ms !== undefined) clock.advance(input.ms);
        return {
          flushed: true,
          seq: caseState?.seq ?? 0,
          serverTime: clock.now().toISOString(),
          useRealClock: clock.useReal,
        };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/rotate`,
      auth: "session",
      bodySchema: z.object({
        taskId: z.string().optional(),
        generation: z.string().optional(),
        seedLine: z.record(z.string(), z.unknown()).optional(),
      }),
      handler: ({ body }) => {
        if (!caseState) throw new Error("no active case; call reset first");
        const input = body as {
          taskId?: string;
          generation?: string;
          seedLine?: CursorLine;
        };
        const taskId = input.taskId ?? TASK_ID_ROUND2;
        const rotated = rotateOrchestratorLog(caseState.home, taskId, {
          generation: input.generation,
        });
        if (input.seedLine) {
          appendOrchestratorLines(caseState.home, taskId, [input.seedLine]);
        }
        caseState.seq += 1;
        flushSync();
        return {
          flushed: true,
          seq: caseState.seq,
          generation: rotated.generation,
          serverTime: clock.now().toISOString(),
        };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/finish`,
      auth: "session",
      bodySchema: z.object({
        businessResult: z
          .enum(["approved", "needs_attention", "stopped"])
          .nullable()
          .optional(),
        reasonCode: z.string().nullable().optional(),
        status: z.string().optional(),
        phase: z.string().optional(),
        appendFinalLog: z.boolean().optional(),
        finalLogText: z.string().optional(),
        resumeEligible: z.boolean().nullable().optional(),
        candidateSha: z.string().nullable().optional(),
        childReviewId: z.string().nullable().optional(),
      }),
      handler: ({ body }) => {
        if (!caseState) throw new Error("no active case; call reset first");
        const input = body as {
          businessResult?: "approved" | "needs_attention" | "stopped" | null;
          reasonCode?: string | null;
          status?: string;
          phase?: string;
          appendFinalLog?: boolean;
          finalLogText?: string;
          resumeEligible?: boolean | null;
          candidateSha?: string | null;
          childReviewId?: string | null;
        };
        const repairPath = join(caseState.home, "runs", caseState.runId, "repair.json");
        const current = JSON.parse(readFileSync(repairPath, "utf8")) as Record<string, unknown>;
        if (input.businessResult !== undefined) current.businessResult = input.businessResult;
        if (input.reasonCode !== undefined) current.reasonCode = input.reasonCode;
        if (input.resumeEligible !== undefined) current.resumeEligible = input.resumeEligible;
        if (input.candidateSha !== undefined) current.candidateSha = input.candidateSha;
        if (input.childReviewId) {
          const cycles = (current.cycles as Array<Record<string, unknown>>) ?? [];
          const last = cycles[cycles.length - 1];
          if (last) last.childReviewId = input.childReviewId;
          current.latestReviewId = input.childReviewId;
        }
        writeFileSync(repairPath, `${JSON.stringify(current)}\n`, { encoding: "utf8", mode: 0o600 });
        const statusPath = join(caseState.home, "runs", caseState.runId, "status.json");
        writeFileSync(
          statusPath,
          `${JSON.stringify({
            version: 1,
            status: input.status ?? "completed",
            progress: {
              phase: input.phase ?? "done",
              attempts: [],
              updatedAt: clock.now().toISOString(),
            },
            pipeline: null,
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        if (input.appendFinalLog) {
          appendOrchestratorLines(caseState.home, TASK_ID_ROUND2, [
            textProgress(input.finalLogText ?? "最终完整日志行", {
              at: clock.now().toISOString(),
            }),
          ]);
        }
        caseState.seq += 1;
        flushSync();
        return {
          flushed: true,
          seq: caseState.seq,
          serverTime: clock.now().toISOString(),
          authorityHashes: snapshotAuthority(caseState.home, caseState.runId),
        };
      },
    },
    {
      method: "GET",
      pattern: `${TEST_BASE}/launcher`,
      auth: "session",
      handler: () => ({
        launches: launcherLog.filter((row) => row.action !== "repair-stop"),
        stops: launcherLog.filter((row) => row.action === "repair-stop"),
        all: [...launcherLog],
      }),
    },
    {
      method: "GET",
      pattern: `${TEST_BASE}/authority`,
      auth: "session",
      handler: () => {
        if (!caseState) throw new Error("no active case");
        const current = snapshotAuthority(caseState.home, caseState.runId);
        return {
          baseline: caseState.authorityHashes,
          current,
          unchanged:
            caseState.authorityHashes.repairJson === current.repairJson &&
            caseState.authorityHashes.statusJson === current.statusJson &&
            caseState.authorityHashes.journal === current.journal,
        };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/chmod-source`,
      auth: "session",
      bodySchema: z.object({
        relativePath: z.string().min(1),
        mode: z.number().int(),
      }),
      handler: ({ body }) => {
        if (!caseState) throw new Error("no active case");
        const input = body as { relativePath: string; mode: number };
        // Only allow paths under the case home.
        const target = join(caseState.home, input.relativePath);
        if (!target.startsWith(caseState.home)) {
          throw new Error("path escapes case home");
        }
        chmodPath(target, input.mode);
        return { flushed: true, path: input.relativePath, mode: input.mode };
      },
    },
    {
      method: "GET",
      pattern: `${TEST_BASE}/env-sentinel`,
      auth: "session",
      handler: () => {
        const userHome = join(
          process.env.HOME ?? tmpdir(),
          ".config",
          "councilkit",
        );
        let userHomeHash: string | null = null;
        if (existsSync(userHome)) {
          // Hash listing only — never read credential files.
          try {
            const names = readdirSync(userHome).sort().join("\n");
            const mtime = String(statSync(userHome).mtimeMs);
            userHomeHash = createHash("sha256").update(`${names}\n${mtime}`).digest("hex");
          } catch {
            userHomeHash = null;
          }
        }
        return {
          testPort: PORT,
          hostHeader: HOST_HEADER,
          councilkitHome: process.env.COUNCILKIT_HOME ?? null,
          userHomeExists: existsSync(userHome),
          userHomeHash,
          caseHome: caseState?.home ?? null,
          pid: process.pid,
        };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/append-raw-bytes`,
      auth: "session",
      bodySchema: z.object({
        taskId: z.string().optional(),
        text: z.string(),
      }),
      handler: ({ body }) => {
        if (!caseState) throw new Error("no active case");
        const input = body as { taskId?: string; text: string };
        const result = appendOrchestratorLines(
          caseState.home,
          input.taskId ?? TASK_ID_ROUND2,
          input.text,
        );
        caseState.seq += 1;
        flushSync();
        return { flushed: true, seq: caseState.seq, bytesWritten: result.bytesWritten };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/seed-line`,
      auth: "session",
      bodySchema: z.object({
        summary: z.string(),
        callId: z.string().optional(),
      }),
      handler: ({ body }) => {
        if (!caseState) throw new Error("no active case");
        const input = body as { summary: string; callId?: string };
        const line: CursorLine = textProgress(input.summary, {
          at: clock.now().toISOString(),
        });
        if (input.callId) {
          Object.assign(line, { call_id: input.callId });
        }
        const result = appendOrchestratorLines(caseState.home, TASK_ID_ROUND2, [line]);
        caseState.seq += 1;
        flushSync();
        return {
          flushed: true,
          seq: caseState.seq,
          bytesWritten: result.bytesWritten,
          line: lineJson(line).trim(),
          serverTime: clock.now().toISOString(),
        };
      },
    },
  ];
}

function observationRoutes(): Route[] {
  return repairObservationRoutes({ now: () => clock.now() });
}

async function main(): Promise<void> {
  const config = loadConfig();
  config.port = PORT;
  config.hostHeader = HOST_HEADER;

  const logger = createLogger({
    sink: (line) => {
      if (process.env.E2E_HOST_LOG) process.stdout.write(`[repair-obs-e2e] ${line}\n`);
    },
  });
  const session = createSessionCapability();
  const hostInstanceId = "repair-obs-e2e-host";
  const executions = createExecutionRegistry({ logger });
  const reconciler = createSessionReconciler();
  const driverFactories = {
    "claude-stream-json": (participantId: string) => noopDriver("claude-stream-json", participantId),
    "codex-app-server": (participantId: string) => noopDriver("codex-app-server", participantId),
    "kimi-stream-json": (participantId: string) => noopDriver("kimi-stream-json", participantId),
    "grok-stream-json": (participantId: string) => noopDriver("grok-stream-json", participantId),
    "cursor-stream-json": (participantId: string) =>
      noopDriver("cursor-stream-json", participantId),
  };
  const scopeManager = createScopeManager({
    installations: fakeInstallationRegistry,
    executions,
    reconciler,
    driverFactories,
    logger,
    hostInstanceId,
  });
  const profileProbe = createProfileProbe({
    installations: fakeInstallationRegistry,
    driverFactories,
    logger,
  });

  // Bootstrap an empty temp home so health/list work before first reset.
  const bootstrapHome = mkdtempSync(join(tmpdir(), "ck-repair-obs-boot-"));
  process.env.COUNCILKIT_HOME = bootstrapHome;

  const services: HostServices = {
    config,
    logger,
    session,
    hostInstanceId,
    startedAt: new Date().toISOString(),
    installationRegistry: fakeInstallationRegistry,
    executionRegistry: executions,
    scopeManager,
    profileProbe,
    driverCapabilities: () =>
      DRIVER_IDS.map((driverId) => ({ driverId, capability: "ready" as const })),
    cliRunLauncher: {
      start: (input: { action: string; runId: string; logPath?: string }) => {
        launcherLog.push({
          action: input.action,
          runId: input.runId,
          at: clock.now().toISOString(),
          logPath: input.logPath,
        });
        // Never spawn real councilkit / LLM / squadctl.
        if (input.action === "repair-stop") {
          return { pid: process.pid };
        }
        if (input.action === "repair" || input.action === "repair-resume") {
          return { pid: process.pid };
        }
        return { pid: process.pid };
      },
    },
  };

  const observation = observationRoutes();
  const routes: Route[] = [
    ...healthRoutes(services),
    ...installationRoutes(services),
    ...modelRoutes(services),
    ...scopeRoutes(services),
    ...diagnosticsRoutes(services),
    ...cliRunsRoutes(services),
    ...observation,
    ...reviewJuryRoutes(),
    ...productJuryRoutes(),
    ...producerRoutes(),
  ];

  const runtime = createRuntimeServer({ services, routes });
  await runtime.listen(config.port);
  process.stdout.write(`E2E_HOST_READY ${config.hostname}:${config.port}\n`);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    void (async () => {
      await scopeManager.closeAll(signal).catch(() => undefined);
      await runtime.close().catch(() => undefined);
      const homes = caseState?.tempHomes ?? [];
      for (const home of homes) {
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
      try {
        rmSync(bootstrapHome, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
