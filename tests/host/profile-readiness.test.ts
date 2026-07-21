import type { ParticipantDriver, PrewarmResult } from "@host/drivers/types";
import {
  InstallationError,
  type InstallationRecord,
  type InstallationRegistry,
} from "@host/installations/registry";
import type { Logger } from "@host/logging";
import { createProfileProbe } from "@host/profiles/probe";
import { installationRoutes } from "@host/routes/installations";
import { makeError } from "@shared/runtime/errors";
import type { InstallationDto, ResolveProfileResponse } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "./helpers";

/**
 * Dynamic Profile readiness: POST /api/v1/profiles/readiness must run the
 * same Driver handshake as execution (static gate → fresh fingerprint
 * revalidation → prewarm → binding) on a throwaway probe driver, report
 * failures as readiness states and never leak the probe driver.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const TRUSTED_DTO: InstallationDto = {
  installationId: "codex-0123456789ab",
  driverId: "codex-app-server",
  state: "trusted",
  executablePath: "/fake/codex",
  fingerprint: "sha256:00",
  components: [],
  detail: null,
};

const TRUSTED_RECORD: InstallationRecord = {
  installationId: TRUSTED_DTO.installationId,
  driverId: "codex-app-server",
  name: "codex",
  discoveredPath: "/fake/codex",
  realpath: "/fake/codex",
  fingerprint: "sha256:00",
  state: "trusted",
  components: [],
  detail: null,
};

const CANONICAL_MODEL = "gpt-5.6-sol";

interface FakeDriver extends ParticipantDriver {
  prewarmCount: number;
  closeCount: number;
}

function createFakeDriver(
  participantId: string,
  options: {
    prewarmError?: Error;
    onPrewarm?: () => void;
    /** V2 hang hook: when set, prewarm blocks on this gate until resolve() is
     * called — simulating an in-flight handshake settled after a revalidate. */
    prewarmGate?: { promise: Promise<void>; resolve: () => void };
  } = {},
): FakeDriver {
  const fake: FakeDriver = {
    participantId,
    driverId: "codex-app-server",
    sessionEpoch: 0,
    prewarmCount: 0,
    closeCount: 0,
    async prewarm(): Promise<PrewarmResult> {
      fake.prewarmCount += 1;
      // R3 test hook: advance the injectable clock DURING the (otherwise
      // synchronous) prewarm so a slow handshake can be simulated. Runs before
      // the error branch so both the success and failure paths shift the clock.
      options.onPrewarm?.();
      if (options.prewarmGate) await options.prewarmGate.promise;
      if (options.prewarmError) return Promise.reject(options.prewarmError);
      return Promise.resolve({
        canonicalModelId: CANONICAL_MODEL,
        modelAliases: [],
        capability: { protocol: "fake" },
        catalog: [CANONICAL_MODEL],
      });
    },
    execute(): Promise<void> {
      return Promise.reject(new Error("probe drivers never execute"));
    },
    cancel(): Promise<void> {
      return Promise.reject(new Error("probe drivers never cancel"));
    },
    close(): Promise<void> {
      fake.closeCount += 1;
      return Promise.resolve();
    },
    capabilityState: () => "ready",
    contextWindowTokens: () => null,
  };
  return fake;
}

interface RegistryOverrides {
  dtos?: InstallationDto[];
  assertExecutable?: (installationId: string) => InstallationRecord;
  revalidate?: (installationId: string) => InstallationDto;
}

function fakeRegistry(overrides: RegistryOverrides = {}): InstallationRegistry {
  const dtos = overrides.dtos ?? [TRUSTED_DTO];
  const find = (id: string) => dtos.find((dto) => dto.installationId === id);
  return {
    refresh: () => [...dtos],
    list: () => [...dtos],
    get: find,
    revalidate:
      overrides.revalidate ??
      ((id) => {
        const dto = find(id);
        if (!dto) {
          throw new InstallationError(
            makeError("INSTALLATION_NOT_FOUND", "discovery", `Unknown installation "${id}".`),
          );
        }
        return dto;
      }),
    assertExecutable: overrides.assertExecutable ?? (() => TRUSTED_RECORD),
  };
}

const nullLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  diagnostic: () => undefined,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface Rig {
  host: TestHost;
  drivers: FakeDriver[];
  clock: { now: number };
}

async function createRig(
  registry: InstallationRegistry,
  driverOptions: {
    prewarmError?: Error;
    prewarmAdvanceMs?: number;
    prewarmGate?: { promise: Promise<void>; resolve: () => void };
  } = {},
): Promise<Rig> {
  const drivers: FakeDriver[] = [];
  const clock = { now: Date.now() };
  // Same constructor main.ts uses: probe composed from installations + the
  // per-driver factories. The injectable clock lets cache/backoff tests move
  // time deterministically. prewarmAdvanceMs advances the clock mid-prewarm to
  // simulate a slow handshake (the R3 cachedAt-at-settle proof).
  const fakeDriverOptions: {
    prewarmError?: Error;
    onPrewarm?: () => void;
    prewarmGate?: { promise: Promise<void>; resolve: () => void };
  } = {
    prewarmError: driverOptions.prewarmError,
  };
  if (driverOptions.prewarmAdvanceMs) {
    fakeDriverOptions.onPrewarm = () => {
      clock.now += driverOptions.prewarmAdvanceMs as number;
    };
  }
  if (driverOptions.prewarmGate) {
    fakeDriverOptions.prewarmGate = driverOptions.prewarmGate;
  }
  const profileProbe = createProfileProbe({
    installations: registry,
    driverFactories: {
      "codex-app-server": (participantId: string) => {
        const driver = createFakeDriver(participantId, fakeDriverOptions);
        drivers.push(driver);
        return driver;
      },
    },
    logger: nullLogger,
    now: () => clock.now,
  });
  const host = await createTestHost({
    extraServices: { installationRegistry: registry, profileProbe },
    routesFactory: (services) => installationRoutes(services),
  });
  return { host, drivers, clock };
}

let host: TestHost | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
});

function readinessBody(installationId: string, modelId = CANONICAL_MODEL): string {
  return JSON.stringify({
    profile: {
      driverId: "codex-app-server",
      installationId,
      credentialMode: "installation-managed",
      options: {},
    },
    modelId,
  });
}

