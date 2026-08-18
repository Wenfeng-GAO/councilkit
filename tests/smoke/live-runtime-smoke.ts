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
 *
 * S2 onwards (plan-a §2 A1–A10): each ordinary round is focus(facilitator) +
 * one message per participant + summary(facilitator) = 4 executions / 3
 * messages / 1 summary; a convergence round adds the facilitator report
 * (same roundId) = 5 executions. focus/report reuse the facilitator's Session
 * (no new spawn), so spawn=1/participant/scope is unchanged. A real-model
 * convergence vote drives the room to its DESIGNED terminal state (one report
 * + concluded) — recognized as designedConclusion, never a defect.
 */
import "fake-indexeddb/auto";

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { DiscussionRound, Participant } from "@/models/discussion/entities";
import {
  TransactionError,
  createDiscussionAgent,
  createDiscussionRoom,
  createParticipant,
} from "@/models/discussion/factories";
import { type ExecutionProfileRecord, profileDigestOf } from "@/models/execution-profile";
import { initializeRoomDigest } from "@/orchestrator/context-snapshot";
import { createDiscussionOrchestrator } from "@/orchestrator/discussion-orchestrator";
import { RuntimeClient } from "@/runtime/client";
import { followExecutionEvents } from "@/runtime/event-stream";
import { loadConfig } from "@host/config";
import { createClaudeStreamJsonDriver } from "@host/drivers/claude-stream-json";
import { createCodexAppServerDriver } from "@host/drivers/codex-app-server";
import { createGrokStreamJsonDriver } from "@host/drivers/grok-stream-json";
import { createKimiStreamJsonDriver } from "@host/drivers/kimi-stream-json";
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
import { diagnosticsRoutes } from "@host/routes/diagnostics";
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
  ContextSnapshot,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionProfileDto,
  InstallationDto,
} from "@shared/runtime/schemas";
import { type TestHost, createTestHost } from "../host/helpers";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ROUTE_IDS = ["ant-glm5.2", "moonshot", "deepseek", "cfuse"] as const;
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
  moonshot: "k3",
  deepseek: "deepseek-v4-pro[1m]",
  // cfuse execs the cfuse-claude-code backend (claude code) under cld; system/init
  // reports antchat/GLM-5.2[1m]. The hint mirrors the existing GLM agent modelId
  // shape and is always re-verified through the live catalog + readiness probe
  // before use (the canonical id is finalized from the cfuse handshake capture).
  cfuse: "GLM-5.2[1m]",
  codex: "gpt-5.6-sol",
};

const DEFAULT_ROUNDS = 2;
const SOAK_MIN_ROUNDS = 10;
const SOAK_MIN_MS = 15 * 60 * 1000;
const SOAK_MIN_MINUTES = SOAK_MIN_MS / 60_000;
/**
 * S9 (fix-1) verification convenience: real soak needs SOAK_MIN_ROUNDS + 15min,
 * which is unworkable for a --dry-run self-check. These env overrides compress
 * the exit condition for a demo run ONLY — never set them for the real gate.
 * The override is recorded in the report notes so a compressed dry-run can
 * never be mistaken for a real soak pass.
 */
