/**
 * Live Runtime smoke (Stage C real-environment gate; plan
 * docs/plans/2026-07-17-001 §552, §583-588, §687-696).
 *
 * Real-environment smoke tool for the V1 dual-driver Runtime Host. Per matrix
 * row (one `cld` route participant + one Codex participant, Codex is the
 * facilitator so the Round Summary is an explicit Codex execution) it:
 *   1. composes the REAL Host in-process on the canonical origin — exactly how
 *      tests/smoke/real-cli-conformance.mts does it (real supervisor, real
 *      trusted installations, real drivers; the conformance tool composes
 *      in-process, so this tool matches that) — and waits for /api/v1/health;
 *   2. acquires the session cookie + CSRF capability LIKE A BROWSER (GET /,
 *      parse Set-Cookie + <meta name="councilkit-csrf">) — no hardcoded
 *      secrets anywhere in this file;
 *   3. picks modelIds from the live Host model catalog + profile readiness
 *      handshake (GET /api/v1/models/catalog, POST /api/v1/profiles/readiness);
 *      the FALLBACK_MODEL_HINTS below are only fallback hints when the catalog
 *      probe itself fails, and that fallback is recorded as a finding;
 *   4. seeds a 2-participant Room in an ephemeral fake-indexeddb Dexie and
 *      drives --rounds Rounds through the REAL persistent Orchestrator;
 *   5. records per execution: requestedModel vs effectiveModel (any
 *      mismatch/unknown pauses per product semantics and the row FAILS — it is
 *      never papered over), per-participant driver spawn/init counts
 *      (long-term reuse: prewarm happens once per participant per scope),
 *      cold vs warm first-delta latency, and ACK states (no pending left);
 *   6. closes the scope normally and asserts no driver processes leak
 *      (supervisor pid tracking + machine-wide pgrep, same approach as the
 *      conformance tool and tests/host);
 *   7. Codex policy: approval-type server requests are answered denied by the
 *      driver (observable via Host diagnostics), and the participant-dedicated
 *      cwd runs under sandbox="read-only" + approvalPolicy="never" (driver
 *      handshake constants); a sentinel write-attempt is out of scope — the
 *      row asserts what the Host surfaces (zero fileChange activity) and the
 *      report carries the plan §588 residual-risk note: local file reads and
 *      network access may still be governed by the user's own Codex config.
 *
 * This file is NEVER imported by vitest or playwright. NEVER run it
 * concurrently with vitest/playwright either: the canonical port 43127 and
 * the machine-wide driver-process leak assertions are exclusive (the tool
 * aborts on startup when it detects either runner via pgrep).
 *
 * Run (tsconfig.integration.json is the only repo tsconfig whose path aliases
 * cover all three worlds this file spans — @/ src, @host/ runtime-host,
 * @shared/ shared — the same cross-world situation as
 * tests/integration/discussion-runtime.test.ts):
 *
 *   TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx \
 *     tests/smoke/live-runtime-smoke.ts [--route ant-glm5.2|moonshot|deepseek|all] \
 *     [--rounds N] [--soak] [--out file.json] [--dry-run] [--help]
 *
 * --dry-run validates the tool end-to-end WITHOUT touching real CLIs: it
 * composes the same Host with the fake-driver rig (same pattern as
 * tests/integration/discussion-runtime.test.ts) and runs one synthetic row.
 *
 * The report NEVER contains prompt/completion bodies, cookies or tokens —
 * counts, digests, model ids and latencies only.
 */
import "fake-indexeddb/auto";

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { Participant } from "@/models/discussion/entities";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createParticipant,
} from "@/models/discussion/factories";
import { type ExecutionProfileRecord, profileDigestOf } from "@/models/execution-profile";
import { initializeRoomDigest } from "@/orchestrator/context-snapshot";
import { createDiscussionOrchestrator } from "@/orchestrator/discussion-orchestrator";
import { RuntimeClient } from "@/runtime/client";
import { loadConfig } from "@host/config";
import { createClaudeStreamJsonDriver } from "@host/drivers/claude-stream-json";
import { createCodexAppServerDriver } from "@host/drivers/codex-app-server";
import type {
  DriverDeps,
  DriverEvent,
  Emit,
  ExecuteInput,
  ParticipantDriver,
  PrewarmInput,
  PrewarmResult,
} from "@host/drivers/types";
import { createExecutionRegistry } from "@host/executions/execution-registry";
import {
  type InstallationRecord,
  type InstallationRegistry,
  createInstallationRegistry,
} from "@host/installations/registry";
import { type Logger, createLogger } from "@host/logging";
import { createProcessSupervisor } from "@host/process/process-supervisor";
import { createProfileProbe } from "@host/profiles/probe";
import { installationRoutes } from "@host/routes/installations";
import { modelRoutes } from "@host/routes/models";
import { scopeRoutes } from "@host/routes/scopes";
import { createScopeManager } from "@host/scopes/scope-manager";
import { createSessionReconciler } from "@host/scopes/session-reconciler";
import {
  CANONICAL_ORIGIN,
  CANONICAL_PORT,
  CREDENTIAL_MODE,
  DRIVER_IDS,
  type DriverCapabilityState,
  type DriverId,
  SESSION_COOKIE_NAME,
  TIMEOUTS,
} from "@shared/runtime/contracts";
import type { RuntimeEvent } from "@shared/runtime/events";
import type {
  ExecuteRequest,
  ExecuteResponse,
  ExecutionProfileDto,
  InstallationDto,
} from "@shared/runtime/schemas";
import { type TestHost, createTestHost } from "../host/helpers";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ROUTE_IDS = ["ant-glm5.2", "moonshot", "deepseek"] as const;
type RouteId = (typeof ROUTE_IDS)[number];

/**
 * Fallback hints only — NOT account secrets and never used verbatim when the
 * live catalog probe works. Every candidate (hint or catalog entry) is
 * verified through the profile-readiness handshake before use: the selected
 * modelId must come back ready with binding.canonicalModelId === candidate,
 * so requested == canonical by construction.
 */
const FALLBACK_MODEL_HINTS: Record<RouteId | "codex", string> = {
  "ant-glm5.2": "GLM-5.2[1m]",
  moonshot: "Kimi-K2.5",
  deepseek: "deepseek-v4-pro[1m]",
  codex: "gpt-5.6-sol",
};