async function postReadiness(
  target: TestHost,
  body: string,
  options: { refresh?: boolean } = {},
): Promise<{ status: number; data?: ResolveProfileResponse; errorCode?: string }> {
  const query = options.refresh ? "?refresh=1" : "";
  const res = await fetch(`${target.baseUrl}/api/v1/profiles/readiness${query}`, {
    method: "POST",
    headers: authedHeaders(target),
    body,
  });
  const envelope = (await res.json()) as {
    ok: boolean;
    data?: ResolveProfileResponse;
    error?: { code: string };
  };
  return { status: res.status, data: envelope.data, errorCode: envelope.error?.code };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/profiles/readiness (dynamic probe)", () => {
  it("trusted installation + successful prewarm → ready with a resolved binding", async () => {
    const rig = await createRig(fakeRegistry());
    host = rig.host;

    const res = await postReadiness(host, readinessBody(TRUSTED_DTO.installationId));
    expect(res.status).toBe(200);
    expect(res.data?.readiness).toEqual({ state: "ready", detail: null });
    const binding = res.data?.binding;
    expect(binding).not.toBeNull();
    expect(binding?.canonicalModelId).toBe(CANONICAL_MODEL);
    expect(binding?.requestedModel).toBe(CANONICAL_MODEL);
    expect(binding?.installationId).toBe(TRUSTED_DTO.installationId);
    expect(binding?.driverId).toBe("codex-app-server");
    expect(binding?.bindingDigest.length).toBeGreaterThan(0);
    // Exactly one throwaway probe driver, prewarmed once and always closed.
    expect(rig.drivers).toHaveLength(1);
    expect(rig.drivers[0]?.participantId).toMatch(/^probe-/);
    expect(rig.drivers[0]?.prewarmCount).toBe(1);
    expect(rig.drivers[0]?.closeCount).toBe(1);
  });

  it("requested modelId outside the prewarm catalog → model_unavailable, binding null", async () => {
    const rig = await createRig(fakeRegistry());
    host = rig.host;

    const res = await postReadiness(host, readinessBody(TRUSTED_DTO.installationId, "other-model"));
    expect(res.status).toBe(200);
    expect(res.data?.readiness.state).toBe("model_unavailable");
    expect(res.data?.binding).toBeNull();
    expect(rig.drivers[0]?.closeCount).toBe(1);
  });

  it("installation changed at the fresh revalidation gate → invalid_binding", async () => {
    const rig = await createRig(
      fakeRegistry({
        // Static gate still sees the (stale) trusted DTO; the probe's fresh
        // fingerprint revalidation detects the drift.
        assertExecutable: () => {
          throw new InstallationError(
            makeError(
              "INSTALLATION_CHANGED",
              "discovery",
              `Installation "${TRUSTED_DTO.installationId}" changed since validation.`,
            ),
          );
        },
      }),
    );
    host = rig.host;

    const res = await postReadiness(host, readinessBody(TRUSTED_DTO.installationId));
    expect(res.status).toBe(200);
    expect(res.data?.readiness.state).toBe("invalid_binding");
    expect(res.data?.binding).toBeNull();
    // No driver was ever created for the failed gate.
    expect(rig.drivers).toHaveLength(0);
  });

  it("keeps the revalidate route mapping INSTALLATION_CHANGED → 409", async () => {
    const changed = new InstallationError(
      makeError(
        "INSTALLATION_CHANGED",
        "discovery",
        `Installation "${TRUSTED_DTO.installationId}" changed since validation.`,
      ),
    );
    const rig = await createRig(
      fakeRegistry({
        revalidate: () => {
          throw changed;
        },
      }),
    );
    host = rig.host;

    const res = await fetch(
      `${host.baseUrl}/api/v1/installations/${TRUSTED_DTO.installationId}/revalidate`,
      { method: "POST", headers: authedHeaders(host) },
    );
    expect(res.status).toBe(409);
    const envelope = (await res.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("INSTALLATION_CHANGED");
  });

  it("unknown installation → static invalid_binding without touching a driver", async () => {
    const rig = await createRig(fakeRegistry({ dtos: [] }));
    host = rig.host;

    const res = await postReadiness(host, readinessBody("codex-ffffffffffff"));
    expect(res.status).toBe(200);
    expect(res.data?.readiness.state).toBe("invalid_binding");
    expect(res.data?.binding).toBeNull();
    expect(rig.drivers).toHaveLength(0);
  });

  it("driver prewarm rejection → runtime_unavailable, and the probe driver is closed", async () => {
    const prewarmError = Object.assign(new Error("cli is not logged in"), {
      runtimeCode: "AUTH_REQUIRED",
    });
    const rig = await createRig(fakeRegistry(), { prewarmError });
    host = rig.host;

    const res = await postReadiness(host, readinessBody(TRUSTED_DTO.installationId));
    expect(res.status).toBe(200);
    expect(res.data?.readiness.state).toBe("runtime_unavailable");
    expect(res.data?.readiness.detail).toBe("cli is not logged in");
    expect(res.data?.binding).toBeNull();
    expect(rig.drivers).toHaveLength(1);
    expect(rig.drivers[0]?.closeCount).toBe(1);
  });

  it("rejects injection fields with 400 BAD_REQUEST (strict schema)", async () => {
    const rig = await createRig(fakeRegistry());
    host = rig.host;

    const res = await postReadiness(
      host,
      JSON.stringify({
        profile: {
          driverId: "codex-app-server",
          installationId: TRUSTED_DTO.installationId,
          credentialMode: "installation-managed",
          options: {},
          executable: "/tmp/evil",
        },
        modelId: CANONICAL_MODEL,
      }),
    );
    expect(res.status).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
    expect(rig.drivers).toHaveLength(0);
  });
});