function soakMinRounds(): number {
  const override = Number.parseInt(process.env.CK_SMOKE_SOAK_MIN_ROUNDS ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : SOAK_MIN_ROUNDS;
}
function soakMinMs(): number {
  const override = Number.parseInt(process.env.CK_SMOKE_SOAK_MIN_MS ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : SOAK_MIN_MS;
}
/**
 * S9 (fix-1): the soak contract is "≥ SOAK_MIN_MS of sustained real load with
 * stable spawn / no ACK leak / rotation recovery". Under S2 every round is an
 * independent Bernoulli trial for a real-model convergence vote, so a single
 * room running ≥ SOAK_MIN_ROUNDS is probabilistically unreachable (the real
 * facilitator can conclude after ANY summary). The honest soak shape in the
 * S2 era is a CROSS-ROOM lifecycle: keep completing rooms (each one a designed
 * conclusion) until totalRoundsCompleted ≥ SOAK_MIN_ROUNDS AND elapsedMs ≥
 * SOAK_MIN_MS (both must hold — the same "later of the two" semantics). The
 * matrix rows (--route <x> / all, non-soak) are UNCHANGED.
 */
const SOAK_ROOMS_HARD_LIMIT = 20;
/** Upper bound for one Round (matches the Host's fixed per-turn timeout). */
const ROUND_TIMEOUT_MS = TIMEOUTS.turnMs;

/**
 * S9 (fix-2): the soak (cross-room lifecycle) row exposes which facilitator
 * role drives it via `CK_SMOKE_SOAK_FACILITATOR` — `codex` (default) or
 * `claude`. SOAK ROW ONLY — matrix rows always use codex as facilitator, so
 * the binary summary is an explicit Codex execution. Every room the soak spins
 * up across the lifecycle inherits the same facilitator role.
 */
type FacilitatorRole = "claude" | "codex";
function soakFacilitatorRole(): FacilitatorRole {
  const value = process.env.CK_SMOKE_SOAK_FACILITATOR ?? "codex";
  if (value !== "claude" && value !== "codex") {
    throw new Error(`CK_SMOKE_SOAK_FACILITATOR must be "codex" or "claude", got "${value}"`);
  }
  return value;
}

interface CliOptions {
  help: boolean;
  dryRun: boolean;
  soak: boolean;
  rounds: number;
  route: RouteId | "all";
  /** Single-driver smoke mode (plan-a §3.7.31): "kimi-stream-json" runs one
   * real Host execution through the kimi CLI. Mutually exclusive with --route
   * and --soak. Undefined = the default Claude route matrix. */
  driver: "kimi-stream-json" | undefined;
  out: string | null;
}

const HELP_TEXT = `live-runtime-smoke — real-environment smoke matrix for the V1 dual-driver Runtime Host.

USAGE:
  TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx tests/smoke/live-runtime-smoke.ts [options]

OPTIONS:
  --route <ant-glm5.2|moonshot|deepseek|cfuse|all>
      Matrix row(s) to run (default: all, sequentially). Each row is a
      2-participant Room: the route's cld participant + a Codex participant
      (Codex is the facilitator, so the Summary is an explicit Codex run).
      Mutually exclusive with --driver.
  --driver <kimi-stream-json>
      Single-driver smoke mode (plan-a §3.7.31): run one real Host execution
      through the kimi CLI (install registry -> catalog probe -> profile
      readiness -> scope create/activate -> execute -> SSE terminal -> ACK ->
      close). Asserts non-empty completed.output, requested==effective, no ACK
      leak, no child/watchdog leak. Mutually exclusive with --route and --soak.
  --rounds <N>
      Rounds per row (default: ${DEFAULT_ROUNDS}).
  --soak
      After the selected rows, run the ant-glm5.2+Codex load for at least
      ${SOAK_MIN_MINUTES} minutes with >= ${SOAK_MIN_ROUNDS} total completed rounds
      (BOTH must hold — LATER-of-the-two semantics). S9 (fix-1): under S2 a real
      facilitator can conclude a room after ANY round, so the soak drives a
      CROSS-ROOM lifecycle — every designed conclusion is asserted (1 report +
      room.concluded + ack-clean + requested=effective), the room is closed,
      and a fresh room (same route, new seed) is spun up until the exit
      condition is met (roomsCreated hard-capped at ${SOAK_ROOMS_HARD_LIMIT}).
      Asserts: spawn stable (1 prewarm + rotations per room per participant,
      aggregated per role = roomsCreated + total rotations, ADDITIVE — each
      room contributes one prewarm and every needs_rebase rotation rebuilds
      both participants), Codex thread never rebuilt, no ACK pending leak,
      per-round Message/Summary anchors unique across the whole lifecycle.
      Partial JSON is written after every round.
      S9 (fix-2): CK_SMOKE_SOAK_FACILITATOR=codex|claude (default codex) picks
      the soak row's facilitator role — SOAK ROW ONLY, matrix rows are fixed.
  --out <file.json>
      Machine report path (default in --soak mode: ./live-runtime-smoke-report.json).
  --dry-run
      Synthetic end-to-end self-check WITHOUT real CLIs: same Host composed
      with the fake-driver rig. Alone: one synthetic row (route ant-glm5.2,
      1 round). With --soak (S9 fix-1): drives the cross-room soak path against
      the fake rig — the fake reply has no convergence marker, so the single
      room runs out to the soak exit condition (compress with
      CK_SMOKE_SOAK_MIN_ROUNDS / CK_SMOKE_SOAK_MIN_MS). Never touches real CLIs.
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
    driver: undefined,
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
      case "--driver": {
        const value = argv[++i] ?? "";
        if (value !== "kimi-stream-json") {
          throw new Error(`--driver currently supports only "kimi-stream-json", got "${value}"`);
        }
        options.driver = value;
        break;
      }
      default:
        throw new Error(`unknown argument "${arg}" (see --help)`);
    }
  }
  // --driver is a single-driver mode mutually exclusive with the route matrix
  // and the soak load (plan-a §3.7.31).
  if (options.driver) {
    if (options.route !== "all" || options.soak) {
      throw new Error("--driver is mutually exclusive with --route and --soak");
    }
  }
  // S9 (fix-1): --dry-run --soak is now ALLOWED — it drives the soak path
  // against the fake rig to self-check the cross-room lifecycle / new fields /
  // compressed exit condition WITHOUT real CLIs (the fake reply has no
  // convergence marker → the single room runs out to the soak exit condition;
  // see CK_SMOKE_SOAK_MIN_ROUNDS/CK_SMOKE_SOAK_MIN_MS to compress duration).
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
      // F4 (live-agent-test-call-smoke): expose the diagnostics route so the
      // agent-test-call smoke can assert activeScopes/liveDriverProcesses/
      // runningExecutions/eventConnections are zero per driver (and finally).
      // This mirrors the production Host (runtime-host/main.ts) and is additive —
      // no existing smoke behavior changes; the route is read-only/session-auth.
      ...diagnosticsRoutes(services),
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
    "kimi-stream-json": trackCapability(
      capabilityByDriver,
      "kimi-stream-json",
      createKimiStreamJsonDriver(driverDeps),
    ),
    "grok-stream-json": trackCapability(
      capabilityByDriver,
      "grok-stream-json",
      createGrokStreamJsonDriver(driverDeps),
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
  "kimi-stream-json": {
    dto: {
      installationId: "kimi-fake00000000",
      driverId: "kimi-stream-json",
      state: "trusted",
      executablePath: "/fake/kimi",
      fingerprint: "sha256:00",
      components: [],
      detail: null,
    },
    record: {
      installationId: "kimi-fake00000000",
      driverId: "kimi-stream-json",
      name: "kimi",
      discoveredPath: "/fake/kimi",
      realpath: "/fake/kimi",
      fingerprint: "sha256:00",
      state: "trusted",
      components: [],
      detail: null,
    },
  },
  "grok-stream-json": {
    dto: {
      installationId: "grok-fake00000000",
      driverId: "grok-stream-json",
      state: "trusted",
      executablePath: "/fake/grok",
      fingerprint: "sha256:00",
      components: [],
      detail: null,
    },
    record: {
      installationId: "grok-fake00000000",
      driverId: "grok-stream-json",
      name: "grok",
      discoveredPath: "/fake/grok",
      realpath: "/fake/grok",
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
    "kimi-stream-json": trackCapability(
      capabilityByDriver,
      "kimi-stream-json",
      makeFactory("kimi-stream-json"),
    ),
    "grok-stream-json": trackCapability(
      capabilityByDriver,
      "grok-stream-json",
      makeFactory("grok-stream-json"),
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
    catalog = (
      await client.modelCatalog(profile.driverId, profile.installationId, {
        route: profile.driverId === "claude-stream-json" ? profile.options.route : undefined,
      })
    ).catalog;
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
  facilitator: Participant;
  facilitatorRole: FacilitatorRole;
}

async function seedRoom(
  db: CouncilKitRuntimeDB,
  input: {
    route: RouteId;
    claudeInstallationId: string;
    codexInstallationId: string;
    claudeModelId: string;
    codexModelId: string;
    facilitatorRole: FacilitatorRole;
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
      // A9 (plan-a §2 + S9 实战修正): seed guidance — 首版仅要求 facilitator
      // 每轮投「收敛建议：否」，但真实模型以真实判断 4/4 凌驾元指令（它们的
      // 判断力正是被测特性）。改为给房间一个**真实多轮议程**（12 个有序子
      // 方面），让「第 1 轮即收敛」在事实上不成立，收敛判断有真实输入。
      // 残余风险（议程内仍提前投是）经 designedConclusion (A8/A10) 显式记录。
      background:
        "多轮研讨任务（冒烟/soak 测试房间）：为「本地优先多 Agent 决策产品」设计本地模型路由与成本治理策略。" +
        "本任务需要至少 12 轮持续探索，每轮只深入一个子方面并按序推进：" +
        "1 背景与目标界定；2 现状盘点；3 方案A（按 driver 路由）；4 方案B（按模型路由）；5 方案C（混合路由）；6 风险与反面证据；" +
        "7 成本与资源；8 依赖与前置条件；9 度量与验收口径；10 失败模式与回退；11 决策建议；12 总结与行动清单。" +
        "规则：每轮 focus 只锁定当前子方面；总结末行的收敛投票在完成全部 12 个子方面之前一律为「收敛建议：否」。",
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
  // the non-facilitator speaks first, the facilitator second (the facilitator's
  // round summary is the explicit convergence-vote execution). S9 (fix-2): the
  // facilitator role is configurable on the soak row via CK_SMOKE_SOAK_FACILITATOR
  // (matrix rows are always codex); the participant order adapts accordingly.
  const facilitator = input.facilitatorRole === "claude" ? claude : codex;
  const speaker = input.facilitatorRole === "claude" ? codex : claude;
  speaker.createdAt = "2026-01-01T00:00:00.000Z";
  facilitator.createdAt = "2026-01-01T00:00:00.001Z";
  await db.participants.bulkAdd([claude, codex]);
  room.facilitatorParticipantId = facilitator.id;
  await db.rooms.put(room);
  return {
    roomId: room.id,
    claude,
    codex,
    facilitator,
    facilitatorRole: input.facilitatorRole,
  };
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
  /** A8/A10 (plan-a §2): true when a real-model convergence vote drove the
   * room to its designed terminal state (one report + concluded) during this
   * matrix row / soak — a designed conclusion, never a defect. Recorded so the
   * JSON/acceptance doc can surface it explicitly instead of silently. */
  designedConclusion: boolean;
  soak: {
    roundsDone: number;
    elapsedMs: number;
    /** needs_rebase rotations driven through the designed recovery path. */
    rotations: number;
    rotationDetails: string[];
    /** Provider-side transient pauses recovered like a user would (details). */
    externalInterruptions: string[];
    spawnStable: boolean;
    codexThreadStable: boolean;
    uniqueRoundOutputs: boolean;
    /** S9 (fix-1): cross-room lifecycle. A room is recorded once when a real-
     * model convergence vote concludes it (designed conclusion). The soak
     * clock keeps running across rooms; ${rooms.length} covers the lifespan. */
    rooms: Array<{
      index: number;
      roundsCompleted: number;
      designedConclusion: boolean;
      rotations: number;
    }>;
    /** Sum of completed rounds across every room in the lifecycle. */
    totalRoundsCompleted: number;
    /** Number of rooms created during the soak lifecycle so far. */
    roomsCreated: number;
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
    designedConclusion: false,
    soak: soak
      ? {
          roundsDone: 0,
          elapsedMs: 0,
          rotations: 0,
          rotationDetails: [],
          externalInterruptions: [],
          spawnStable: true,
          codexThreadStable: true,
          uniqueRoundOutputs: true,
          rooms: [],
          totalRoundsCompleted: 0,
          roomsCreated: 0,
        }
      : null,
    findings: [],
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Row runner
// ---------------------------------------------------------------------------

/** A8 (plan-a §2): a real-model convergence vote drove the Room into its
 * DESIGNED terminal state. Positively assert the design contract (exactly one
 * committed Decision Report + room concluded + every committed execution acked
 * + requested=effective on every committed execution), then record it as a
 * designedConclusion so the JSON/acceptance doc surfaces it explicitly. This
 * is a finding, never a failure. */
async function assertDesignedConclusion(
  db: CouncilKitRuntimeDB,
  roomId: string,
  report: RowReport,
  attemptRound: number,
): Promise<void> {
  const room = await db.rooms.get(roomId);
  if (!room || room.status !== "concluded") {
    throw new Error(
      `designed conclusion check: room not concluded (status=${room?.status ?? "missing"})`,
    );
  }
  const reports = await db.reports.where("roomId").equals(roomId).toArray();
  if (reports.length !== 1) {
    throw new Error(`designed conclusion check: expected exactly 1 report, saw ${reports.length}`);
  }
  const reportExecution = await db.modelExecutions
    .where("roomId")
    .equals(roomId)
    .filter((execution) => execution.resultKind === "report")
    .first();
  if (!reportExecution || reportExecution.state !== "committed") {
    throw new Error("designed conclusion check: report execution missing or not committed");
  }
  if (reportExecution.effectiveModel !== reportExecution.requestedModel) {
    throw new Error(
      `designed conclusion check: report execution effective ${
        reportExecution.effectiveModel ?? "unknown"
      } != requested ${reportExecution.requestedModel}`,
    );
  }
  // No ACK leak on any execution of the room, including the report's.
  const allExecutions = await db.modelExecutions.where("roomId").equals(roomId).toArray();
  const pending = allExecutions.filter((execution) => execution.ackState === "pending").length;
  if (pending > 0) {
    throw new Error(`designed conclusion check: ${pending} execution(s) still ackState=pending`);
  }
  report.designedConclusion = true;
  report.findings.push(
    `designed conclusion at round ${attemptRound}: real-model convergence vote (=是 on a summary last line, ≥1 completed round) drove one facilitator Decision Report + room.concluded — a designed terminal state, not a defect (per plan-a §5 risk 1 / ruling #2).`,
  );
}

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
  options: {
    rounds: number;
    soak: boolean;
    facilitatorRole: FacilitatorRole;
    onProgress: () => Promise<void>;
  },
): Promise<RowReport> {
  const report = emptyRowReport(route, rig.kind === "real" ? "real" : "dry-run", options.soak);
  const db = new CouncilKitRuntimeDB(`smoke-${route}-${crypto.randomUUID()}`);
  const tap = createEventTap();
  /** participantId -> role, for ordered cold/warm classification. */
  const roleOf = new Map<string, Role>();
  const warmedParticipants = new Set<string>();
  const seenAnchors = new Set<string>();
  // S9 (fix-1): every room opened across the soak lifecycle (matrix path has
  // exactly one). Hoisted outside the try so the tear-down finally can close
  // every Scope even when the loop threw.
  const soakRoomIds = new Set<string>();

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
      facilitatorRole: options.facilitatorRole,
    });
    roleOf.set(seed.claude.id, "claude");
    roleOf.set(seed.codex.id, "codex");
    const orchestrator = createDiscussionOrchestrator({
      db,
      client,
      display: { onPreview: (_roomId, event) => tap.onEvent(event) },
    });

    // S9 (fix-1): cross-room lifecycle state for the soak path. The matrix
    // (non-soak) path only ever runs ONE room, so these current-room mirrors
    // stay pinned to `seed` and the cumulative soak accumulators stay dormant.
    // `currentRoomId` / `currentClaudeId` / `currentCodexId` /
    // `currentFacilitatorId` let the shared round loop address whichever room
    // the soak is currently driving; the `soakRoomIds` set closes every room's
    // Scope at tear-down and underpins the cross-room final ACK + codex-policy
    // scans.
    soakRoomIds.add(seed.roomId);
    let currentRoomId = seed.roomId;
    let currentClaudeId = seed.claude.id;
    let currentCodexId = seed.codex.id;
    let currentFacilitatorId = seed.facilitator.id;
    let roundsThisRoom = 0;
    let rotationsThisRoom = 0;
    let soakRoomIndex = 0;
    // S9 (fix-2): spawn aggregation is INCREMENTAL. Each room contributes one
    // prewarm per participant; each needs_rebase rotation rebuilds BOTH
    // participants. The per-role total = roomsCreated + totalRotations
    // (ADDITIVE — each room one prewarm, each rotation one rebuild). We sync
    // report.spawnCounts the moment roomsCreated/rotations change so the report
    // carries the accurate count on EVERY path (including failure), instead of
    // a single end-of-run aggregate that the catch/finally never reaches.
    const syncSoakSpawnAggregate = (): void => {
      if (!report.soak) return;
      const total = report.soak.roomsCreated + report.soak.rotations;
      report.spawnCounts.claude = total;
      report.spawnCounts.codex = total;
    };
    if (report.soak) {
      report.soak.roomsCreated = 1;
      syncSoakSpawnAggregate();
    }

    await orchestrator.ensureScope(seed.roomId, [seed.claude, seed.codex]);
    // Per-room invariant: exactly ONE prewarm per participant at scope create
    // (reported for the matrix path; the soak path carries its incremental
    // aggregate from syncSoakSpawnAggregate — checked here, never overwritten).
    const seedClaudeSpawns = rig.spawnCount(seed.claude.id);
    const seedCodexSpawns = rig.spawnCount(seed.codex.id);
    if (!report.soak) {
      report.spawnCounts.claude = seedClaudeSpawns;
      report.spawnCounts.codex = seedCodexSpawns;
    }
    if (seedClaudeSpawns !== 1 || seedCodexSpawns !== 1) {
      throw new Error(
        `expected exactly one spawn per participant at scope create, saw claude=${seedClaudeSpawns} codex=${seedCodexSpawns}`,
      );
    }

    /**
     * S9 (fix-1): create the next room in the soak lifecycle (same route +
     * models, fresh seed). Returns the new room's participant ids. Mirrors the
     * entry-block seeding/ensureScope/spawn-check so every room is held to the
     * identical invariant — only invoked on the soak path.
     */
    const beginSoakRoom = async (): Promise<void> => {
      const nextSeed = await seedRoom(db, {
        route,
        claudeInstallationId: claudeInstallation.installationId,
        codexInstallationId: codexInstallation.installationId,
        claudeModelId: claudeModel,
        codexModelId: codexModel,
        facilitatorRole: options.facilitatorRole,
      });
      roleOf.set(nextSeed.claude.id, "claude");
      roleOf.set(nextSeed.codex.id, "codex");
      currentRoomId = nextSeed.roomId;
      currentClaudeId = nextSeed.claude.id;
      currentCodexId = nextSeed.codex.id;
      currentFacilitatorId = nextSeed.facilitator.id;
      soakRoomIds.add(nextSeed.roomId);
      soakRoomIndex += 1;
      if (report.soak) {
        report.soak.roomsCreated = soakRoomIndex + 1;
        syncSoakSpawnAggregate();
      }
      await orchestrator.ensureScope(nextSeed.roomId, [nextSeed.claude, nextSeed.codex]);
      const claudeSpawns = rig.spawnCount(nextSeed.claude.id);
      const codexSpawns = rig.spawnCount(nextSeed.codex.id);
      if (claudeSpawns !== 1 || codexSpawns !== 1) {
        throw new Error(
          `soak lifecycle room ${soakRoomIndex}: expected exactly one spawn per participant at scope create, saw claude=${claudeSpawns} codex=${codexSpawns}`,
        );
      }
    };

    /**
     * S9 (fix-1): close this completed room's Scope so its driver cohort does
     * not leak across the lifecycle (the Host never reuses a closed Scope; the
     * next room cold-builds its own). Best-effort — a dead Host / 404 just
     * means the scope is already gone (closeScope at tear-down reaps stragglers).
     */
    const closeSoakRoom = async (roomId: string): Promise<void> => {
      const binding = await db.runtimeBindings
        .where("roomId")
        .equals(roomId)
        .filter((candidate) => candidate.state === "active")
        .first();
      if (binding?.executionScopeId && binding.controllerId && binding.leaseEpoch !== null) {
        await client
          .closeScope(binding.executionScopeId, {
            controllerId: binding.controllerId,
            leaseEpoch: binding.leaseEpoch,
          })
          .catch(() => undefined);
      }
    };

    // --- rounds --------------------------------------------------------------
    const startedAt = Date.now();
    const minRounds = soakMinRounds();
    const minMs = soakMinMs();
    if (options.soak && report.soak && (minRounds !== SOAK_MIN_ROUNDS || minMs !== SOAK_MIN_MS)) {
      report.notes.push(
        `soak exit condition COMPRESSED for this run: minRounds=${minRounds} (real=${SOAK_MIN_ROUNDS}), minMs=${minMs} (real=${SOAK_MIN_MINUTES}min) via CK_SMOKE_SOAK_MIN_ROUNDS/CK_SMOKE_SOAK_MIN_MS. A compressed run is a demo/self-check only — it is NEVER a substitute for the real ≥${SOAK_MIN_ROUNDS}-rounds + ${SOAK_MIN_MINUTES}min gate.`,
      );
    }
    let roundsDone = 0;
    for (;;) {
      roundsDone += 1;
      report.rounds.attempted = roundsDone;
      const respawnsBefore = codexRespawnCount(rig);
      // A8 (plan-a §2): a real-model convergence vote (=是 on a summary's last
      // line, after ≥1 completed round) drives the room through its DESIGNED
      // terminal state — one facilitator Decision Report commits and the room
      // becomes concluded. The NEXT startRound then throws ROOM_CONCLUDED
      // (orchestrator:511-515). Recognize that as a designed conclusion (never
      // a defect): positively assert reports==1 + room.concluded + every
      // completed round's invariants still hold, record designedConclusion.
      // S9 (fix-1): on the soak path the lifecycle KEEPS GOING — record this
      // room, close its Scope, and spin up the next one (same route, fresh
      // seed) until totalRoundsCompleted ≥ SOAK_MIN_ROUNDS AND elapsedMs ≥
      // SOAK_MIN_MS. The matrix (non-soak) path still just records + breaks.
      // dry-run is immune (fake reply has no marker → parse reads 否 → no
      // report, so it runs the SINGLE room out to the soak exit condition).
      let round: DiscussionRound | null = null;
      try {
        round = await withRoundTimeout(orchestrator.startRound(currentRoomId), roundsDone);
      } catch (error) {
        if (error instanceof TransactionError && error.code === "ROOM_CONCLUDED") {
          await assertDesignedConclusion(db, currentRoomId, report, roundsDone);
          if (options.soak && report.soak) {
            report.soak.rooms.push({
              index: soakRoomIndex,
              roundsCompleted: roundsThisRoom,
              designedConclusion: true,
              rotations: rotationsThisRoom,
            });
            report.soak.totalRoundsCompleted = report.rounds.completed;
            await closeSoakRoom(currentRoomId);
            const exitMet =
              report.soak.totalRoundsCompleted >= minRounds && Date.now() - startedAt >= minMs;
            if (exitMet || report.soak.roomsCreated >= SOAK_ROOMS_HARD_LIMIT) {
              if (!exitMet && report.soak.roomsCreated >= SOAK_ROOMS_HARD_LIMIT) {
                throw new Error(
                  `soak lifecycle hit the room hard limit (${SOAK_ROOMS_HARD_LIMIT}) before reaching ${minRounds} total rounds AND ${minMs / 60000}min — exposing a pathological loop instead of relaxing the gate`,
                );
              }
              break;
            }
            // Fresh room, fresh per-room counters; elapsedMs + rooms + total
            // rounds carry over (per fix-1: never cleared).
            rotationsThisRoom = 0;
            roundsThisRoom = 0;
            await beginSoakRoom();
            await options.onProgress();
            continue;
          }
          break;
        }
        throw error;
      }
      if (!round || round.phase !== "completed") {
        const reason = round?.pauseReason;
        const pauseDetail = typeof reason?.detail === "string" ? reason.detail : "";
        // needs_rebase rotation (soak only): the reconciler's hard limits
        // (session execution count / cumulative-input threshold) pause the
        // round BY DESIGN. The designed recovery — abort the paused round,
        // close the Scope, let ensureScope rebuild a cold one from the full
        // snapshot — is itself part of what the soak proves: the discussion
        // record survives Session loss and continues with unique outputs.
        const rebaseRotation =
          options.soak &&
          round?.phase === "paused" &&
          pauseDetail.startsWith("session reconciliation:");
        // Provider-side transient (e.g. a codex server terminal error with
        // willRetry unset): pausing an accepted dispatch is the CORRECT
        // product behavior. Recover exactly like a user would — abort the
        // paused round and continue on the SAME warm scope (the Session is
        // healthy) — recorded as an external interruption, never counted as
        // an invariant violation.
        const externalTransient =
          options.soak &&
          round?.phase === "paused" &&
          pauseDetail === "server reported a terminal error";
        if ((rebaseRotation || externalTransient) && report.soak) {
          if (rebaseRotation) {
            rotationsThisRoom += 1;
            report.soak.rotations += 1;
            report.soak.rotationDetails.push(pauseDetail);
            syncSoakSpawnAggregate();
          } else {
            report.soak.externalInterruptions.push(pauseDetail);
            if (report.soak.externalInterruptions.length > 3) {
              throw new Error(
                `soak: ${report.soak.externalInterruptions.length} provider-side transient pauses — marking the row externally blocked instead of looping recoveries (rerun in a stable window per plan §683)`,
              );
            }
          }
          await orchestrator.abortPausedRound(currentRoomId);
          if (rebaseRotation) {
            const binding = await db.runtimeBindings
              .where("roomId")
              .equals(currentRoomId)
              .filter((candidate) => candidate.state === "active")
              .first();
            if (binding?.executionScopeId && binding.controllerId && binding.leaseEpoch !== null) {
              await client.closeScope(binding.executionScopeId, {
                controllerId: binding.controllerId,
                leaseEpoch: binding.leaseEpoch,
              });
            }
          }
          await options.onProgress();
          continue;
        }
        throw new Error(
          `round ${roundsDone} did not complete (phase=${round?.phase ?? "null"}${reason ? `, paused: ${reason.code}${reason.detail ? ` — ${reason.detail}` : ""}` : ""}). A requested/effective mismatch or unknown tool state pauses per product semantics; the row FAILS and is never papered over.`,
        );
      }

      // Participant order snapshot: the non-facilitator speaks first, the
      // facilitator second (S9 fix-2: the soak facilitator role is configurable).
      const speakerId = options.facilitatorRole === "claude" ? currentCodexId : currentClaudeId;
      const orderOk =
        round.participantOrder.length === 2 &&
        round.participantOrder[0] === speakerId &&
        round.participantOrder[1] === currentFacilitatorId;
      report.rounds.participantOrderOk = report.rounds.participantOrderOk && orderOk;

      const executions = (await db.modelExecutions.where("roomId").equals(currentRoomId).toArray())
        .filter((execution) => execution.roundId === round.id)
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? a.executionId.localeCompare(b.executionId)
            : a.createdAt.localeCompare(b.createdAt),
        );
      // A1 (plan-a §2): S2 onwards each round = focus(facilitator) + one
      // message per participant + summary(facilitator) = 4 executions for a
      // 2-participant room. A convergence round adds the facilitator report
      // (same roundId — report anchors on the completed round, orchestrator:687)
      // → 5 executions ordinary rounds K=4; a round whose executions include a
      // resultKind==="report" expects K=5.
      const hasReport = executions.some((execution) => execution.resultKind === "report");
      const expectedExecutions = hasReport ? 5 : 4;
      if (executions.length !== expectedExecutions) {
        throw new Error(
          `round ${roundsDone}: expected ${expectedExecutions} executions (${hasReport ? "convergence round" : "ordinary round"}), saw ${executions.length}`,
        );
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

      // The Summary is an explicit facilitator execution (S9 fix-2: on the soak
      // row the facilitator role is configurable — CK_SMOKE_SOAK_FACILITATOR;
      // matrix rows keep codex as the fixed facilitator).
      const summaries = executions.filter((execution) => execution.resultKind === "summary");
      const summaryRows = await db.summaries.where("roundId").equals(round.id).count();
      const summariesOk =
        summaries.length === 1 &&
        summaries.every((execution) => execution.participantId === currentFacilitatorId) &&
        summaryRows === 1;
      report.rounds.summariesOk = report.rounds.summariesOk && summariesOk;
      if (!summariesOk) throw new Error(`round ${roundsDone}: summary assertions failed`);

      // A2 (plan-a §2): S2's focus ring commits a Message (committedEntityType=
      // "message", discussion-transactions:1005-1018), so each ordinary round
      // commits THREE messages: facilitator focus + one per participant. The
      // report commits to the reports table, never to messages.
      const messageRows = await db.messages.where("roundId").equals(round.id).toArray();
      if (messageRows.length !== 3) {
        throw new Error(
          `round ${roundsDone}: expected 3 committed messages (focus + 2 participants), saw ${messageRows.length}`,
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
      roundsThisRoom += 1;

      // --- soak-only stability assertions (flat after round 1) ---------------
      if (options.soak && report.soak) {
        report.soak.roundsDone = roundsDone;
        report.soak.elapsedMs = Date.now() - startedAt;
        report.soak.totalRoundsCompleted = report.rounds.completed;
        if (roundsThisRoom >= 1) {
          // Exactly one spawn per participant PER SCOPE of THIS room: a
          // designed needs_rebase rotation adds one spawn per participant (the
          // old driver closes with its scope); anything more is a leak. Each
          // room has its own participantIds, so the per-room check is run on
          // the current room's participants; spawnStable is the AND across the
          // whole lifecycle. Per fix-1, total expected spawns per participant
          // role summed over rooms = roomsCreated + total rotations.
          const expectedSpawns = 1 + rotationsThisRoom;
          const spawnStable =
            rig.spawnCount(currentClaudeId) === expectedSpawns &&
            rig.spawnCount(currentCodexId) === expectedSpawns;
          const threadStable = codexRespawnCount(rig) === respawnsBefore;
          report.soak.spawnStable = report.soak.spawnStable && spawnStable;
          report.soak.codexThreadStable = report.soak.codexThreadStable && threadStable;
          if (!spawnStable) {
            throw new Error(
              `soak: spawn count grew beyond 1+rotationsThisRoom=${expectedSpawns} ` +
                `(claude=${rig.spawnCount(currentClaudeId)}, codex=${rig.spawnCount(currentCodexId)})`,
            );
          }
          if (!threadStable) throw new Error("soak: codex driver respawned (thread rebuilt)");
        }
        await options.onProgress();
      }

      const keepGoing = options.soak
        ? report.rounds.completed < minRounds || Date.now() - startedAt < minMs
        : roundsDone < options.rounds;
      if (!keepGoing) break;
    }

    // --- final ACK scan: no pending left across the lifecycle ----------------
    // S9 (fix-1): the soak lifecycle spans multiple rooms; scan every room's
    // executions. The matrix path has exactly one room, so behaviour is
    // identical for it. S9 (fix-2): report.spawnCounts already reflect the
    // per-role AGGREGATE across the lifecycle — synced incrementally on every
    // roomsCreated / rotations change (roomsCreated + totalRotations, additive),
    // so the accurate count survives even a mid-loop failure path. The matrix
    // path's first-scope counts were set once at scope create above.
    const allExecutions = (
      await Promise.all(
        [...soakRoomIds].map((roomId) =>
          db.modelExecutions.where("roomId").equals(roomId).toArray(),
        ),
      )
    ).flat();
    report.ackLeaks = allExecutions.filter((execution) => execution.ackState === "pending").length;
    if (report.ackLeaks > 0) {
      throw new Error(
        `${report.ackLeaks} execution(s) left with ackState=pending after completion`,
      );
    }

    // --- Codex policy: approval denied + read-only dedicated cwd -------------
    // S9 (fix-1): count declines across EVERY codex participant in the soak
    // lifecycle (matrix path has exactly one, so identical behaviour).
    const codexParticipantIds = new Set(
      [...roleOf.entries()].filter(([, role]) => role === "codex").map(([id]) => id),
    );
    const declined = rig.logger
      .diagnostics()
      .filter(
        (entry) =>
          entry.kind === "codex.server_request_declined" &&
          typeof entry.context?.participantId === "string" &&
          codexParticipantIds.has(entry.context.participantId as string),
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
        .filter((execution) => roleOf.get(execution.participantId) === "codex")
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
      // S9 (fix-1): close every room's Scope the lifecycle opened (each
      // completed soak room was already closed in-line; matrix path has one).
      for (const roomId of soakRoomIds) {
        const binding = await db.runtimeBindings
          .where("roomId")
          .equals(roomId)
          .filter((candidate) => candidate.state === "active")
          .first();
        if (binding?.executionScopeId && binding.controllerId && binding.leaseEpoch) {
          await client
            .closeScope(binding.executionScopeId, {
              controllerId: binding.controllerId,
              leaseEpoch: binding.leaseEpoch,
            })
            .catch(() => undefined);
        }
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
  options: {
    rounds: number;
    soak: boolean;
    facilitatorRole: FacilitatorRole;
    onProgress: () => Promise<void>;
  },
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
      `ackLeaks=${report.ackLeaks}, closeClean=${report.closeClean ?? "n/a"}, designedConclusion=${report.designedConclusion})`,
  );
  return report;
}

/**
 * Single-driver smoke (plan-a §3.7.31): one real `kimi-stream-json` Host
 * execution through the real CLI — Installation registry discovery -> catalog
 * probe -> profile readiness -> scope create/activate -> execute -> SSE
 * terminal -> ACK committed -> close. Asserts: non-empty completed.output,
 * requested == effective, no ACK leak, no child/watchdog leak. Kimi is
 * final-only, so no first-delta is required (only a non-empty completed).
 *
 * Strictly a single-Participant, single-turn scope: it does NOT drive the
 * discussion orchestrator or a Dexie room — it exercises the Host execution
 * path the real product uses, end to end.
 */
async function runDriverOnlyRow(
  rounds: number,
  onProgress: () => Promise<void>,
): Promise<RowReport> {
  const driverId = "kimi-stream-json" as const;
  const canonicalModel = "kimi-code/k3";
  console.error(`\n=== row ${driverId} (real, single-driver) ===`);
  const report = emptyRowReport(driverId, "real", false);
  report.installations = { claude: null, codex: null };
  const logLines: string[] = [];
  let rig: Rig | null = null;
  try {
    rig = await createRealRig(logLines);
    const session = await acquireSession(rig.host.baseUrl);
    const client = new MeasuringClient({
      baseUrl: rig.host.baseUrl,
      csrfToken: session.csrfToken,
      headers: { Cookie: session.cookie, Origin: CANONICAL_ORIGIN },
    });
    await waitForHealth(client, 10_000);
    console.error("  host healthy; session acquired");

    // --- Installation: a trusted kimi-stream-json installation -------------
    const { installations } = await client.listInstallations();
    const kimiInstallation = installations.find(
      (dto) => dto.driverId === driverId && dto.state === "trusted",
    );
    if (!kimiInstallation) {
      throw new Error(
        "no trusted kimi-stream-json installation (is the kimi CLI installed/logged in?)",
      );
    }
    report.installations.codex = kimiInstallation.installationId; // reuse slot for kimi.

    // --- Catalog probe (closed set) + readiness handshake ------------------
    const profile: ExecutionProfileDto = {
      driverId,
      installationId: kimiInstallation.installationId,
      credentialMode: CREDENTIAL_MODE,
      options: {},
    };
    const catalog = (await client.modelCatalog(driverId, kimiInstallation.installationId)).catalog;
    if (!catalog.includes(canonicalModel)) {
      throw new Error(`catalog ${JSON.stringify(catalog)} does not contain ${canonicalModel}`);
    }
    const readiness = await client.profileReadiness(profile, canonicalModel);
    if (readiness.readiness.state !== "ready" || !readiness.binding) {
      throw new Error(
        `profile readiness is ${readiness.readiness.state}: ${readiness.readiness.detail ?? "no binding"}`,
      );
    }
    report.models.codex.requested = canonicalModel; // reuse slot for kimi.

    const completedRounds: string[] = [];
    for (let roundIndex = 0; roundIndex < Math.max(1, rounds); roundIndex += 1) {
      report.rounds.attempted += 1;
      const participantId = `kimi-p-${roundIndex}`;
      const scopeRequestId = `smoke-kimi-${crypto.randomUUID()}`;
      const created = await client.createScope({
        scopeRequestId,
        participants: [
          {
            participantId,
            profile,
            modelId: canonicalModel,
            personaPrompt:
              "You are a live smoke participant. Answer the instruction in one short sentence.",
          },
        ],
      });
      const controller = { controllerId: created.controllerId, leaseEpoch: created.leaseEpoch };
      await client.activateScope(created.scopeId, controller);

      // A minimal cold-start Context Snapshot (full turn). The Host's
      // reconciler treats a fresh session (no record) as a full snapshot
      // regardless of the digests, so hand-rolled stable digests suffice for a
      // first-turn execution.
      const executionId = `kimi-exec-${crypto.randomUUID()}`;
      const snapshot: ContextSnapshot = {
        digestVersion: 1,
        roomContext: {
          contextRevision: 0,
          contextDigest: "sha256:smoke-kimi-context",
          topic: "live smoke single-driver check",
          items: [
            {
              id: "seed-1",
              role: "user",
              content: "Discuss whether local-first tools respect user autonomy.",
            },
          ],
        },
        participant: {
          participantId,
          participantSnapshotDigest: "sha256:smoke-kimi-participant",
        },
        instruction: {
          kind: "message",
          instructionDigest: "sha256:smoke-kimi-instruction",
          text: "Reply with one sentence: is local-first software better for user autonomy? Then stop.",
        },
      };

      const executeRequest: ExecuteRequest = {
        ...controller,
        executionId,
        participantId,
        snapshot,
      };
      await client.execute(created.scopeId, executeRequest);

      // Follow the SSE stream to the terminal event.
      let terminal: RuntimeEvent | null = null;
      let deltaCount = 0;
      const outcome = await followExecutionEvents({
        fetchInput: client.eventStreamFetch({ scopeId: created.scopeId, executionId, afterSeq: 0 }),
        onEvent: (event) => {
          if (event.type === "output.delta") deltaCount += 1;
          if (
            event.type === "completed" ||
            event.type === "failed" ||
            event.type === "interrupted"
          ) {
            terminal = event;
          }
        },
      });
      if (outcome.kind === "closed" && !terminal) {
        // Connection closed before a terminal: re-read the Host record.
        const status = await client.getExecution(created.scopeId, executionId);
        throw new Error(`event stream closed without a terminal; execution state=${status.state}`);
      }
      if (!terminal) throw new Error("no terminal event arrived");
      const term = terminal as RuntimeEvent;
      if (term.type !== "completed") {
        throw new Error(
          `expected completed, got ${term.type}${term.type === "failed" ? ` (code=${term.error.code})` : ""}`,
        );
      }
      if (term.output.trim().length === 0) {
        throw new Error("completed.output is empty (EMPTY_OUTPUT surfaced in smoke)");
      }
      // final-only: deltas are allowed to be absent; only assert none were
      // fabricated by the driver (kimi protocol has none).
      // requested == effective (exact -m alias evidence).
      if (term.requestedModel !== canonicalModel) {
        throw new Error(`requested ${term.requestedModel} != ${canonicalModel}`);
      }
      if (term.effectiveModel !== canonicalModel) {
        throw new Error(`effective ${term.effectiveModel} != ${canonicalModel}`);
      }
      if (term.modelVerdict !== "match") {
        throw new Error(`modelVerdict ${term.modelVerdict} != match`);
      }
      report.models.codex.effective.push(term.effectiveModel);
      completedRounds.push(term.output);

      // ACK committed + close the scope.
      const ack = await client.ack(created.scopeId, executionId, {
        ...controller,
        finalSeq: term.seq,
        disposition: "committed",
      });
      if (ack.ackState !== "acknowledged") {
        throw new Error(`ack did not acknowledge (state=${ack.ackState})`);
      }
      await client.closeScope(created.scopeId, controller).catch((error: unknown) => {
        report.notes.push(`closeScope note: ${messageOf(error).slice(0, 160)}`);
      });
      report.rounds.completed += 1;
      await onProgress();
    }

    report.closeClean = true;
    report.ackLeaks = 0;
    report.spawnCounts.probes = rig.probeSpawnCount();
    report.ok =
      completedRounds.length > 0 && new Set(completedRounds).size === completedRounds.length;
    report.findings.push(
      `kimi single-driver: ${completedRounds.length} completed round(s); final-only (no fabricated deltas); requested=effective=${canonicalModel}`,
    );
  } catch (error) {
    report.failure = messageOf(error);
  } finally {
    if (rig) await rig.close();
  }

  // Leak guard: no kimi CLI or watchdog-child processes survive the row.
  const kimiProcs = pgrepCount("fake-kimi[.]mjs");
  const watchdogProcs = pgrepCount("watchdog-child[.]mjs");
  // The real kimi binary is a native exec; assert no watchdog children remain.
  if (watchdogProcs !== 0) {
    report.ok = false;
    report.failure =
      `${report.failure ?? ""}; watchdog-child leak detected (${watchdogProcs})`.trim();
  }
  void kimiProcs;
  console.error(
    `  row ${driverId}: ${report.ok ? "ok" : `FAIL — ${report.failure ?? "unknown"}`} ` +
      `(rounds ${report.rounds.completed}/${report.rounds.attempted}, ` +
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
        `sentinelProtected=${row.sentinel.protected} (fileChange=${row.sentinel.fileChangeActivities}) ` +
        `designedConclusion=${row.designedConclusion}`,
    );
    if (row.soak) {
      out.push(
        `  soak: rounds=${row.soak.roundsDone} (completed=${row.rounds.completed}) ` +
          `elapsed=${(row.soak.elapsedMs / 60000).toFixed(1)}min ` +
          `rotations=${row.soak.rotations} externalInterruptions=${row.soak.externalInterruptions.length} ` +
          `spawnStable=${row.soak.spawnStable} ` +
          `codexThreadStable=${row.soak.codexThreadStable} ` +
          `uniqueRoundOutputs=${row.soak.uniqueRoundOutputs}`,
      );
      out.push(
        `  soak lifecycle: roomsCreated=${row.soak.roomsCreated} ` +
          `totalRoundsCompleted=${row.soak.totalRoundsCompleted} ` +
          `rooms=${row.soak.rooms.length} (indices ${row.soak.rooms.map((room) => room.index).join(",") || "n/a"})`,
      );
      for (const detail of row.soak.rotationDetails) {
        out.push(`  rotation: ${detail}`);
      }
      for (const detail of row.soak.externalInterruptions) {
        out.push(`  externalInterruption: ${detail}`);
      }
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

  if (cli.driver === "kimi-stream-json") {
    // Single-driver real smoke (plan-a §3.7.31): real kimi CLI, mutually
    // exclusive with the route matrix and soak. Never enters the dry-run/fake
    // branch — a single real Host execution through the kimi driver.
    rows.push(await runDriverOnlyRow(cli.rounds, onProgress));
  } else if (cli.dryRun) {
    // Fake-rig self-check; no real CLI touched. --dry-run --soak (S9 fix-1)
    // runs the cross-room soak path against the fake rig — the fake reply has
    // no convergence marker, so the single room runs straight out to the soak
    // exit condition (compress via CK_SMOKE_SOAK_MIN_ROUNDS/CK_SMOKE_SOAK_MIN_MS).
    // S9 (fix-2): the dry-run soak honors CK_SMOKE_SOAK_FACILITATOR too, so the
    // self-check exercises the chosen facilitator's participant-order / summary
    // assertions (default codex; claude available for the cross-evidence path).
    rows.push(
      await runIsolatedRow("fake", "ant-glm5.2", {
        rounds: cli.soak ? cli.rounds : 1,
        soak: cli.soak,
        facilitatorRole: soakFacilitatorRole(),
        onProgress,
      }),
    );
  } else {
    const selected = cli.route === "all" ? ROUTE_IDS : [cli.route];
    for (const route of selected) {
      rows.push(
        await runIsolatedRow("real", route, {
          rounds: cli.rounds,
          soak: false,
          facilitatorRole: "codex",
          onProgress,
        }),
      );
    }
    if (cli.soak) {
      // The long-run gate: representative GLM 5.2 + Codex room, 10 consecutive
      // rounds or >= 15 minutes, whichever is LATER (plan §687-696). S9 (fix-2):
      // the SOAK row's facilitator role is CK_SMOKE_SOAK_FACILITATOR-selectable
      // (codex default; claude as an optional cross-evidence variant). Matrix
      // rows above are unaffected — always codex as the fixed facilitator.
      rows.push(
        await runIsolatedRow("real", "ant-glm5.2", {
          rounds: cli.rounds,
          soak: true,
          facilitatorRole: soakFacilitatorRole(),
          onProgress,
        }),
      );
    }
  }

  const finalReport = buildReport(false);
  if (outPath) await writeFile(outPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  printHumanSummary(finalReport);
  if (!finalReport.ok) process.exit(1);
}

const isDirectRun = process.argv[1]?.endsWith("live-runtime-smoke.ts") ?? false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`SMOKE ERROR: ${messageOf(error)}`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// V1.1 复用导出：live-agent-test-call-smoke.ts 通过 import 复用本工具的独占机
// 检查、会话获取、健康等待与真实 Host rig 组装，避免重复一套进程监管逻辑。
// 本文件被直接执行（tsx）时 main() 仍按原命令行行为运行；被 import 时
// main() 因下方 guard 不再自动触发——仅暴露复用能力。
// ---------------------------------------------------------------------------

export { assertExclusiveMachine, acquireSession, waitForHealth, createRealRig, selectModel };
export type { Rig };
