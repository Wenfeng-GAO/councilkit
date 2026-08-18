import { randomUUID } from "node:crypto";
import type { DriverId } from "@shared/runtime/contracts";
import type {
  ClaudeRoute,
  ExecutionProfileDto,
  ModelCatalogResponse,
  ParticipantSpec,
  ResolveProfileResponse,
} from "@shared/runtime/schemas";
import type { ParticipantDriver } from "../drivers/types";
import {
  InstallationError,
  type InstallationRecord,
  type InstallationRegistry,
} from "../installations/registry";
import type { Logger } from "../logging";
import { buildBinding, digestOf, resolveStatic } from "./resolver";
import type { ResolveResult } from "./resolver";

/**
 * Dynamic Profile readiness probe. Runs the exact handshake execution uses —
 * `resolveStatic` → `assertExecutable` (fresh fingerprint revalidation) →
 * `driver.prewarm` → `buildBinding` — against a throwaway probe driver that
 * is always closed, so no CLI process can leak. The probe never touches
 * scopes, the execution registry or the reconciler.
 *
 * Results are cached in the `createProfileProbe` closure (per-rig, never a
 * module singleton): a successful readiness/catalog handshake is cached 60s
 * keyed by `digestOf(profile) + ":" + modelId` (readiness) / `driverId +
 * ":" + installationId + ":" + effectiveRoute` (catalog); a failed readiness
 * handshake is cached with a 2s/10s/30s backoff window (catalog failures
 * rethrow the cached error so 4xx semantics stay untouched). `refresh` forces
 * a fresh handshake; `invalidateInstallation` drops everything referencing an
 * installation (called by the revalidate route). The execution path does not
 * read this cache — true spawn time always pays a fresh fingerprint check.
 *
 * Composed once in `main.ts` (and per-rig in tests) via `createProfileProbe`;
 * the readiness and model-catalog routes resolve it from
 * `services.profileProbe`.
 */

