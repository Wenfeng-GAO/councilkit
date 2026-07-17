/**
 * E2E Runtime Host entry (U6) — run with tsx, NEVER shipped in production.
 *
 * Composes the REAL runtime server (createRuntimeServer) in PRODUCTION mode
 * (serving dist/ with CSRF meta + session cookie injection) but swaps the CLI
 * process drivers for scriptable in-process fakes, and adds a test-only
 * control route namespace under /api/v1/__test__/. The production entry
 * (runtime-host/main.ts) is untouched; nothing here imports vite.
 *
 * Control namespace (session-auth only, no CSRF — the Playwright browser
 * context carries the session cookie after the first document load):
 *   POST /api/v1/__test__/reset        — closeAll scopes + clear executions +
 *                                        restore driver behaviors/counters and
 *                                        installation states to defaults.
 *   POST /api/v1/__test__/driver       — {participantId, behavior} merges
 *                                        behavior overrides. Drivers are
 *                                        created per Participant at Scope
 *                                        creation and read their behavior
 *                                        lazily per call, so configuring any
 *                                        time before the round starts is
 *                                        enough (and re-configuring between
 *                                        rounds also works).
 *   GET  /api/v1/__test__/counters     — per-participant driver counters.
 *   POST /api/v1/__test__/drop-events  — cleanly res.end() all currently open
 *                                        SSE event responses so the app's
 *                                        followExecutionEvents resolves
 *                                        "closed" and the afterSeq reconnect
 *                                        path runs.
 *   POST /api/v1/__test__/resume       — release all held fake drivers
 *                                        (pauseAfterEvents holds).
 *   POST /api/v1/__test__/installation — {installationId, state} flips a fake
 *                                        installation's trust state.
 */
import type { ServerResponse } from "node:http";
import {
  DRIVER_IDS,
  type DispatchState,
  type DriverId,
  INSTALLATION_STATES,
  type InstallationState,
  type ToolState,
} from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";
import type { ModelVerdict } from "@shared/runtime/events";
import type { InstallationDto } from "@shared/runtime/schemas";
import { z } from "zod";
import { loadConfig } from "../../runtime-host/config";
import type {
  Emit,
  ExecuteInput,
  ParticipantDriver,
  PrewarmInput,
  PrewarmResult,
} from "../../runtime-host/drivers/types";
import { createExecutionRegistry } from "../../runtime-host/executions/execution-registry";
import {
  InstallationError,
  type InstallationRecord,
  type InstallationRegistry,
} from "../../runtime-host/installations/registry";
import { createLogger } from "../../runtime-host/logging";
import { createProfileProbe } from "../../runtime-host/profiles/probe";
import { healthRoutes } from "../../runtime-host/routes/health";
import { installationRoutes } from "../../runtime-host/routes/installations";
import { modelRoutes } from "../../runtime-host/routes/models";
import { scopeRoutes } from "../../runtime-host/routes/scopes";
import { createScopeManager } from "../../runtime-host/scopes/scope-manager";
import { createSessionReconciler } from "../../runtime-host/scopes/session-reconciler";
import { createSessionCapability } from "../../runtime-host/security/session-capability";
import { type HostServices, type Route, createRuntimeServer } from "../../runtime-host/server";

// Force production mode before loadConfig() reads the environment: the E2E
// host must serve the built dist/ exactly like the shipped Host does.
process.env.COUNCILKIT_MODE = "production";

// ---------------------------------------------------------------------------
// Scripted fake drivers
// ---------------------------------------------------------------------------