const DEFAULT_ROUNDS = 2;
const SOAK_MIN_ROUNDS = 10;
const SOAK_MIN_MS = 15 * 60 * 1000;
/** Upper bound for one Round (matches the Host's fixed per-turn timeout). */
const ROUND_TIMEOUT_MS = TIMEOUTS.turnMs;

interface CliOptions {
  help: boolean;
  dryRun: boolean;
  soak: boolean;
  rounds: number;
  route: RouteId | "all";
  out: string | null;
}

const HELP_TEXT = `live-runtime-smoke — real-environment smoke matrix for the V1 dual-driver Runtime Host.

USAGE:
  TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx tests/smoke/live-runtime-smoke.ts [options]

OPTIONS:
  --route <ant-glm5.2|moonshot|deepseek|all>
      Matrix row(s) to run (default: all, sequentially). Each row is a
      2-participant Room: the route's cld participant + a Codex participant
      (Codex is the facilitator, so the Summary is an explicit Codex run).
  --rounds <N>
      Rounds per row (default: ${DEFAULT_ROUNDS}).
  --soak
      After the selected rows, run the ant-glm5.2+Codex room for
      ${SOAK_MIN_ROUNDS} consecutive rounds OR >= ${SOAK_MIN_MS / 60000} minutes, whichever is LATER.
      Asserts: spawn/init counts flat after round 1, Codex thread never
      rebuilt, no ACK pending leak, per-round Message/Summary anchors unique.
      Partial JSON is written after every round so a long run is inspectable.
  --out <file.json>
      Machine report path (default in --soak mode: ./live-runtime-smoke-report.json).
  --dry-run
      Synthetic end-to-end self-check WITHOUT real CLIs: same Host composed
      with the fake-driver rig, one synthetic row (route ant-glm5.2, 1 round).
      Mutually exclusive with --soak; selection flags are ignored.
  --help
      This text.

WARNINGS:
  - NEVER run concurrently with vitest or playwright: the canonical port
    43127 and the machine-wide driver-process leak assertions (pgrep) are
    exclusive. The tool aborts on startup when it detects either runner.
  - This file is never imported by vitest/playwright.
  - Reports never contain prompt/completion bodies, cookies or tokens.`;

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    dryRun: false,
    soak: false,
    rounds: DEFAULT_ROUNDS,
    route: "all",
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--soak":
        options.soak = true;
        break;
      case "--rounds": {
        const value = argv[++i];
        const parsed = Number.parseInt(value ?? "", 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error(`--rounds requires a positive integer, got "${value ?? ""}"`);
        }
        options.rounds = parsed;
        break;
      }
      case "--route": {
        const value = argv[++i] ?? "";
        if (value !== "all" && !(ROUTE_IDS as readonly string[]).includes(value)) {
          throw new Error(
            `--route must be one of ${[...ROUTE_IDS, "all"].join("|")}, got "${value}"`,
          );
        }
        options.route = value as RouteId | "all";
        break;
      }
      case "--out": {
        const value = argv[++i];
        if (!value) throw new Error("--out requires a file path");
        options.out = value;
        break;
      }
      default:
        throw new Error(`unknown argument "${arg}" (see --help)`);
    }
  }
  if (options.dryRun && options.soak) {
    throw new Error("--dry-run and --soak are mutually exclusive");
  }
  return options;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** pgrep process count, same approach as tests/host driver suites. */
function pgrepCount(pattern: string): number {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

/** Read-only probe: is something already listening on the canonical port? */
function canonicalPortOccupied(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = new Socket();
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.connect(CANONICAL_PORT, "127.0.0.1");
  });
}