export interface ProfileProbeDeps {
  installations: InstallationRegistry;
  /** Same composed per-driver factories the scope manager receives. */
  driverFactories: Record<string, (participantId: string) => ParticipantDriver>;
  logger: Logger;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

export interface ProfileProbeOptions {
  /** Bypass the cache + backoff window and force a fresh handshake. */
  refresh?: boolean;
}

export interface ProfileProbe {
  readiness(
    profile: ExecutionProfileDto,
    modelId: string,
    options?: ProfileProbeOptions,
  ): Promise<ResolveProfileResponse>;
  /**
   * Closed canonical model catalog of a trusted installation's driver. The
   * catalog is model-agnostic, so the probe prewarms with a placeholder
   * modelId and returns `prewarm.catalog` verbatim. For claude-stream-json
   * the catalog is route-specific — pass the profile's `route` (defaults to
   * `ant-glm5.2`). A driver whose handshake validates the requested model
   * (codex) rejects the placeholder with MODEL_UNAVAILABLE carrying the
   * served catalog — the probe returns that catalog, which is exactly the
   * data the choose-model repair path needs. Throws `InstallationError`
   * (unknown/changed/untrusted installation) or an Error carrying
   * `runtimeCode` for other handshake failures — the route maps those to
   * HTTP errors; a catalog is never fabricated.
   */
  catalog(
    driverId: DriverId,
    installationId: string,
    route?: ClaudeRoute,
    options?: ProfileProbeOptions,
  ): Promise<ModelCatalogResponse>;
  /** Drop every cache entry that references this installation (revalidate). */
  invalidateInstallation(installationId: string): void;
  /** Test-only: full cache reset (e2e /reset isolation). */
  clearCache(): void;
}

const MAX_DETAIL = 256;

/** Placeholder modelId for the model-agnostic catalog handshake. */
const CATALOG_PROBE_MODEL_ID = "__catalog__";

/** Fresh success cache lifetime (ms). */
const CACHE_TTL_MS = 60_000;
/** Consecutive-failure backoff window sequence (ms): 2s → 10s → 30s (capped). */
const BACKOFF_MS = [2_000, 10_000, 30_000] as const;

interface CacheEntry<T> {
  /** Redundant copy so invalidateInstallation can scan without parsing keys. */
  installationId: string;
  value: T;
  /** Catalog failures cache the thrown error to rethrow the same instance. */
  error?: unknown;
  cachedAtMs: number;
  /** Consecutive failure count; reset to 0 on a success. */
  failures: number;
  /** When failures > 0: the deadline before another live handshake is allowed. */
  nextAllowedAt: number;
}

/** Index into BACKOFF_MS, capped at the last (30s) slot. */
function backoffSlot(failures: number): number {
  return Math.min(failures, BACKOFF_MS.length - 1);
}

export function createProfileProbe(deps: ProfileProbeDeps): ProfileProbe {
  const { installations, driverFactories, logger } = deps;
  const now = deps.now ?? Date.now;
  const readinessCache = new Map<string, CacheEntry<ResolveProfileResponse>>();
  const catalogCache = new Map<string, CacheEntry<ModelCatalogResponse>>();
  // V2: per-installation generation counter. invalidateInstallation bumps it; a
  // handshake records its start generation and writes the cache entry ONLY when
  // that generation is still current at settle. This stops an in-flight (hung)
  // handshake from overwriting a cache that was invalidated mid-flight: by the
  // time the stale handshake settles its generation is superseded, so its entry
  // is discarded and the next request re-handshakes against the live install.
  const installationGenerations = new Map<string, number>();

  function installationGateError(error: InstallationError): ResolveResult {
    const code = error.runtimeError.code;
    return {
      readiness: {
        // Drift detected by the fresh revalidation (or a vanished installation)
        // invalidates the static binding; anything else (e.g. untrusted) means
        // the runtime cannot serve it right now.
        state:
          code === "INSTALLATION_CHANGED" || code === "INSTALLATION_NOT_FOUND"
            ? "invalid_binding"
            : "runtime_unavailable",
        detail: error.message.slice(0, MAX_DETAIL),
      },
      binding: null,
    };
  }

  /**
   * Shared static gate + fresh fingerprint revalidation + probe driver
   * construction. Throws `InstallationError` on any installation gate failure
   * and `Error` when no factory is registered for the driver.
   */
  function gateProbeDriver(
    profile: ExecutionProfileDto,
    modelId: string,
  ): { driver: ParticipantDriver; installation: InstallationRecord; spec: ParticipantSpec } {
    const staticResolution = resolveStatic(profile, modelId, installations);
    if (!staticResolution.installation || staticResolution.readiness.state !== "ready") {
      throw new InstallationError(
        staticResolution.readiness.state === "invalid_binding"
          ? {
              code: "INSTALLATION_NOT_FOUND",
              phase: "discovery",
              retryable: false,
              message: staticResolution.readiness.detail ?? "static binding failed",
            }
          : {
              code: "INSTALLATION_UNTRUSTED",
              phase: "discovery",
              retryable: false,
              message: staticResolution.readiness.detail ?? "installation is not trusted",
            },
      );
    }

    // Same spawn gate as execution: fresh fingerprint revalidation.
    const installation = installations.assertExecutable(
      staticResolution.installation.installationId,
    );

    const factory = driverFactories[profile.driverId];
    if (!factory) {
      throw new Error(`No driver factory is registered for "${profile.driverId}".`);
    }

    const participantId = `probe-${randomUUID()}`;
    const spec: ParticipantSpec = { participantId, profile, modelId };
    return { driver: factory(participantId), installation, spec };
  }

  async function runReadinessHandshake(
    profile: ExecutionProfileDto,
    modelId: string,
  ): Promise<ResolveResult> {
    // Static gate first: schema-valid DTO + trusted installation, no spawn.
    let gated: ReturnType<typeof gateProbeDriver>;
    try {
      gated = gateProbeDriver(profile, modelId);
    } catch (error) {
      if (error instanceof InstallationError) return installationGateError(error);
      // No registered factory: a runtime gap, not an HTTP error.
      return {
        readiness: {
          state: "runtime_unavailable",
          detail: error instanceof Error ? error.message.slice(0, MAX_DETAIL) : "probe failed",
        },
        binding: null,
      };
    }

    const { driver, installation, spec } = gated;
    try {
      const prewarm = await driver.prewarm({
        participantId: spec.participantId,
        spec,
        installation,
      });
      return buildBinding(spec, installation, prewarm);
    } catch (error) {
      // Same mapping as the scope manager: driver-reported unavailability
      // becomes a readiness state, never an HTTP error.
      const runtimeCode = (error as { runtimeCode?: string }).runtimeCode;
      logger.warn("profile.probe_failed", {
        driverId: profile.driverId,
        code: runtimeCode ?? "UNKNOWN",
      });
      return {
        readiness: {
          state: runtimeCode === "MODEL_UNAVAILABLE" ? "model_unavailable" : "runtime_unavailable",
          detail: error instanceof Error ? error.message.slice(0, MAX_DETAIL) : "prewarm failed",
        },
        binding: null,
      };
    } finally {
      // Best effort: a probe must never leak a CLI process.
      await driver.close().catch(() => undefined);
    }
  }

  async function runCatalogHandshake(
    driverId: DriverId,
    installationId: string,
    route?: ClaudeRoute,
  ): Promise<{ catalog: string[] }> {
    // Catalog needs no real profile options beyond the claude route; the
    // schema-valid minimal DTO only carries the binding target. Explicit
    // three-branch construction avoids an implicit "non-claude == codex"
    // type assumption now that a third driver exists.
    let profile: ExecutionProfileDto;
    if (driverId === "claude-stream-json") {
      profile = {
        driverId,
        installationId,
        credentialMode: "installation-managed",
        options: { route: route ?? "ant-glm5.2" },
      };
    } else if (driverId === "codex-app-server") {
      profile = {
        driverId,
        installationId,
        credentialMode: "installation-managed",
        options: {},
      };
    } else {
      // kimi-stream-json / grok-stream-json: empty options (model on the Agent).
      profile = {
        driverId,
        installationId,
        credentialMode: "installation-managed",
        options: {},
      };
    }
    const { driver, installation, spec } = gateProbeDriver(profile, CATALOG_PROBE_MODEL_ID);
    try {
      const prewarm = await driver.prewarm({
        participantId: spec.participantId,
        spec,
        installation,
      });
      return { catalog: prewarm.catalog };
    } catch (error) {
      // A model-validating handshake (codex) rejects the placeholder but
      // attaches the served catalog — that catalog IS the answer.
      const served = (error as { catalog?: unknown }).catalog;
      if (
        (error as { runtimeCode?: string }).runtimeCode === "MODEL_UNAVAILABLE" &&
        Array.isArray(served) &&
        served.length > 0
      ) {
        return { catalog: served as string[] };
      }
      throw error;
    } finally {
      // Best effort: a probe must never leak a CLI process.
      await driver.close().catch(() => undefined);
    }
  }

  function readinessKey(profile: ExecutionProfileDto, modelId: string): string {
    return `${digestOf(profile)}:${modelId}`;
  }

  function catalogKey(
    driverId: DriverId,
    installationId: string,
    route: ClaudeRoute | undefined,
  ): string {
    const effectiveRoute = driverId === "claude-stream-json" ? (route ?? "ant-glm5.2") : "";
    return `${driverId}:${installationId}:${effectiveRoute}`;
  }

  async function readiness(
    profile: ExecutionProfileDto,
    modelId: string,
    options: ProfileProbeOptions = {},
  ): Promise<ResolveProfileResponse> {
    const key = readinessKey(profile, modelId);
    const t = now();
    const entry = readinessCache.get(key);
    if (!options.refresh && entry) {
      if (entry.failures > 0 && t < entry.nextAllowedAt) {
        // Backoff window: serve the cached failure, 200 semantics unchanged.
        return { ...entry.value, retryAfterMs: entry.nextAllowedAt - t };
      }
      if (entry.failures === 0 && t - entry.cachedAtMs < CACHE_TTL_MS) {
        // Fresh success cache hit; cachedAt is already stamped on the value.
        return entry.value;
      }
    }

    // V2: stamp the start generation before awaiting the handshake. If
    // invalidateInstallation bumps this installation's generation while the
    // handshake is hung, the in-flight result is discarded at settle.
    const startGeneration = installationGenerations.get(profile.installationId) ?? 0;
    const handshake = await runReadinessHandshake(profile, modelId);
    // R3: re-take the clock AFTER the handshake settles (success or failure),
    // before stamping the cache entry + response. Pre-fix `t` was captured
    // before the await, so a slow handshake front-dated cachedAtMs /
    // nextAllowedAt and the response cachedAt / retryAfterMs — a 5s failing
    // handshake made the 2s backoff expire by the time the response returned
    // (backoff bypassed), and a 20s success read as "20 秒前" with only 40s of
    // cache TTL left. The cache-hit branch above keeps returning the entry's
    // own stamped times.
    const settledAt = now();
    const failed = handshake.readiness.state !== "ready";
    const prevFailures = entry?.failures ?? 0;
    const slot = failed ? backoffSlot(prevFailures) : 0;
    const cachedAtIso = new Date(settledAt).toISOString();
    const value: ResolveProfileResponse = failed
      ? { ...handshake, cachedAt: cachedAtIso, retryAfterMs: BACKOFF_MS[slot] }
      : { ...handshake, cachedAt: cachedAtIso };
    // V2: only persist the cache entry when no invalidateInstallation superseded
    // this handshake's generation mid-flight. A superseded handshake's response
    // is still returned to THIS caller (its request was legitimate), but it is
    // not cached — the next request re-handshakes against the live install.
    const currentGeneration = installationGenerations.get(profile.installationId) ?? 0;
    if (startGeneration === currentGeneration) {
      readinessCache.set(key, {
        installationId: profile.installationId,
        value,
        cachedAtMs: settledAt,
        failures: failed ? prevFailures + 1 : 0,
        nextAllowedAt: failed ? settledAt + BACKOFF_MS[slot] : 0,
      });
    }
    return value;
  }

  async function catalog(
    driverId: DriverId,
    installationId: string,
    route?: ClaudeRoute,
    options: ProfileProbeOptions = {},
  ): Promise<ModelCatalogResponse> {
    const key = catalogKey(driverId, installationId, route);
    const t = now();
    const entry = catalogCache.get(key);
    if (!options.refresh && entry) {
      if (entry.failures > 0 && t < entry.nextAllowedAt) {
        // Backoff window: rethrow the cached error so the route maps the same
        // 4xx status/code exactly as the fresh failure did.
        throw entry.error;
      }
      if (entry.failures === 0 && t - entry.cachedAtMs < CACHE_TTL_MS) {
        return entry.value;
      }
    }

    // V2: stamp the start generation before awaiting the handshake.
    const startGeneration = installationGenerations.get(installationId) ?? 0;
    try {
      const result = await runCatalogHandshake(driverId, installationId, route);
      // R3: stamp cachedAt at the settle moment (after the handshake), not the
      // pre-handshake `t` — a slow catalog handshake must not front-date the
      // cache. The hit branch above keeps returning the entry's own stamp.
      const settledAt = now();
      const value: ModelCatalogResponse = {
        ...result,
        cachedAt: new Date(settledAt).toISOString(),
      };
      // V2: discard the entry when an invalidateInstallation superseded this
      // handshake's generation mid-flight (same fencing as readiness).
      const successGeneration = installationGenerations.get(installationId) ?? 0;
      if (startGeneration === successGeneration) {
        catalogCache.set(key, {
          installationId,
          value,
          cachedAtMs: settledAt,
          failures: 0,
          nextAllowedAt: 0,
        });
      }
      return value;
    } catch (error) {
      // R3: same settle-time stamping on failure so the backoff window starts
      // when the handshake actually settled, not when it was initiated.
      const settledAt = now();
      const prevFailures = entry?.failures ?? 0;
      const slot = backoffSlot(prevFailures);
      // V2: same generation fencing on the failure path.
      const failureGeneration = installationGenerations.get(installationId) ?? 0;
      if (startGeneration === failureGeneration) {
        catalogCache.set(key, {
          installationId,
          value: entry?.value ?? { catalog: [], cachedAt: new Date(settledAt).toISOString() },
          error,
          cachedAtMs: settledAt,
          failures: prevFailures + 1,
          nextAllowedAt: settledAt + BACKOFF_MS[slot],
        });
      }
      throw error;
    }
  }

  function invalidateInstallation(installationId: string): void {
    for (const [key, entry] of readinessCache) {
      if (entry.installationId === installationId) readinessCache.delete(key);
    }
    for (const [key, entry] of catalogCache) {
      if (entry.installationId === installationId) catalogCache.delete(key);
    }
    // V2: bump the generation so any in-flight handshake for this installation
    // is fenced at settle — its result will not be written to the cache.
    const next = (installationGenerations.get(installationId) ?? 0) + 1;
    installationGenerations.set(installationId, next);
  }

  function clearCache(): void {
    readinessCache.clear();
    catalogCache.clear();
    installationGenerations.clear();
  }

  return { readiness, catalog, invalidateInstallation, clearCache };
}