export interface DriverBehavior {
  /** Closed canonical catalog reported by prewarm (canonical = first entry). */
  catalog?: string[];
  /** Aliases the driver declares equivalent to the canonical id. */
  aliases?: string[];
  /** Static reply body; defaults to `reply-<participantId>-<executeCount>`. */
  reply?: string;
  /** effectiveModel on the completed terminal; defaults to the requested id. */
  effectiveModel?: string | null;
  modelVerdict?: ModelVerdict;
  toolState?: ToolState;
  /** prewarm rejects with a DRIVER_SPAWN_FAILED error. */
  prewarmFails?: boolean;
  /** execute emits started + failed terminal with these facts. */
  failWith?: {
    error: { code: string; message: string };
    retryable: boolean;
    dispatchState: DispatchState;
  };
  /** execute holds after `started` until cancel() emits interrupted. */
  hangUntilCancel?: boolean;
  /** execute holds after emitting N events until /__test__/resume or 300ms. */
  pauseAfterEvents?: number;
}

interface DriverCounters {
  prewarmCount: number;
  executeCount: number;
  closeCount: number;
  cancelCount: number;
}

interface ParticipantRig {
  behavior: DriverBehavior;
  counters: DriverCounters;
  /** Pending hold releases (pauseAfterEvents). */
  holds: Set<() => void>;
  /** Pending cancel continuation (hangUntilCancel). */
  pendingCancel: (() => void) | null;
}

const DEFAULT_CATALOGS: Record<DriverId, string[]> = {
  "claude-stream-json": ["e2e-claude-model"],
  "codex-app-server": ["e2e-codex-model"],
};

const rigs = new Map<string, ParticipantRig>();

function rigFor(participantId: string): ParticipantRig {
  let rig = rigs.get(participantId);
  if (!rig) {
    rig = {
      behavior: {},
      counters: { prewarmCount: 0, executeCount: 0, closeCount: 0, cancelCount: 0 },
      holds: new Set(),
      pendingCancel: null,
    };
    rigs.set(participantId, rig);
  }
  return rig;
}

function releaseHolds(rig: ParticipantRig): number {
  const count = rig.holds.size;
  for (const release of [...rig.holds]) release();
  return count;
}