describe("probe cache + backoff + invalidation", () => {
  it("same key within 60s → cache hit (one handshake); cachedAt stable", async () => {
    const rig = await createRig(fakeRegistry());
    host = rig.host;
    const body = readinessBody(TRUSTED_DTO.installationId);

    const r1 = await postReadiness(host, body);
    const r2 = await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(1);
    expect(r1.data?.cachedAt).toEqual(expect.any(String));
    expect(r2.data?.cachedAt).toBe(r1.data?.cachedAt);
  });

  it("after 60s the same key re-handshakes", async () => {
    const rig = await createRig(fakeRegistry());
    host = rig.host;
    const body = readinessBody(TRUSTED_DTO.installationId);

    await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(1);
    rig.clock.now += 61_000;
    await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(2);
  });

  it("refresh=1 forces a fresh handshake inside the cache window", async () => {
    const rig = await createRig(fakeRegistry());
    host = rig.host;
    const body = readinessBody(TRUSTED_DTO.installationId);

    const r1 = await postReadiness(host, body);
    const r2 = await postReadiness(host, body, { refresh: true });
    expect(rig.drivers).toHaveLength(2);
    // A fresh handshake stamps a newer cachedAt than the cached one.
    expect(Date.parse(r2.data?.cachedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(r1.data?.cachedAt ?? ""),
    );
  });

  it("failure backoff sequence 2s/10s/30s, cached failures served with retryAfterMs", async () => {
    const prewarmError = Object.assign(new Error("cli is not logged in"), {
      runtimeCode: "AUTH_REQUIRED",
    });
    const rig = await createRig(fakeRegistry(), { prewarmError });
    host = rig.host;
    const body = readinessBody(TRUSTED_DTO.installationId);

    // R1: fresh failure, drivers=1, retryAfterMs = 2000.
    const r1 = await postReadiness(host, body);
    expect(r1.data?.readiness.state).toBe("runtime_unavailable");
    expect(r1.data?.retryAfterMs).toBe(2_000);
    expect(rig.drivers).toHaveLength(1);

    // +1s: still inside the first backoff window → cached failure, no handshake.
    rig.clock.now += 1_000;
    const r2 = await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(1);
    expect(r2.data?.retryAfterMs).toBe(1_000);

    // +1.1s: past the 2s window → new failing handshake, drivers=2, retry 10s.
    rig.clock.now += 1_100;
    const r3 = await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(2);
    expect(r3.data?.retryAfterMs).toBe(10_000);

    // +5s: inside the 10s window → cached failure, no handshake.
    rig.clock.now += 5_000;
    await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(2);

    // +10.1s: past the 10s window → new failing handshake, drivers=3, retry 30s.
    rig.clock.now += 10_100;
    const r5 = await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(3);
    expect(r5.data?.retryAfterMs).toBe(30_000);

    // refresh=1 always escapes the backoff window.
    await postReadiness(host, body, { refresh: true });
    expect(rig.drivers).toHaveLength(4);
  });

  it("Profile DTO change (modelId/options) → new key → extra handshake; old key still cached", async () => {
    const rig = await createRig(fakeRegistry());
    host = rig.host;

    await postReadiness(host, readinessBody(TRUSTED_DTO.installationId, CANONICAL_MODEL));
    expect(rig.drivers).toHaveLength(1);
    // Different modelId → different digest key → fresh handshake.
    await postReadiness(host, readinessBody(TRUSTED_DTO.installationId, "other-model"));
    expect(rig.drivers).toHaveLength(2);
    // Old key still hits cache.
    await postReadiness(host, readinessBody(TRUSTED_DTO.installationId, CANONICAL_MODEL));
    expect(rig.drivers).toHaveLength(2);
  });

  it("revalidate drops the readiness key → next readiness re-handshakes", async () => {
    const rig = await createRig(fakeRegistry());
    host = rig.host;
    const body = readinessBody(TRUSTED_DTO.installationId);

    await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(1);
    // Cache hit confirms the key is warm.
    await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(1);

    const res = await fetch(
      `${host.baseUrl}/api/v1/installations/${TRUSTED_DTO.installationId}/revalidate`,
      { method: "POST", headers: authedHeaders(host) },
    );
    expect(res.status).toBe(200);

    // After invalidate, the next readiness re-handshakes.
    await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(2);
  });

  it("R3: cachedAt/退避窗取在握手落定时刻——慢握手不前移（成功 cachedAt=落定；失败退避从落定起算）", async () => {
    // A slow handshake (the injectable clock advances mid-prewarm) must NOT
    // front-date the cache stamp. Pre-fix `t` was captured before the await, so
    // a 20s success read as "20 秒前" with only 40s of TTL left, and a 5s
    // failing handshake's 2s backoff expired by the time the response returned
    // (backoff bypassed). Post-fix cachedAt/nextAllowedAt/retryAfterMs all use
    // the settle moment; the cache-hit branch keeps the entry's own stamp.

    // --- Success path: a 20s slow handshake stamps cachedAt at settle. ---
    const rig = await createRig(fakeRegistry(), { prewarmAdvanceMs: 20_000 });
    host = rig.host;
    const body = readinessBody(TRUSTED_DTO.installationId);

    const beforeMs = rig.clock.now;
    const r1 = await postReadiness(host, body);
    expect(r1.data?.readiness.state).toBe("ready");
    // cachedAt = beforeMs + 20s (the settle moment), NOT beforeMs (pre-handshake).
    expect(Date.parse(r1.data?.cachedAt ?? "")).toBe(beforeMs + 20_000);
    // A second call within TTL hits cache: cachedAt unchanged (entry's own stamp).
    const r2 = await postReadiness(host, body);
    expect(r2.data?.cachedAt).toBe(r1.data?.cachedAt);
    expect(rig.drivers).toHaveLength(1);

    await host.cleanup();
    host = null;

    // --- Failure path: a 5s slow failing handshake backs off from settle. ---
    const prewarmError = Object.assign(new Error("cli is not logged in"), {
      runtimeCode: "AUTH_REQUIRED",
    });
    const rig2 = await createRig(fakeRegistry(), {
      prewarmError,
      prewarmAdvanceMs: 5_000,
    });
    host = rig2.host;
    const fBody = readinessBody(TRUSTED_DTO.installationId);

    const beforeMs2 = rig2.clock.now;
    const f1 = await postReadiness(host, fBody);
    expect(f1.data?.readiness.state).toBe("runtime_unavailable");
    // cachedAt = settle (beforeMs2 + 5s), not the pre-handshake moment.
    expect(Date.parse(f1.data?.cachedAt ?? "")).toBe(beforeMs2 + 5_000);
    // retryAfterMs is the full 2s window from settle — the 5s handshake did NOT
    // expire the 2s backoff. Pre-fix the deadline was pre-handshake + 2s, so by
    // settle (+5s) it was already past and a fresh re-handshake would fire here.
    expect(f1.data?.retryAfterMs).toBe(2_000);

    // At settle + 1s the remaining backoff is 1s (deadline = settle + 2s, NOT
    // pre-handshake + 2s). Pre-fix the deadline was in the past here, so a fresh
    // failing handshake would have fired (drivers=2, retryAfterMs=10_000).
    rig2.clock.now = beforeMs2 + 5_000 + 1_000;
    const f2 = await postReadiness(host, fBody);
    expect(rig2.drivers).toHaveLength(1); // still in backoff — no new handshake
    expect(f2.data?.retryAfterMs).toBe(1_000);
  });

  it("V2: 握手 hang 期间 revalidate 升代 → settle 后缓存未写入；下次请求重新握手（drivers +1）", async () => {
    // A handshake blocked on a gate simulates a slow/hung prewarm. While it is
    // in flight, the revalidate route bumps the installation generation. When
    // the stale handshake finally settles, its result must NOT be cached (its
    // start generation was superseded) — the next request re-handshakes.
    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const rig = await createRig(fakeRegistry(), {
      prewarmGate: { promise: gate, resolve: resolveGate },
    });
    host = rig.host;
    const body = readinessBody(TRUSTED_DTO.installationId);

    // Fire the (hung) handshake; it is parked on the gate.
    const inflight = postReadiness(host, body);
    await vi.waitFor(() => {
      expect(rig.drivers).toHaveLength(1);
      expect(rig.drivers[0]?.prewarmCount).toBe(1);
    });

    // While hung, revalidate the installation → invalidateInstallation bumps the
    // generation for this installation (startGeneration of the in-flight call).
    const res = await fetch(
      `${host.baseUrl}/api/v1/installations/${TRUSTED_DTO.installationId}/revalidate`,
      { method: "POST", headers: authedHeaders(host) },
    );
    expect(res.status).toBe(200);

    // Let the stale handshake settle. Its response is still returned to the
    // original caller, but it must NOT be cached.
    resolveGate();
    const settled = await inflight;
    expect(settled.data?.readiness.state).toBe("ready");

    // The next request within TTL must NOT hit the stale cache — it re-handshakes
    // (drivers 1 → 2), proving the fenced handshake wrote nothing.
    const next = await postReadiness(host, body);
    expect(next.status).toBe(200);
    expect(rig.drivers).toHaveLength(2);

    // And now the just-written (live-generation) cache holds: a third call hits.
    const cached = await postReadiness(host, body);
    expect(rig.drivers).toHaveLength(2);
    expect(cached.data?.cachedAt).toBe(next.data?.cachedAt);
  });
});

/**
 * cfuse route (Slice 1): the claude route whitelist admits `cfuse`, and the
 * readiness handshake carries route: "cfuse" on the resolved binding. The
 * route participates in the catalog cache key (different route → fresh
 * handshake). Backed by a tiny fake claude driver that echoes the profile.
 */
const CFUSE_DTO: InstallationDto = {
  installationId: "cld-cfuse0000000",
  driverId: "claude-stream-json",
  state: "trusted",
  executablePath: "/fake/cld",
  fingerprint: "sha256:00",
  components: [
    { role: "wrapper", path: "/fake/cld", fingerprint: "sha256:00" },
    { role: "cfuse-binary", path: "/fake/cfuse", fingerprint: "sha256:01" },
  ],
  detail: null,
};

const CFUSE_RECORD: InstallationRecord = {
  installationId: CFUSE_DTO.installationId,
  driverId: "claude-stream-json",
  name: "cld",
  discoveredPath: "/fake/cld",
  realpath: "/fake/cld",
  fingerprint: "sha256:00",
  state: "trusted",
  components: CFUSE_DTO.components,
  detail: null,
};

const CFUSE_MODEL = "GLM-5.2[1m]";

describe("cfuse route readiness + catalog cache key", () => {
  it("resolves a cfuse-route claude profile ready with route on the binding", async () => {
    const drivers: FakeDriver[] = [];
    const profileProbe = createProfileProbe({
      installations: fakeRegistry({
        dtos: [CFUSE_DTO],
        assertExecutable: () => CFUSE_RECORD,
      }),
      driverFactories: {
        "claude-stream-json": (participantId: string) => {
          const driver = createFakeDriver(participantId);
          // The fake driver hard-codes codex semantics; soft-override the
          // prewarm to claude cfuse reality (canonical = requested model).
          driver.prewarm = async (input) => {
            driver.prewarmCount += 1;
            return {
              canonicalModelId: input.spec.modelId,
              modelAliases: ["default"],
              capability: { protocol: "claude-stream-json", controlInitialize: true },
              catalog: [input.spec.modelId],
            };
          };
          drivers.push(driver);
          return driver;
        },
      },
      logger: nullLogger,
    });
    host = await createTestHost({
      extraServices: { installationRegistry: fakeRegistry({ dtos: [CFUSE_DTO] }), profileProbe },
      routesFactory: (services) => installationRoutes(services),
    });

    const res = await postReadiness(
      host,
      JSON.stringify({
        profile: {
          driverId: "claude-stream-json",
          installationId: CFUSE_DTO.installationId,
          credentialMode: "installation-managed",
          options: { route: "cfuse" },
        },
        modelId: CFUSE_MODEL,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.data?.readiness.state).toBe("ready");
    expect(res.data?.binding?.route).toBe("cfuse");
    expect(res.data?.binding?.canonicalModelId).toBe(CFUSE_MODEL);
    expect(drivers[0]?.closeCount).toBe(1);
  });
});

/**
 * kimi-stream-json (Slice 2): the catalog probe passes no route, the readiness
 * binding carries no route, and an out-of-catalog model surfaces
 * model_unavailable. Backed by a tiny fake kimi driver echoing the K3 closed
 * set; the probe driver is always closed (no CLI process leak).
 */
const KIMI_DTO: InstallationDto = {
  installationId: "kimi-0123456789ab",
  driverId: "kimi-stream-json",
  state: "trusted",
  executablePath: "/fake/kimi",
  fingerprint: "sha256:00",
  components: [{ role: "wrapper", path: "/fake/kimi", fingerprint: "sha256:00" }],
  detail: null,
};

const KIMI_RECORD: InstallationRecord = {
  installationId: KIMI_DTO.installationId,
  driverId: "kimi-stream-json",
  name: "kimi",
  discoveredPath: "/fake/kimi",
  realpath: "/fake/kimi",
  fingerprint: "sha256:00",
  state: "trusted",
  components: KIMI_DTO.components,
  detail: null,
};

const KIMI_MODEL = "kimi-code/k3";

describe("kimi-stream-json readiness + catalog (no route)", () => {
  it("resolves a kimi profile ready with the K3 canonical model and no route", async () => {
    const drivers: FakeDriver[] = [];
    const profileProbe = createProfileProbe({
      installations: fakeRegistry({
        dtos: [KIMI_DTO],
        assertExecutable: () => KIMI_RECORD,
      }),
      driverFactories: {
        "kimi-stream-json": (participantId: string) => {
          const driver = createFakeDriver(participantId);
          driver.prewarm = async (input) => {
            driver.prewarmCount += 1;
            if (input.spec.modelId !== KIMI_MODEL) {
              throw Object.assign(new Error(`model ${input.spec.modelId} not in kimi catalog`), {
                runtimeCode: "MODEL_UNAVAILABLE",
                catalog: [KIMI_MODEL],
              });
            }
            return {
              canonicalModelId: KIMI_MODEL,
              modelAliases: [],
              capability: {
                protocol: "kimi-stream-json",
                providerProbe: "provider-list",
                sessionResume: true,
                outputMode: "final-only",
                modelSelection: "exact-cli-alias",
              },
              catalog: [KIMI_MODEL],
            };
          };
          drivers.push(driver);
          return driver;
        },
      },
      logger: nullLogger,
    });
    host = await createTestHost({
      extraServices: { installationRegistry: fakeRegistry({ dtos: [KIMI_DTO] }), profileProbe },
      routesFactory: (services) => installationRoutes(services),
    });

    const res = await postReadiness(
      host,
      JSON.stringify({
        profile: {
          driverId: "kimi-stream-json",
          installationId: KIMI_DTO.installationId,
          credentialMode: "installation-managed",
          options: {},
        },
        modelId: KIMI_MODEL,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.data?.readiness.state).toBe("ready");
    expect(res.data?.binding?.route).toBeUndefined();
    expect(res.data?.binding?.canonicalModelId).toBe(KIMI_MODEL);
    expect(res.data?.binding?.modelAliases).toEqual([]);
    expect(drivers[0]?.closeCount).toBe(1); // probe driver always closed
  });

  it("an out-of-catalog kimi modelId surfaces model_unavailable", async () => {
    const profileProbe = createProfileProbe({
      installations: fakeRegistry({
        dtos: [KIMI_DTO],
        assertExecutable: () => KIMI_RECORD,
      }),
      driverFactories: {
        "kimi-stream-json": (participantId: string) => {
          const driver = createFakeDriver(participantId);
          driver.prewarm = async (input) => {
            driver.prewarmCount += 1;
            throw Object.assign(new Error(`model ${input.spec.modelId} not in kimi catalog`), {
              runtimeCode: "MODEL_UNAVAILABLE",
              catalog: [KIMI_MODEL],
            });
          };
          return driver;
        },
      },
      logger: nullLogger,
    });
    host = await createTestHost({
      extraServices: { installationRegistry: fakeRegistry({ dtos: [KIMI_DTO] }), profileProbe },
      routesFactory: (services) => installationRoutes(services),
    });

    const res = await postReadiness(
      host,
      JSON.stringify({
        profile: {
          driverId: "kimi-stream-json",
          installationId: KIMI_DTO.installationId,
          credentialMode: "installation-managed",
          options: {},
        },
        modelId: "kimi-code/not-a-model",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.data?.readiness.state).toBe("model_unavailable");
    expect(res.data?.binding).toBeNull();
  });
});