/** The smoke is exclusive: canonical port + machine-wide leak assertions. */
async function assertExclusiveMachine(): Promise<void> {
  for (const pattern of ["vitest", "playwright"]) {
    const count = pgrepCount(pattern);
    if (count > 0) {
      throw new Error(
        `refusing to run: ${count} process(es) match "${pattern}". Never run live-runtime-smoke concurrently with vitest/playwright — the canonical port 43127 and the pgrep leak assertions are exclusive.`,
      );
    }
  }
  const watchdogs = pgrepCount("watchdog-child[.]mjs");
  if (watchdogs > 0) {
    throw new Error(
      `refusing to run: ${watchdogs} watchdog-child.mjs process(es) already alive. Stop any dev Host (pnpm dev) or earlier smoke/conformance run first — driver-process leak assertions are machine-wide.`,
    );
  }
  if (await canonicalPortOccupied()) {
    throw new Error(
      `refusing to run: port ${CANONICAL_PORT} is already in use. Identify the occupant (e.g. lsof -nP -iTCP:${CANONICAL_PORT} -sTCP:LISTEN) and stop it; the canonical origin never moves.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Browser-style session acquisition (no hardcoded secrets)
// ---------------------------------------------------------------------------

interface BrowserSession {
  cookie: string;
  csrfToken: string;
}

async function acquireSession(baseUrl: string): Promise<BrowserSession> {
  const response = await fetch(`${baseUrl}/`);
  if (!response.ok) throw new Error(`document GET / -> HTTP ${response.status}`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]?.trim() ?? "";
  if (!cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
    throw new Error("document response carried no session cookie");
  }
  const html = await response.text();
  const meta = html.match(/<meta name="councilkit-csrf" content="([^"]+)"/);
  if (!meta || !meta[1]) throw new Error("document carried no councilkit-csrf meta tag");
  return { cookie, csrfToken: meta[1] };
}

async function waitForHealth(client: RuntimeClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.health();
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`/api/v1/health not ready within ${timeoutMs}ms: ${messageOf(lastError)}`);
}

// ---------------------------------------------------------------------------
// Rig: real Host composition (mirrors real-cli-conformance.mts) + fake rig
// for --dry-run (mirrors tests/integration/discussion-runtime.test.ts)
// ---------------------------------------------------------------------------

interface Rig {
  kind: "real" | "fake";
  host: TestHost;
  logger: Logger;
  logLines: string[];
  /** Driver spawns for one room participant (probe drivers excluded). */
  spawnCount(participantId: string): number;
  /** Spawns of throwaway profile/catalog probe drivers. */
  probeSpawnCount(): number;
  /** Currently live driver processes (real) or unclosed fake drivers. */
  liveDriverCount(): number;
  close(): Promise<void>;
}

/** Same live-handshake capability tracking as runtime-host/main.ts. */
function trackCapability(
  capabilityByDriver: Map<DriverId, DriverCapabilityState>,
  driverId: DriverId,
  factory: (participantId: string) => ParticipantDriver,
): (participantId: string) => ParticipantDriver {
  return (participantId) => {
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

async function assembleHost(input: {
  installations: InstallationRegistry;
  driverFactories: Record<string, (participantId: string) => ParticipantDriver>;
  logger: Logger;
  hostInstanceId: string;
  capabilityByDriver: Map<DriverId, DriverCapabilityState>;
}) {
  const executions = createExecutionRegistry({ logger: input.logger });
  const scopeManager = createScopeManager({
    installations: input.installations,
    executions,
    reconciler: createSessionReconciler(),
    driverFactories: input.driverFactories,
    logger: input.logger,
    hostInstanceId: input.hostInstanceId,
  });
  // Dynamic Profile readiness/catalog: same factories/handshake as execution.
  const profileProbe = createProfileProbe({
    installations: input.installations,
    driverFactories: input.driverFactories,
    logger: input.logger,
  });
  const host = await createTestHost({
    extraServices: {
      installationRegistry: input.installations,
      executionRegistry: executions,
      scopeManager,
      profileProbe,
      driverCapabilities: () =>
        DRIVER_IDS.map((driverId) => ({
          driverId,
          capability: input.capabilityByDriver.get(driverId) ?? ("checking" as const),
        })),
    },
    routesFactory: (services) => [
      ...installationRoutes(services),
      ...modelRoutes(services),
      ...scopeRoutes(services),
    ],
  });
  return { host, scopeManager };
}

async function createRealRig(logLines: string[]): Promise<Rig> {
  const config = loadConfig();
  const logger = createLogger({ sink: (line) => logLines.push(line) });
  const baseSupervisor = createProcessSupervisor({ config, logger });
  const spawnCounts = new Map<string, number>();
  const pids = new Set<number>();
  const supervisor: typeof baseSupervisor = {
    ...baseSupervisor,
    spawnDriver: async (spec) => {
      spawnCounts.set(spec.participantId, (spawnCounts.get(spec.participantId) ?? 0) + 1);
      const proc = await baseSupervisor.spawnDriver(spec);
      // pid is null until the watchdog reports `supervised`; track it there.
      if (proc.pid) pids.add(proc.pid);
      proc.events.on("supervised", ({ pid }: { pid: number | null }) => {
        if (typeof pid === "number") pids.add(pid);
      });
      proc.events.on("exit", () => {
        if (proc.pid) pids.delete(proc.pid);
      });
      return proc;
    },
  };
  const installations = createInstallationRegistry({ logger });
  const driverDeps: DriverDeps = {
    supervisor,
    logger,
    timeouts: TIMEOUTS,
    workRoot: config.driverWorkRoot,
  };
  const capabilityByDriver = new Map<DriverId, DriverCapabilityState>();
  const driverFactories = {
    "claude-stream-json": trackCapability(
      capabilityByDriver,
      "claude-stream-json",
      createClaudeStreamJsonDriver(driverDeps),
    ),
    "codex-app-server": trackCapability(
      capabilityByDriver,
      "codex-app-server",
      createCodexAppServerDriver(driverDeps),
    ),
  };
  const { host, scopeManager } = await assembleHost({
    installations,
    driverFactories,
    logger,
    hostInstanceId: `smoke-real-${crypto.randomUUID()}`,
    capabilityByDriver,
  });
  return {
    kind: "real",
    host,
    logger,
    logLines,
    spawnCount: (participantId) => spawnCounts.get(participantId) ?? 0,
    probeSpawnCount: () =>
      [...spawnCounts.entries()]
        .filter(([participantId]) => participantId.startsWith("probe-"))
        .reduce((total, [, count]) => total + count, 0),
    liveDriverCount: () => pids.size,
    async close() {
      await scopeManager.closeAll("smoke-cleanup").catch(() => undefined);
      await baseSupervisor.shutdownAll().catch(() => undefined);
      await host.cleanup();
    },
  };
}

// --- fake rig (dry-run) -----------------------------------------------------

interface FakeDriver extends ParticipantDriver {
  prewarmCount: number;
  closeCount: number;
}

function createFakeDriver(participantId: string, driverId: DriverId): FakeDriver {
  const reply = `smoke-answer-from-${participantId}`;
  const fake: FakeDriver = {
    participantId,
    driverId,
    sessionEpoch: 0,
    prewarmCount: 0,
    closeCount: 0,
    prewarm(input: PrewarmInput): Promise<PrewarmResult> {
      fake.prewarmCount += 1;
      return Promise.resolve({
        canonicalModelId: input.spec.modelId,
        modelAliases: [],
        capability: { protocol: "fake" },
        catalog: [input.spec.modelId],
      });
    },
    execute(input: ExecuteInput, emit: Emit): Promise<void> {
      return new Promise<void>((resolvePromise) => {
        setImmediate(() => {
          emit({ type: "started", requestedModel: input.modelId });
          emit({ type: "output.delta", text: reply.slice(0, 8) });
          emit({ type: "output.delta", text: reply.slice(8) });
          emit({ type: "usage", usage: { inputTokens: 42, outputTokens: 7 } });
          emit({
            type: "completed",
            output: reply,
            requestedModel: input.modelId,
            effectiveModel: input.modelId,
            modelVerdict: "match",
            toolState: "none",
            dispatchState: "accepted",
            usage: { inputTokens: 42, outputTokens: 7 },
            finalSeq: 0,
          } as DriverEvent);
          resolvePromise();
        });
      });
    },
    cancel: () => Promise.resolve(),
    close(): Promise<void> {
      fake.closeCount += 1;
      return Promise.resolve();
    },
    capabilityState: () => "ready",
    contextWindowTokens: () => null,
  };
  return fake;
}

const FAKE_INSTALLATIONS: Record<DriverId, { dto: InstallationDto; record: InstallationRecord }> = {
  "claude-stream-json": {
    dto: {
      installationId: "cld-fake000000000",
      driverId: "claude-stream-json",
      state: "trusted",
      executablePath: "/fake/cld",
      fingerprint: "sha256:00",
      components: [],
      detail: null,
    },
    record: {
      installationId: "cld-fake000000000",
      driverId: "claude-stream-json",
      name: "cld",
      discoveredPath: "/fake/cld",
      realpath: "/fake/cld",
      fingerprint: "sha256:00",
      state: "trusted",
      components: [],
      detail: null,
    },
  },
  "codex-app-server": {
    dto: {
      installationId: "codex-fake0000000",
      driverId: "codex-app-server",
      state: "trusted",
      executablePath: "/fake/codex",
      fingerprint: "sha256:00",
      components: [],
      detail: null,
    },
    record: {
      installationId: "codex-fake0000000",
      driverId: "codex-app-server",
      name: "codex",
      discoveredPath: "/fake/codex",
      realpath: "/fake/codex",
      fingerprint: "sha256:00",
      state: "trusted",
      components: [],
      detail: null,
    },
  },
};

function fakeInstallationRegistry(): InstallationRegistry {
  const all = Object.values(FAKE_INSTALLATIONS).map((entry) => entry.dto);
  return {
    refresh: () => all,
    list: () => all,
    get: (installationId: string) => all.find((dto) => dto.installationId === installationId),
    revalidate: (installationId: string) => {
      const dto = all.find((candidate) => candidate.installationId === installationId);
      if (!dto) throw new Error("INSTALLATION_NOT_FOUND");
      return dto;
    },
    assertExecutable: (installationId: string) => {
      const entry = Object.values(FAKE_INSTALLATIONS).find(
        (candidate) => candidate.record.installationId === installationId,
      );
      if (!entry) throw new Error("INSTALLATION_NOT_FOUND");
      return entry.record;
    },
  } as InstallationRegistry;
}

async function createFakeRig(logLines: string[]): Promise<Rig> {
  const logger = createLogger({ sink: (line) => logLines.push(line) });
  const installations = fakeInstallationRegistry();
  const drivers = new Map<string, FakeDriver>();
  const constructions = new Map<string, number>();
  const capabilityByDriver = new Map<DriverId, DriverCapabilityState>();
  const makeFactory =
    (driverId: DriverId) =>
    (participantId: string): ParticipantDriver => {
      constructions.set(participantId, (constructions.get(participantId) ?? 0) + 1);
      const driver = createFakeDriver(participantId, driverId);
      drivers.set(participantId, driver);
      return driver;
    };
  const driverFactories = {
    "claude-stream-json": trackCapability(
      capabilityByDriver,
      "claude-stream-json",
      makeFactory("claude-stream-json"),
    ),
    "codex-app-server": trackCapability(
      capabilityByDriver,
      "codex-app-server",
      makeFactory("codex-app-server"),
    ),
  };
  const { host, scopeManager } = await assembleHost({
    installations,
    driverFactories,
    logger,
    hostInstanceId: "smoke-dry-run",
    capabilityByDriver,
  });
  return {
    kind: "fake",
    host,
    logger,
    logLines,
    spawnCount: (participantId) => constructions.get(participantId) ?? 0,
    probeSpawnCount: () =>
      [...constructions.entries()]
        .filter(([participantId]) => participantId.startsWith("probe-"))
        .reduce((total, [, count]) => total + count, 0),
    liveDriverCount: () => [...drivers.values()].filter((driver) => driver.closeCount === 0).length,
    async close() {
      await scopeManager.closeAll("smoke-cleanup").catch(() => undefined);
      await host.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Measuring client + event tap (cold/warm first-delta latency)
// ---------------------------------------------------------------------------

class MeasuringClient extends RuntimeClient {
  /** executionId -> local Date.now() captured just before POST execute. */
  readonly dispatchAtMs = new Map<string, number>();

  override async execute(scopeId: string, request: ExecuteRequest): Promise<ExecuteResponse> {
    this.dispatchAtMs.set(request.executionId, Date.now());
    return super.execute(scopeId, request);
  }
}

interface ExecutionTap {
  firstDeltaAt: string | null;
  /** Sanitized activity summaries (never bodies/paths/args). */
  activities: string[];
}

function createEventTap() {
  const executions = new Map<string, ExecutionTap>();
  return {
    executions,
    onEvent(event: RuntimeEvent): void {
      const tap = executions.get(event.executionId) ?? { firstDeltaAt: null, activities: [] };
      if (
        (event.type === "output.delta" || event.type === "output.snapshot") &&
        tap.firstDeltaAt === null
      ) {
        tap.firstDeltaAt = event.at;
      }
      if (event.type === "activity") tap.activities.push(event.summary);
      executions.set(event.executionId, tap);
    },
  };
}

// ---------------------------------------------------------------------------
// Model selection via the live catalog + readiness handshake
// ---------------------------------------------------------------------------

async function selectModel(
  client: RuntimeClient,
  profile: ExecutionProfileDto,
  hint: string,
  findings: string[],
): Promise<string> {
  let catalog: string[] = [];
  let catalogFailed = false;
  try {
    catalog = (await client.modelCatalog(profile.driverId, profile.installationId)).catalog;
  } catch (error) {
    catalogFailed = true;
    findings.push(
      `model catalog probe failed for ${profile.driverId} (${messageOf(error).slice(0, 160)}); falling back to the hint model id (recorded per smoke policy)`,
    );
  }
  const candidates = [...new Set([hint, ...catalog])];
  let hintVerified = false;
  for (const candidate of candidates) {
    let ready = false;
    try {
      const response = await client.profileReadiness(profile, candidate);
      ready =
        response.readiness.state === "ready" &&
        response.binding !== null &&
        response.binding.canonicalModelId === candidate;
    } catch {
      ready = false;
    }
    if (candidate === hint) hintVerified = ready;
    if (ready) {
      if (!catalogFailed && !catalog.includes(candidate)) {
        findings.push(
          `selected model ${candidate} via the readiness handshake although it is absent from the catalog listing (catalog/handshake drift)`,
        );
      }
      return candidate;
    }
  }
  if (!hintVerified) {
    findings.push(
      `hint model ${hint} did not verify as canonical for ${profile.driverId} (provider-side serving model drift?)`,
    );
  }
  throw new Error(
    `no canonical model verifiable for ${profile.driverId} ` +
      `(tried: ${candidates.join(", ") || "none"})`,
  );
}

// ---------------------------------------------------------------------------
// Dexie seed (same recipe as tests/integration/discussion-runtime.test.ts)
// ---------------------------------------------------------------------------

interface Seed {
  roomId: string;
  claude: Participant;
  codex: Participant;
}

async function seedRoom(
  db: CouncilKitRuntimeDB,
  input: {
    route: RouteId;
    claudeInstallationId: string;
    codexInstallationId: string;
    claudeModelId: string;
    codexModelId: string;
  },
): Promise<Seed> {
  const ts = new Date().toISOString();
  const claudeProfile: ExecutionProfileRecord = {
    id: crypto.randomUUID(),
    name: `smoke-${input.route}`,
    driverId: "claude-stream-json",
    installationId: input.claudeInstallationId,
    credentialMode: CREDENTIAL_MODE,
    options: { route: input.route },
    revision: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  const codexProfile: ExecutionProfileRecord = {
    id: crypto.randomUUID(),
    name: "smoke-codex",
    driverId: "codex-app-server",
    installationId: input.codexInstallationId,
    credentialMode: CREDENTIAL_MODE,
    options: {},
    revision: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.executionProfiles.bulkPut([claudeProfile, codexProfile]);

  const claudeAgent = createDiscussionAgent({
    name: `smoke-claude-${input.route}`,
    personaPrompt:
      "You are the Claude-side participant of a live smoke run. Answer in one short sentence.",
    executionProfileId: claudeProfile.id,
    modelId: input.claudeModelId,
    color: "#a1b2c3",
  });
  const codexAgent = createDiscussionAgent({
    name: "smoke-codex",
    personaPrompt:
      "You are the Codex-side participant and facilitator of a live smoke run. Answer in one short sentence.",
    executionProfileId: codexProfile.id,
    modelId: input.codexModelId,
    color: "#b2c3d4",
  });
  await db.agents.bulkAdd([claudeAgent, codexAgent]);

  const room = initializeRoomDigest(
    createDiscussionRoom({
      topic: `live smoke ${input.route}`,
      background: "Stage C real-environment smoke row",
      facilitatorParticipantId: "pending",
    }),
  );
  await db.rooms.add(room);

  const claude = createParticipant({
    roomId: room.id,
    agent: claudeAgent,
    profileDigest: profileDigestOf(claudeProfile),
  });
  const codex = createParticipant({
    roomId: room.id,
    agent: codexAgent,
    profileDigest: profileDigestOf(codexProfile),
  });
  // Deterministic participant order (activeParticipants sorts by createdAt):
  // claude speaks first, codex second; codex is the facilitator (Summary).
  claude.createdAt = "2026-01-01T00:00:00.000Z";
  codex.createdAt = "2026-01-01T00:00:00.001Z";
  await db.participants.bulkAdd([claude, codex]);
  room.facilitatorParticipantId = codex.id;
  await db.rooms.put(room);
  return { roomId: room.id, claude, codex };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type Role = "claude" | "codex";

interface RowReport {
  route: string;
  mode: "real" | "dry-run";
  ok: boolean;
  failure: string | null;
  installations: { claude: string | null; codex: string | null };
  models: Record<Role, { requested: string | null; effective: (string | null)[] }>;
  rounds: {
    attempted: number;
    completed: number;
    participantOrderOk: boolean;
    summariesOk: boolean;
  };
  spawnCounts: { claude: number; codex: number; probes: number };
  coldFirstDeltaMs: Record<Role, number | null>;
  warmFirstDeltaMs: Record<Role, number[]>;
  ackLeaks: number;
  closeClean: boolean | null;
  approval: { deniedByPolicy: boolean; declinedRequests: number };
  sentinel: { protected: boolean; fileChangeActivities: number };
  soak: {
    roundsDone: number;
    elapsedMs: number;
    spawnStable: boolean;
    codexThreadStable: boolean;
    uniqueRoundOutputs: boolean;
  } | null;
  findings: string[];
  notes: string[];
}

interface SmokeReport {
  tool: "live-runtime-smoke";
  generatedAt: string;
  mode: "real" | "dry-run";
  soak: boolean;
  roundsRequested: number;
  node: string;
  partial: boolean;
  ok: boolean;
  rows: RowReport[];
}

function emptyRowReport(route: string, mode: "real" | "dry-run", soak: boolean): RowReport {
  return {
    route,
    mode,
    ok: false,
    failure: null,
    installations: { claude: null, codex: null },
    models: {
      claude: { requested: null, effective: [] },
      codex: { requested: null, effective: [] },
    },
    rounds: { attempted: 0, completed: 0, participantOrderOk: true, summariesOk: true },
    spawnCounts: { claude: 0, codex: 0, probes: 0 },
    coldFirstDeltaMs: { claude: null, codex: null },
    warmFirstDeltaMs: { claude: [], codex: [] },
    ackLeaks: 0,
    closeClean: null,
    approval: { deniedByPolicy: true, declinedRequests: 0 },
    sentinel: { protected: true, fileChangeActivities: 0 },
    soak: soak
      ? {
          roundsDone: 0,
          elapsedMs: 0,
          spawnStable: true,
          codexThreadStable: true,
          uniqueRoundOutputs: true,
        }
      : null,
    findings: [],
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Row runner
// ---------------------------------------------------------------------------

function withRoundTimeout<T>(promise: Promise<T>, roundNumber: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`round ${roundNumber} exceeded ${ROUND_TIMEOUT_MS}ms`)),
        ROUND_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function runRow(
  rig: Rig,
  client: MeasuringClient,
  route: RouteId,
  options: { rounds: number; soak: boolean; onProgress: () => Promise<void> },
): Promise<RowReport> {
  const report = emptyRowReport(route, rig.kind === "real" ? "real" : "dry-run", options.soak);
  const db = new CouncilKitRuntimeDB(`smoke-${route}-${crypto.randomUUID()}`);
  const tap = createEventTap();
  /** participantId -> role, for ordered cold/warm classification. */
  const roleOf = new Map<string, Role>();
  const warmedParticipants = new Set<string>();
  const seenAnchors = new Set<string>();
  let codexParticipantId: string | null = null;
  let seedRoomId: string | null = null;

  const noteLatency = (role: Role, executionId: string): void => {
    const dispatchAt = client.dispatchAtMs.get(executionId);
    const firstDeltaAt = tap.executions.get(executionId)?.firstDeltaAt ?? null;
    if (dispatchAt === undefined || firstDeltaAt === null) {
      report.notes.push(`no first-delta measurement for execution ${executionId}`);
      return;
    }
    const deltaMs = Date.parse(firstDeltaAt) - dispatchAt;
    if (deltaMs < 0) {
      report.notes.push(`clock anomaly on execution ${executionId}; latency dropped`);
      return;
    }
    report.warmFirstDeltaMs[role].push(deltaMs);
  };

  try {
    // --- installations: discovered via the Host, matched by driverId --------
    const { installations } = await client.listInstallations();
    const claudeInstallation = installations.find(
      (dto) => dto.driverId === "claude-stream-json" && dto.state === "trusted",
    );
    const codexInstallation = installations.find(
      (dto) => dto.driverId === "codex-app-server" && dto.state === "trusted",
    );
    if (!claudeInstallation) throw new Error("no trusted claude-stream-json installation");
    if (!codexInstallation) throw new Error("no trusted codex-app-server installation");
    report.installations = {
      claude: claudeInstallation.installationId,
      codex: codexInstallation.installationId,
    };

    // --- models from the live catalog + readiness handshake -----------------
    const claudeProfileDto: ExecutionProfileDto = {
      driverId: "claude-stream-json",
      installationId: claudeInstallation.installationId,
      credentialMode: CREDENTIAL_MODE,
      options: { route },
    };
    const codexProfileDto: ExecutionProfileDto = {
      driverId: "codex-app-server",
      installationId: codexInstallation.installationId,
      credentialMode: CREDENTIAL_MODE,
      options: {},
    };
    const claudeModel = await selectModel(
      client,
      claudeProfileDto,
      FALLBACK_MODEL_HINTS[route],
      report.findings,
    );
    const codexModel = await selectModel(
      client,
      codexProfileDto,
      FALLBACK_MODEL_HINTS.codex,
      report.findings,
    );
    report.models.claude.requested = claudeModel;
    report.models.codex.requested = codexModel;

    // --- seed + orchestrator -------------------------------------------------
    const seed = await seedRoom(db, {
      route,
      claudeInstallationId: claudeInstallation.installationId,
      codexInstallationId: codexInstallation.installationId,
      claudeModelId: claudeModel,
      codexModelId: codexModel,
    });
    roleOf.set(seed.claude.id, "claude");
    roleOf.set(seed.codex.id, "codex");
    codexParticipantId = seed.codex.id;
    seedRoomId = seed.roomId;
    const orchestrator = createDiscussionOrchestrator({
      db,
      client,
      display: { onPreview: (_roomId, event) => tap.onEvent(event) },
    });

    await orchestrator.ensureScope(seed.roomId, [seed.claude, seed.codex]);
    report.spawnCounts.claude = rig.spawnCount(seed.claude.id);
    report.spawnCounts.codex = rig.spawnCount(seed.codex.id);
    if (report.spawnCounts.claude !== 1 || report.spawnCounts.codex !== 1) {
      throw new Error(
        `expected exactly one spawn per participant at scope create, saw claude=${report.spawnCounts.claude} codex=${report.spawnCounts.codex}`,
      );
    }

    // --- rounds --------------------------------------------------------------
    const startedAt = Date.now();
    let roundsDone = 0;
    for (;;) {
      roundsDone += 1;
      report.rounds.attempted = roundsDone;
      const respawnsBefore = codexRespawnCount(rig);
      const round = await withRoundTimeout(orchestrator.startRound(seed.roomId), roundsDone);
      if (!round || round.phase !== "completed") {
        const reason = round?.pauseReason;
        throw new Error(
          `round ${roundsDone} did not complete (phase=${round?.phase ?? "null"}${reason ? `, paused: ${reason.code}${reason.detail ? ` — ${reason.detail}` : ""}` : ""}). A requested/effective mismatch or unknown tool state pauses per product semantics; the row FAILS and is never papered over.`,
        );
      }

      // Participant order snapshot: claude first, codex second.
      const orderOk =
        round.participantOrder.length === 2 &&
        round.participantOrder[0] === seed.claude.id &&
        round.participantOrder[1] === seed.codex.id;
      report.rounds.participantOrderOk = report.rounds.participantOrderOk && orderOk;

      const executions = (await db.modelExecutions.where("roomId").equals(seed.roomId).toArray())
        .filter((execution) => execution.roundId === round.id)
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.executionId.localeCompare(b.executionId)
            : a.createdAt.localeCompare(b.createdAt),
        );
      if (executions.length !== 3) {
        throw new Error(`round ${roundsDone}: expected 3 executions, saw ${executions.length}`);
      }
      for (const execution of executions) {
        const role = roleOf.get(execution.participantId);
        if (!role) throw new Error(`round ${roundsDone}: unknown participant in executions`);
        if (execution.state !== "committed") {
          throw new Error(
            `round ${roundsDone}: execution not committed (state=${execution.state}, ` +
              `outcome=${execution.runtimeOutcome ?? "n/a"}, requested=${execution.requestedModel}, ` +
              `effective=${execution.effectiveModel ?? "unknown"})`,
          );
        }
        // requested vs effective — the core gate; any mismatch already paused
        // the round above, so a committed mismatch here would be a product bug.
        if (execution.effectiveModel !== execution.requestedModel) {
          throw new Error(
            `round ${roundsDone}: committed execution with effective ` +
              `${execution.effectiveModel ?? "unknown"} != requested ${execution.requestedModel}`,
          );
        }
        report.models[role].effective.push(execution.effectiveModel);
        if (warmedParticipants.has(execution.participantId)) {
          noteLatency(role, execution.executionId);
        } else {
          warmedParticipants.add(execution.participantId);
          const dispatchAt = client.dispatchAtMs.get(execution.executionId);
          const firstDeltaAt = tap.executions.get(execution.executionId)?.firstDeltaAt ?? null;
          report.coldFirstDeltaMs[role] =
            dispatchAt !== undefined && firstDeltaAt !== null
              ? Date.parse(firstDeltaAt) - dispatchAt
              : null;
        }
        if (options.soak) {
          if (seenAnchors.has(execution.executionId)) {
            if (report.soak) report.soak.uniqueRoundOutputs = false;
            throw new Error(`soak: executionId ${execution.executionId} reused across rounds`);
          }
          seenAnchors.add(execution.executionId);
          if (execution.retryOfExecutionId !== null) {
            if (report.soak) report.soak.codexThreadStable = false;
            throw new Error("soak: a retry execution appeared (session was rebuilt)");
          }
        }
      }

      // The Summary is an explicit Codex execution (facilitator = codex).
      const summaries = executions.filter((execution) => execution.resultKind === "summary");
      const summaryRows = await db.summaries.where("roundId").equals(round.id).count();
      const summariesOk =
        summaries.length === 1 &&
        summaries.every((execution) => execution.participantId === seed.codex.id) &&
        summaryRows === 1;
      report.rounds.summariesOk = report.rounds.summariesOk && summariesOk;
      if (!summariesOk) throw new Error(`round ${roundsDone}: summary assertions failed`);

      // Each round commits exactly its two participant Messages; their source
      // anchors join the cross-round uniqueness set (Message/Summary unique).
      const messageRows = await db.messages.where("roundId").equals(round.id).toArray();
      if (messageRows.length !== 2) {
        throw new Error(
          `round ${roundsDone}: expected 2 committed messages, saw ${messageRows.length}`,
        );
      }
      for (const message of messageRows) {
        const anchor = message.sourceExecutionId;
        if (!anchor || !executions.some((execution) => execution.executionId === anchor)) {
          throw new Error(`round ${roundsDone}: message anchor missing from round executions`);
        }
        if (options.soak) {
          if (seenAnchors.has(`msg:${anchor}`)) {
            if (report.soak) report.soak.uniqueRoundOutputs = false;
            throw new Error(`soak: message anchor ${anchor} reused across rounds`);
          }
          seenAnchors.add(`msg:${anchor}`);
        }
      }

      report.rounds.completed += 1;

      // --- soak-only stability assertions (flat after round 1) ---------------
      if (options.soak && report.soak) {
        report.soak.roundsDone = roundsDone;
        report.soak.elapsedMs = Date.now() - startedAt;
        if (roundsDone > 1) {
          const spawnStable =
            rig.spawnCount(seed.claude.id) === 1 && rig.spawnCount(seed.codex.id) === 1;
          const threadStable = codexRespawnCount(rig) === respawnsBefore;
          report.soak.spawnStable = report.soak.spawnStable && spawnStable;
          report.soak.codexThreadStable = report.soak.codexThreadStable && threadStable;
          if (!spawnStable) {
            throw new Error(
              `soak: spawn count grew after round 1 (claude=${rig.spawnCount(seed.claude.id)}, ` +
                `codex=${rig.spawnCount(seed.codex.id)})`,
            );
          }
          if (!threadStable) throw new Error("soak: codex driver respawned (thread rebuilt)");
        }
        await options.onProgress();
      }

      const keepGoing = options.soak
        ? roundsDone < SOAK_MIN_ROUNDS || Date.now() - startedAt < SOAK_MIN_MS
        : roundsDone < options.rounds;
      if (!keepGoing) break;
    }

    // --- final ACK scan: no pending left after completion --------------------
    const allExecutions = await db.modelExecutions.where("roomId").equals(seed.roomId).toArray();
    report.ackLeaks = allExecutions.filter((execution) => execution.ackState === "pending").length;
    if (report.ackLeaks > 0) {
      throw new Error(
        `${report.ackLeaks} execution(s) left with ackState=pending after completion`,
      );
    }

    // --- Codex policy: approval denied + read-only dedicated cwd -------------
    const declined = rig.logger
      .diagnostics()
      .filter(
        (entry) =>
          entry.kind === "codex.server_request_declined" &&
          entry.context?.participantId === codexParticipantId,
      ).length;
    report.approval = { deniedByPolicy: true, declinedRequests: declined };
    report.notes.push(
      `Codex approval-type server requests are answered {decision: denied} unconditionally (driver handleServerRequest), and thread/start fixes approvalPolicy=never with sandbox=read-only on a participant-dedicated cwd. ${
        declined > 0
          ? `${declined} decline(s) observed during this run.`
          : "No approval request arrived during this run."
      }`,
    );
    const codexExecutionIds = new Set(
      allExecutions
        .filter((execution) => execution.participantId === codexParticipantId)
        .map((execution) => execution.executionId),
    );
    const fileChangeActivities = [...tap.executions.entries()]
      .filter(([executionId]) => codexExecutionIds.has(executionId))
      .flatMap(([, entry]) => entry.activities)
      .filter((summary) => summary.includes("fileChange")).length;
    report.sentinel = { protected: fileChangeActivities === 0, fileChangeActivities };
    report.notes.push(
      "Sentinel write-attempt is out of scope; asserted from Host-surfaced signals " +
        "(zero fileChange activity under the read-only sandbox). Residual risk (plan §588): " +
        "local file reads and network access may still be governed by the user's own Codex " +
        "configuration — accepted and documented.",
    );
    if (fileChangeActivities > 0) {
      throw new Error(
        `codex executions produced ${fileChangeActivities} fileChange activit(ies) under a read-only sandbox — the dedicated-cwd sentinel expectation is violated`,
      );
    }
    if (rig.kind === "fake") {
      report.notes.push(
        "dry-run: fake drivers; approval/sentinel assertions are the static driver-config " +
          "ones only — the real sandbox is verified by the real matrix run.",
      );
    }

    report.spawnCounts.probes = rig.probeSpawnCount();
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.failure = messageOf(error);
  } finally {
    // --- normal close + machine-wide leak assertion ---------------------------
    try {
      const binding = seedRoomId
        ? await db.runtimeBindings
            .where("roomId")
            .equals(seedRoomId)
            .filter((candidate) => candidate.state === "active")
            .first()
        : undefined;
      if (binding?.executionScopeId && binding.controllerId && binding.leaseEpoch) {
        await client.closeScope(binding.executionScopeId, {
          controllerId: binding.controllerId,
          leaseEpoch: binding.leaseEpoch,
        });
      }
      for (let i = 0; i < 50 && rig.liveDriverCount() > 0; i += 1) await sleep(100);
      let clean = rig.liveDriverCount() === 0;
      if (rig.kind === "real") {
        clean = clean && pgrepCount("watchdog-child[.]mjs") === 0;
      }
      report.closeClean = clean;
      if (!clean && report.ok) {
        report.ok = false;
        report.failure = "driver processes still alive after scope close";
      }
    } catch (error) {
      report.closeClean = false;
      if (report.ok) {
        report.ok = false;
        report.failure = `scope close failed: ${messageOf(error)}`;
      }
    }
    await db.delete().catch(() => undefined);
    db.close();
  }
  return report;
}

/** Count codex respawns (process/thread rebuilds) from captured Host log lines. */
function codexRespawnCount(rig: Rig): number {
  const respawns = rig.logLines.filter((line) => line.includes('"event":"codex.respawn"')).length;
  const compactions = rig.logger
    .diagnostics()
    .filter((entry) => entry.kind === "codex.compacted").length;
  return respawns + compactions;
}

// ---------------------------------------------------------------------------
// Row isolation: one rig (real Host) per row, like the conformance tool
// ---------------------------------------------------------------------------

async function runIsolatedRow(
  kind: "real" | "fake",
  route: RouteId,
  options: { rounds: number; soak: boolean; onProgress: () => Promise<void> },
): Promise<RowReport> {
  console.error(`\n=== row ${route} (${kind === "real" ? "real" : "dry-run"}) ===`);
  const logLines: string[] = [];
  let rig: Rig | null = null;
  let report: RowReport;
  try {
    rig = kind === "real" ? await createRealRig(logLines) : await createFakeRig(logLines);
    const session = await acquireSession(rig.host.baseUrl);
    const client = new MeasuringClient({
      baseUrl: rig.host.baseUrl,
      csrfToken: session.csrfToken,
      headers: { Cookie: session.cookie, Origin: CANONICAL_ORIGIN },
    });
    await waitForHealth(client, 10_000);
    console.error("  host healthy; session acquired via document GET / (cookie + csrf meta)");
    report = await runRow(rig, client, route, options);
  } catch (error) {
    // Host/session setup failed before the row could run: record a failed row
    // and let the remaining matrix rows proceed.
    report = emptyRowReport(route, kind === "real" ? "real" : "dry-run", options.soak);
    report.failure = messageOf(error);
  } finally {
    if (rig) await rig.close();
  }
  console.error(
    `  row ${route}: ${report.ok ? "ok" : `FAIL — ${report.failure ?? "unknown"}`} ` +
      `(rounds ${report.rounds.completed}/${report.rounds.attempted}, ` +
      `spawns claude=${report.spawnCounts.claude} codex=${report.spawnCounts.codex} probes=${report.spawnCounts.probes}, ` +
      `ackLeaks=${report.ackLeaks}, closeClean=${report.closeClean ?? "n/a"})`,
  );
  return report;
}

// ---------------------------------------------------------------------------
// Human summary (stdout; counts/digests/latencies only — never bodies/tokens)
// ---------------------------------------------------------------------------

function compactEffective(values: (string | null)[]): string {
  if (values.length === 0) return "n/a";
  const unique = [...new Set(values)];
  return unique.length === 1 ? `${unique[0]} x${values.length}` : unique.join(" | ");
}

function printHumanSummary(report: SmokeReport): void {
  const out: string[] = [];
  out.push(
    `\n=== live-runtime-smoke (mode=${report.mode}, soak=${report.soak}, rounds=${report.roundsRequested}) ===`,
  );
  for (const row of report.rows) {
    out.push(`${row.ok ? "[ok]  " : "[FAIL]"} route ${row.route}`);
    out.push(
      `  models: claude ${row.models.claude.requested ?? "n/a"} -> ${compactEffective(row.models.claude.effective)}; ` +
        `codex ${row.models.codex.requested ?? "n/a"} -> ${compactEffective(row.models.codex.effective)}`,
    );
    out.push(
      `  rounds: ${row.rounds.completed}/${row.rounds.attempted} completed, ` +
        `participantOrder ${row.rounds.participantOrderOk ? "ok" : "FAIL"}, ` +
        `summaries ${row.rounds.summariesOk ? "ok" : "FAIL"}`,
    );
    out.push(
      `  spawns: claude=${row.spawnCounts.claude} codex=${row.spawnCounts.codex} probes=${row.spawnCounts.probes}; ` +
        `cold first-delta ms: claude=${row.coldFirstDeltaMs.claude ?? "n/a"} codex=${row.coldFirstDeltaMs.codex ?? "n/a"}; ` +
        `warm ms: claude=[${row.warmFirstDeltaMs.claude.join(", ")}] codex=[${row.warmFirstDeltaMs.codex.join(", ")}]`,
    );
    out.push(
      `  ackLeaks=${row.ackLeaks} closeClean=${row.closeClean ?? "n/a"} ` +
        `approvalDenied=${row.approval.deniedByPolicy} (declined=${row.approval.declinedRequests}) ` +
        `sentinelProtected=${row.sentinel.protected} (fileChange=${row.sentinel.fileChangeActivities})`,
    );
    if (row.soak) {
      out.push(
        `  soak: rounds=${row.soak.roundsDone} elapsed=${(row.soak.elapsedMs / 60000).toFixed(1)}min ` +
          `spawnStable=${row.soak.spawnStable} codexThreadStable=${row.soak.codexThreadStable} ` +
          `uniqueRoundOutputs=${row.soak.uniqueRoundOutputs}`,
      );
    }
    if (row.failure) out.push(`  failure: ${row.failure}`);
    for (const finding of row.findings) out.push(`  finding: ${finding}`);
    for (const note of row.notes) out.push(`  note: ${note}`);
  }
  out.push(report.ok ? "\nSMOKE PASSED" : "\nSMOKE FAILED");
  process.stdout.write(`${out.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  await assertExclusiveMachine();

  const mode = cli.dryRun ? ("dry-run" as const) : ("real" as const);
  const outPath = cli.out ?? (cli.soak ? "live-runtime-smoke-report.json" : null);
  const rows: RowReport[] = [];
  const buildReport = (partial: boolean): SmokeReport => ({
    tool: "live-runtime-smoke",
    generatedAt: new Date().toISOString(),
    mode,
    soak: cli.soak,
    roundsRequested: cli.rounds,
    node: process.version,
    partial,
    ok: rows.every((row) => row.ok),
    rows,
  });
  const onProgress = async (): Promise<void> => {
    if (outPath) await writeFile(outPath, `${JSON.stringify(buildReport(true), null, 2)}\n`);
  };

  if (cli.dryRun) {
    // One full synthetic row against the fake-driver rig; no real CLI touched.
    rows.push(await runIsolatedRow("fake", "ant-glm5.2", { rounds: 1, soak: false, onProgress }));
  } else {
    const selected = cli.route === "all" ? ROUTE_IDS : [cli.route];
    for (const route of selected) {
      rows.push(
        await runIsolatedRow("real", route, { rounds: cli.rounds, soak: false, onProgress }),
      );
    }
    if (cli.soak) {
      // The long-run gate: representative GLM 5.2 + Codex room, 10 consecutive
      // rounds or >= 15 minutes, whichever is LATER (plan §687-696).
      rows.push(
        await runIsolatedRow("real", "ant-glm5.2", { rounds: cli.rounds, soak: true, onProgress }),
      );
    }
  }

  const finalReport = buildReport(false);
  if (outPath) await writeFile(outPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  printHumanSummary(finalReport);
  if (!finalReport.ok) process.exit(1);
}

main().catch((error) => {
  console.error(`SMOKE ERROR: ${messageOf(error)}`);
  process.exit(1);
});