function createScriptedDriver(driverId: DriverId, participantId: string): ParticipantDriver {
  const rig = rigFor(participantId);
  let sessionEpoch = 0;

  const behavior = (): DriverBehavior => rig.behavior;
  const catalog = (): string[] => behavior().catalog ?? DEFAULT_CATALOGS[driverId];

  async function emitTurn(input: ExecuteInput, emit: Emit): Promise<void> {
    const reply = behavior().reply ?? `reply-${participantId}-${rig.counters.executeCount}`;
    const events: (() => void)[] = [
      () => emit({ type: "started", requestedModel: input.modelId }),
      () => emit({ type: "output.delta", text: reply.slice(0, Math.ceil(reply.length / 2)) }),
      () => emit({ type: "output.delta", text: reply.slice(Math.ceil(reply.length / 2)) }),
      () => emit({ type: "usage", usage: { inputTokens: 120, outputTokens: 5 } }),
      () =>
        emit({
          type: "completed",
          output: reply,
          requestedModel: input.modelId,
          effectiveModel:
            behavior().effectiveModel === undefined ? input.modelId : behavior().effectiveModel,
          modelVerdict: behavior().modelVerdict ?? "match",
          toolState: behavior().toolState ?? "none",
          dispatchState: "accepted",
          usage: { inputTokens: 120, outputTokens: 5 },
          finalSeq: 0, // the registry stamps the authoritative finalSeq
        }),
    ];
    const pauseAfter = behavior().pauseAfterEvents;
    for (let index = 0; index < events.length; index += 1) {
      if (pauseAfter !== undefined && index === pauseAfter) {
        // Hold so a test can drop the SSE connection mid-stream; released by
        // POST /api/v1/__test__/resume or a bounded 300ms fallback timer.
        await new Promise<void>((resolveHold) => {
          const timer = setTimeout(() => {
            rig.holds.delete(release);
            resolveHold();
          }, 300);
          const release = () => {
            clearTimeout(timer);
            rig.holds.delete(release);
            resolveHold();
          };
          rig.holds.add(release);
        });
      }
      // Yield between events so the SSE stream flushes each one live.
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      events[index]?.();
    }
  }

  return {
    participantId,
    driverId,
    get sessionEpoch() {
      return sessionEpoch;
    },
    prewarm(_input: PrewarmInput): Promise<PrewarmResult> {
      rig.counters.prewarmCount += 1;
      if (behavior().prewarmFails) {
        const error = makeError(
          "DRIVER_SPAWN_FAILED",
          "prewarm",
          `e2e scripted prewarm failure for ${participantId}`,
        );
        return Promise.reject(Object.assign(new Error(error.message), { runtimeCode: error.code }));
      }
      const list = catalog();
      return Promise.resolve({
        canonicalModelId: list[0] as string,
        modelAliases: behavior().aliases ?? [],
        capability: { protocol: "e2e-fake" },
        catalog: list,
      });
    },
    execute(input: ExecuteInput, emit: Emit): Promise<void> {
      rig.counters.executeCount += 1;
      const failWith = behavior().failWith;
      if (failWith) {
        emit({ type: "started", requestedModel: input.modelId });
        emit({
          type: "failed",
          error: makeError(
            failWith.error.code as RuntimeError["code"],
            "stream",
            failWith.error.message,
            { retryable: failWith.retryable },
          ),
          dispatchState: failWith.dispatchState,
          toolState: "none",
          retryable: failWith.retryable,
        });
        return Promise.resolve();
      }
      if (behavior().hangUntilCancel) {
        emit({ type: "started", requestedModel: input.modelId });
        return new Promise<void>((resolveHang) => {
          rig.pendingCancel = () => {
            rig.pendingCancel = null;
            emit({
              type: "interrupted",
              reason: "user_cancelled",
              dispatchState: "accepted",
              toolState: "none",
            });
            resolveHang();
          };
        });
      }
      return emitTurn(input, emit);
    },
    cancel(): Promise<void> {
      rig.counters.cancelCount += 1;
      rig.pendingCancel?.();
      releaseHolds(rig);
      return Promise.resolve();
    },
    close(): Promise<void> {
      rig.counters.closeCount += 1;
      sessionEpoch += 1;
      return Promise.resolve();
    },
    capabilityState: () => "ready",
    contextWindowTokens: () => null,
  };
}

// ---------------------------------------------------------------------------
// Fake installation registry (two trusted installations, mutable state)
// ---------------------------------------------------------------------------

const FAKE_INSTALLATIONS: Record<
  string,
  { driverId: DriverId; name: "cld" | "codex"; path: string }
> = {
  "claude-e2e-fake01": { driverId: "claude-stream-json", name: "cld", path: "/fake/cld" },
  "codex-e2e-fake001": { driverId: "codex-app-server", name: "codex", path: "/fake/codex" },
};

const installationStates = new Map<string, InstallationState>(
  Object.keys(FAKE_INSTALLATIONS).map((id) => [id, "trusted"]),
);

function installationDto(installationId: string): InstallationDto {
  const base = FAKE_INSTALLATIONS[installationId];
  if (!base) throw new Error(`unknown fake installation ${installationId}`);
  return {
    installationId,
    driverId: base.driverId,
    state: installationStates.get(installationId) ?? "trusted",
    executablePath: base.path,
    fingerprint: "sha256:00",
    components: [],
    detail: null,
  };
}

function installationFailure(code: RuntimeError["code"], message: string): InstallationError {
  return new InstallationError(makeError(code, "discovery", message, { retryable: false }));
}

const fakeInstallationRegistry: InstallationRegistry = {
  refresh: () => Object.keys(FAKE_INSTALLATIONS).map(installationDto),
  list: () => Object.keys(FAKE_INSTALLATIONS).map(installationDto),
  get: (installationId: string) =>
    installationId in FAKE_INSTALLATIONS ? installationDto(installationId) : undefined,
  revalidate: (installationId: string) => {
    if (!(installationId in FAKE_INSTALLATIONS)) {
      throw installationFailure(
        "INSTALLATION_NOT_FOUND",
        `Unknown installation "${installationId}".`,
      );
    }
    // Re-validation of a drifted fake succeeds and restores trust.
    installationStates.set(installationId, "trusted");
    return installationDto(installationId);
  },
  assertExecutable: (installationId: string): InstallationRecord => {
    if (!(installationId in FAKE_INSTALLATIONS)) {
      throw installationFailure(
        "INSTALLATION_NOT_FOUND",
        `Unknown installation "${installationId}".`,
      );
    }
    const dto = installationDto(installationId);
    if (dto.state === "not_found") {
      throw installationFailure(
        "INSTALLATION_NOT_FOUND",
        `Installation "${installationId}" is missing.`,
      );
    }
    if (dto.state === "changed") {
      throw installationFailure(
        "INSTALLATION_CHANGED",
        `Installation "${installationId}" changed since validation.`,
      );
    }
    if (dto.state !== "trusted") {
      throw installationFailure(
        "INSTALLATION_UNTRUSTED",
        `Installation "${installationId}" is ${dto.state}, not trusted.`,
      );
    }
    const base = FAKE_INSTALLATIONS[installationId];
    return {
      installationId,
      driverId: base.driverId,
      name: base.name,
      discoveredPath: base.path,
      realpath: base.path,
      fingerprint: "sha256:00",
      state: dto.state,
      components: [],
      detail: null,
    };
  },
};

// ---------------------------------------------------------------------------
// Test-only control routes
// ---------------------------------------------------------------------------

const TEST_BASE = "/api/v1/__test__";

/** Open SSE event responses, registered by the wrapped events route below. */
const openEventStreams = new Set<ServerResponse>();

function dropOpenEventStreams(): number {
  const targets = [...openEventStreams];
  for (const res of targets) {
    // Swallow post-end writes (15s heartbeat, late driver events) so the
    // cleanup is a clean close, never a write-after-end crash.
    res.write = (() => true) as typeof res.write;
    const realEnd = res.end.bind(res);
    res.end = (() => res) as typeof res.end;
    realEnd();
    openEventStreams.delete(res);
  }
  return targets.length;
}

// The REAL Host quota `scopeCreatesPerMinute = 10` is load-bearing in
// production, but the full E2E suite shares ONE host and creates a scope per
// room — 17 specs in ~90s would 429 the tail specs. The scope manager's
// `now` is the official test injection point: reset moves the clock FORWARD
// so every previously recorded create timestamp falls out of the 60s rate
// window (now() is used only by that window).
let quotaWindowOffsetMs = 0;

function resetAll(
  scopeManager: { closeAll(reason: string): Promise<void> },
  executions: { reset(): void },
) {
  return async (): Promise<{ reset: true }> => {
    await scopeManager.closeAll("e2e-reset");
    executions.reset();
    dropOpenEventStreams();
    for (const rig of rigs.values()) {
      releaseHolds(rig);
      rig.pendingCancel = null;
    }
    rigs.clear();
    for (const id of Object.keys(FAKE_INSTALLATIONS)) installationStates.set(id, "trusted");
    quotaWindowOffsetMs += 61_000;
    return { reset: true };
  };
}

function testRoutes(
  scopeManager: { closeAll(reason: string): Promise<void> },
  executions: { reset(): void },
): Route[] {
  const doReset = resetAll(scopeManager, executions);
  return [
    {
      method: "POST",
      pattern: `${TEST_BASE}/reset`,
      auth: "session",
      handler: () => doReset(),
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/driver`,
      auth: "session",
      bodySchema: z.object({
        participantId: z.string().min(1),
        behavior: z.record(z.string(), z.unknown()),
      }),
      handler: ({ body }) => {
        const { participantId, behavior } = body as {
          participantId: string;
          behavior: DriverBehavior;
        };
        const rig = rigFor(participantId);
        rig.behavior = { ...rig.behavior, ...behavior };
        return { participantId, behavior: rig.behavior };
      },
    },
    {
      method: "GET",
      pattern: `${TEST_BASE}/counters`,
      auth: "session",
      handler: () => {
        const counters: Record<string, DriverCounters> = {};
        for (const [participantId, rig] of rigs) counters[participantId] = { ...rig.counters };
        return { counters };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/drop-events`,
      auth: "session",
      handler: () => ({ dropped: dropOpenEventStreams() }),
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/resume`,
      auth: "session",
      handler: () => {
        let released = 0;
        for (const rig of rigs.values()) released += releaseHolds(rig);
        return { released };
      },
    },
    {
      method: "POST",
      pattern: `${TEST_BASE}/installation`,
      auth: "session",
      bodySchema: z.object({
        installationId: z.string().min(1),
        state: z.enum(INSTALLATION_STATES),
      }),
      handler: ({ body }) => {
        const { installationId, state } = body as {
          installationId: string;
          state: InstallationState;
        };
        if (!(installationId in FAKE_INSTALLATIONS)) {
          throw installationFailure(
            "INSTALLATION_NOT_FOUND",
            `Unknown installation "${installationId}".`,
          );
        }
        installationStates.set(installationId, state);
        return { installation: installationDto(installationId) };
      },
    },
  ];
}

/** Wrap the scopes events route so open SSE responses are tracked (and can be
 * cleanly dropped by /__test__/drop-events). All other routes pass through. */
function withEventStreamTracking(routes: Route[]): Route[] {
  return routes.map((route) => {
    if (!route.pattern.endsWith("/events") || !route.raw) return route;
    return {
      ...route,
      handler: (ctx: Parameters<Route["handler"]>[0]) => {
        const { res } = ctx;
        const originalWriteHead = res.writeHead.bind(res);
        res.writeHead = ((...args: Parameters<ServerResponse["writeHead"]>) => {
          openEventStreams.add(res);
          res.once("close", () => openEventStreams.delete(res));
          return originalWriteHead(...args);
        }) as ServerResponse["writeHead"];
        return route.handler(ctx);
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Host assembly (mirrors runtime-host/main.ts, minus real CLI processes)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const logLines: string[] = [];
  const logger = createLogger({
    sink: (line) => {
      logLines.push(line);
      if (process.env.E2E_HOST_LOG) process.stdout.write(`[e2e-host] ${line}\n`);
    },
  });
  const session = createSessionCapability();
  const hostInstanceId = "e2e-host";

  const executions = createExecutionRegistry({ logger });
  const reconciler = createSessionReconciler();
  const driverFactories = {
    "claude-stream-json": (participantId: string) =>
      createScriptedDriver("claude-stream-json", participantId),
    "codex-app-server": (participantId: string) =>
      createScriptedDriver("codex-app-server", participantId),
  };

  const scopeManager = createScopeManager({
    installations: fakeInstallationRegistry,
    executions,
    reconciler,
    driverFactories,
    logger,
    hostInstanceId,
    now: () => Date.now() + quotaWindowOffsetMs,
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
    hostInstanceId,
    startedAt: new Date().toISOString(),
    installationRegistry: fakeInstallationRegistry,
    executionRegistry: executions,
    scopeManager,
    profileProbe,
    driverCapabilities: () =>
      DRIVER_IDS.map((driverId) => ({ driverId, capability: "ready" as const })),
  };

  const routes: Route[] = [
    ...healthRoutes(services),
    ...installationRoutes(services),
    ...modelRoutes(services),
    ...withEventStreamTracking(scopeRoutes(services)),
    ...testRoutes(scopeManager, executions),
  ];

  const runtime = createRuntimeServer({ services, routes });
  await runtime.listen();
  process.stdout.write(`E2E_HOST_READY ${config.hostname}:${config.port}\n`);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    void (async () => {
      await scopeManager.closeAll(signal).catch(() => undefined);
      await runtime.close().catch(() => undefined);
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
