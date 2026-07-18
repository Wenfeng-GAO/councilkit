import type { ParticipantDriver, PrewarmInput, PrewarmResult } from "@host/drivers/types";
import {
  InstallationError,
  type InstallationRecord,
  type InstallationRegistry,
} from "@host/installations/registry";
import type { Logger } from "@host/logging";
import { createProfileProbe } from "@host/profiles/probe";
import { installationRoutes } from "@host/routes/installations";
import { modelRoutes } from "@host/routes/models";
import { CANONICAL_HOST_HEADER } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import type { InstallationDto, ModelCatalogResponse } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "./helpers";

/**
 * GET /api/v1/models/catalog (U6): the closed canonical model catalog a Driver
 * reports for a trusted Installation. The route validates query params, runs
 * the same probe handshake as profile readiness with a placeholder modelId
 * (the catalog is model-agnostic), returns `prewarm.catalog` verbatim and
 * always closes the throwaway probe driver. Unknown/changed/untrusted
 * installations map to the existing Installation error vocabulary.
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

const CATALOG = ["gpt-5.6-sol", "gpt-5.6-sol-mini"];

interface FakeDriver extends ParticipantDriver {
  prewarmCount: number;
  closeCount: number;
  lastPrewarm: PrewarmInput | null;
}

function createFakeDriver(participantId: string): FakeDriver {
  const fake: FakeDriver = {
    participantId,
    driverId: "codex-app-server",
    sessionEpoch: 0,
    prewarmCount: 0,
    closeCount: 0,
    lastPrewarm: null,
    prewarm(input: PrewarmInput): Promise<PrewarmResult> {
      fake.prewarmCount += 1;
      fake.lastPrewarm = input;
      return Promise.resolve({
        canonicalModelId: CATALOG[0] as string,
        modelAliases: [],
        capability: { protocol: "fake" },
        catalog: [...CATALOG],
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

function fakeRegistry(overrides: {
  dtos?: InstallationDto[];
  assertExecutable?: (installationId: string) => InstallationRecord;
}): InstallationRegistry {
  const dtos = overrides.dtos ?? [TRUSTED_DTO];
  const find = (id: string) => dtos.find((dto) => dto.installationId === id);
  return {
    refresh: () => [...dtos],
    list: () => [...dtos],
    get: find,
    revalidate: (id) => {
      const dto = find(id);
      if (!dto) {
        throw new InstallationError(
          makeError("INSTALLATION_NOT_FOUND", "discovery", `Unknown installation "${id}".`),
        );
      }
      return dto;
    },
    assertExecutable: overrides.assertExecutable ?? (() => TRUSTED_RECORD),
  };
}

const CLAUDE_DTO: InstallationDto = {
  installationId: "claude-0123456789a",
  driverId: "claude-stream-json",
  state: "trusted",
  executablePath: "/fake/cld",
  fingerprint: "sha256:11",
  components: [],
  detail: null,
};

const CLAUDE_RECORD: InstallationRecord = {
  installationId: CLAUDE_DTO.installationId,
  driverId: "claude-stream-json",
  name: "cld",
  discoveredPath: "/fake/cld",
  realpath: "/fake/cld",
  fingerprint: "sha256:11",
  state: "trusted",
  components: [],
  detail: null,
};

/** Driver whose prewarm rejects with the given (runtimeCode-carrying) error. */
function createErroringDriver(participantId: string, error: Error): ParticipantDriver {
  return {
    participantId,
    driverId: "codex-app-server",
    sessionEpoch: 0,
    prewarm: () => Promise.reject(error),
    execute: () => Promise.reject(new Error("probe drivers never execute")),
    cancel: () => Promise.reject(new Error("probe drivers never cancel")),
    close: () => Promise.resolve(),
    capabilityState: () => "ready",
    contextWindowTokens: () => null,
  };
}

interface ClaudeSpyDriver extends ParticipantDriver {
  lastRoute: string | null;
}

function createClaudeDriver(participantId: string): ClaudeSpyDriver {
  const spy: ClaudeSpyDriver = {
    participantId,
    driverId: "claude-stream-json",
    sessionEpoch: 0,
    lastRoute: null,
    prewarm(input: PrewarmInput): Promise<PrewarmResult> {
      spy.lastRoute = (input.spec.profile.options as { route?: string } | undefined)?.route ?? null;
      return Promise.resolve({
        canonicalModelId: "GLM-5.2[1m]",
        modelAliases: [],
        capability: { protocol: "fake" },
        catalog: ["GLM-5.2[1m]"],
      });
    },
    execute: () => Promise.reject(new Error("probe drivers never execute")),
    cancel: () => Promise.reject(new Error("probe drivers never cancel")),
    close: () => Promise.resolve(),
    capabilityState: () => "ready",
    contextWindowTokens: () => null,
  };
  return spy;
}

/** Driver whose prewarm blocks on a gate until resolve() is called (V2 hang
 * handshake simulation). Pushed to the rig's drivers array so handshake counts
 * are observable like the success driver. */
function createGatedDriver(
  participantId: string,
  gate: { promise: Promise<void>; resolve: () => void },
): FakeDriver {
  const fake: FakeDriver = {
    participantId,
    driverId: "codex-app-server",
    sessionEpoch: 0,
    prewarmCount: 0,
    closeCount: 0,
    lastPrewarm: null,
    async prewarm(input: PrewarmInput): Promise<PrewarmResult> {
      fake.prewarmCount += 1;
      fake.lastPrewarm = input;
      await gate.promise;
      return Promise.resolve({
        canonicalModelId: CATALOG[0] as string,
        modelAliases: [],
        capability: { protocol: "fake" },
        catalog: [...CATALOG],
      });
    },
    execute: () => Promise.reject(new Error("probe drivers never execute")),
    cancel: () => Promise.reject(new Error("probe drivers never cancel")),
    close: () => {
      fake.closeCount += 1;
      return Promise.resolve();
    },
    capabilityState: () => "ready",
    contextWindowTokens: () => null,
  };
  return fake;
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
  factories?: Record<string, (participantId: string) => ParticipantDriver>,
): Promise<Rig> {
  const drivers: FakeDriver[] = [];
  const clock = { now: Date.now() };
  // Same constructor main.ts uses: probe composed from installations + the
  // per-driver factories. The injectable clock lets cache/backoff tests move
  // time deterministically.
  //
  // When a test passes its own factories (gated/erroring/spy drivers), wrap
  // each so the created FakeDriver is still pushed to `rig.drivers` — that is
  // how the V2 gated handshake exposes its prewarmCount/closeCount and how the
  // catalog cache/backoff tests assert handshake counts. Pre-fix only the
  // default factory pushed, so a test-supplied factory left `rig.drivers`
  // empty and its assertions saw nothing.
  const userFactories = factories ?? {
    "codex-app-server": (participantId: string) => createFakeDriver(participantId),
  };
  const wrappedFactories: Record<string, (participantId: string) => ParticipantDriver> = {};
  for (const [id, factory] of Object.entries(userFactories)) {
    wrappedFactories[id] = (participantId: string) => {
      const driver = factory(participantId) as FakeDriver;
      if (driver && typeof driver.closeCount === "number") {
        drivers.push(driver);
      }
      return driver;
    };
  }
  const profileProbe = createProfileProbe({
    installations: registry,
    driverFactories: wrappedFactories,
    logger: nullLogger,
    now: () => clock.now,
  });
  const host = await createTestHost({
    extraServices: { installationRegistry: registry, profileProbe },
    routesFactory: (services) => [...modelRoutes(services), ...installationRoutes(services)],
  });
  return { host, drivers, clock };
}

let host: TestHost | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
});

async function getCatalog(
  target: TestHost,
  query: string,
): Promise<{ status: number; data?: ModelCatalogResponse; errorCode?: string }> {
  const res = await fetch(`${target.baseUrl}/api/v1/models/catalog?${query}`, {
    headers: authedHeaders(target),
  });
  const envelope = (await res.json()) as {
    ok: boolean;
    data?: ModelCatalogResponse;
    error?: { code: string };
  };
  return { status: res.status, data: envelope.data, errorCode: envelope.error?.code };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/models/catalog", () => {
  it("trusted installation → 200 with the driver's catalog; probe driver prewarmed once and closed", async () => {
    const rig = await createRig(fakeRegistry({}));
    host = rig.host;

    const res = await getCatalog(
      host,
      `driverId=codex-app-server&installationId=${TRUSTED_DTO.installationId}`,
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ catalog: CATALOG, cachedAt: expect.any(String) });
    // Exactly one throwaway probe driver with a placeholder modelId (the
    // catalog is model-agnostic), prewarmed once and always closed.
    expect(rig.drivers).toHaveLength(1);
    expect(rig.drivers[0]?.participantId).toMatch(/^probe-/);
    expect(rig.drivers[0]?.prewarmCount).toBe(1);
    expect(rig.drivers[0]?.lastPrewarm?.spec.modelId).toBe("__catalog__");
    expect(rig.drivers[0]?.lastPrewarm?.spec.profile.installationId).toBe(
      TRUSTED_DTO.installationId,
    );
    expect(rig.drivers[0]?.closeCount).toBe(1);
  });

  it("unknown installation → 404 INSTALLATION_NOT_FOUND, no driver created", async () => {
    const rig = await createRig(fakeRegistry({ dtos: [] }));
    host = rig.host;

    const res = await getCatalog(
      host,
      "driverId=codex-app-server&installationId=codex-ffffffffffff",
    );
    expect(res.status).toBe(404);
    expect(res.errorCode).toBe("INSTALLATION_NOT_FOUND");
    expect(rig.drivers).toHaveLength(0);
  });

  it("installation changed at the fresh revalidation gate → 409 INSTALLATION_CHANGED", async () => {
    const rig = await createRig(
      fakeRegistry({
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

    const res = await getCatalog(
      host,
      `driverId=codex-app-server&installationId=${TRUSTED_DTO.installationId}`,
    );
    expect(res.status).toBe(409);
    expect(res.errorCode).toBe("INSTALLATION_CHANGED");
    expect(rig.drivers).toHaveLength(0);
  });

  it("untrusted installation (discovered) → 403 INSTALLATION_UNTRUSTED, no driver created", async () => {
    const rig = await createRig(fakeRegistry({ dtos: [{ ...TRUSTED_DTO, state: "discovered" }] }));
    host = rig.host;

    const res = await getCatalog(
      host,
      `driverId=codex-app-server&installationId=${TRUSTED_DTO.installationId}`,
    );
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe("INSTALLATION_UNTRUSTED");
    expect(rig.drivers).toHaveLength(0);
  });

  it("unknown driverId → 400 BAD_REQUEST", async () => {
    const rig = await createRig(fakeRegistry({}));
    host = rig.host;

    const res = await getCatalog(
      host,
      `driverId=not-a-driver&installationId=${TRUSTED_DTO.installationId}`,
    );
    expect(res.status).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
    expect(rig.drivers).toHaveLength(0);
  });

  it("missing installationId → 400 BAD_REQUEST", async () => {
    const rig = await createRig(fakeRegistry({}));
    host = rig.host;

    const res = await getCatalog(host, "driverId=codex-app-server");
    expect(res.status).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
    expect(rig.drivers).toHaveLength(0);
  });

  it("missing session capability → 401 UNAUTHENTICATED", async () => {
    const rig = await createRig(fakeRegistry({}));
    host = rig.host;

    const res = await fetch(
      `${host.baseUrl}/api/v1/models/catalog?driverId=codex-app-server&installationId=${TRUSTED_DTO.installationId}`,
      { headers: { Host: CANONICAL_HOST_HEADER } },
    );
    expect(res.status).toBe(401);
    const envelope = (await res.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("UNAUTHENTICATED");
    expect(rig.drivers).toHaveLength(0);
  });

  it("a model-validating handshake rejects the placeholder but serves its catalog → 200 with it", async () => {
    const served = ["gpt-5.6-sol", "gpt-5.6-sol-mini"];
    const rig = await createRig(fakeRegistry({}), {
      "codex-app-server": (participantId: string) =>
        createErroringDriver(
          participantId,
          Object.assign(new Error("model __catalog__ not in codex catalog"), {
            runtimeCode: "MODEL_UNAVAILABLE",
            catalog: [...served],
          }),
        ),
    });
    host = rig.host;

    const res = await getCatalog(
      host,
      `driverId=codex-app-server&installationId=${TRUSTED_DTO.installationId}`,
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ catalog: served, cachedAt: expect.any(String) });
  });

  it("driver handshake failure without a catalog → mapped HTTP error (AUTH_REQUIRED → 403)", async () => {
    const rig = await createRig(fakeRegistry({}), {
      "codex-app-server": (participantId: string) =>
        createErroringDriver(
          participantId,
          Object.assign(new Error("codex local login not available"), {
            runtimeCode: "AUTH_REQUIRED",
          }),
        ),
    });
    host = rig.host;

    const res = await getCatalog(
      host,
      `driverId=codex-app-server&installationId=${TRUSTED_DTO.installationId}`,
    );
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe("AUTH_REQUIRED");
  });

  it("claude catalog is route-specific: the query route reaches the prewarm spec", async () => {
    const registry = fakeRegistry({
      dtos: [CLAUDE_DTO],
      assertExecutable: () => CLAUDE_RECORD,
    });
    const spyRef: { current: ClaudeSpyDriver | null } = { current: null };
    const rig = await createRig(registry, {
      "claude-stream-json": (participantId: string) => {
        spyRef.current = createClaudeDriver(participantId);
        return spyRef.current;
      },
    });
    host = rig.host;

    const res = await getCatalog(
      host,
      `driverId=claude-stream-json&installationId=${CLAUDE_DTO.installationId}&route=deepseek`,
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ catalog: ["GLM-5.2[1m]"], cachedAt: expect.any(String) });
    expect(spyRef.current?.lastRoute).toBe("deepseek");

    const defaulted = await getCatalog(
      host,
      `driverId=claude-stream-json&installationId=${CLAUDE_DTO.installationId}`,
    );
    expect(defaulted.status).toBe(200);
    expect(spyRef.current?.lastRoute).toBe("ant-glm5.2");
  });

  it("invalid route → 400 BAD_REQUEST", async () => {
    const rig = await createRig(fakeRegistry({}));
    host = rig.host;

    const res = await getCatalog(
      host,
      `driverId=claude-stream-json&installationId=${CLAUDE_DTO.installationId}&route=nope`,
    );
    expect(res.status).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
  });
});

describe("model catalog cache + backoff + invalidation", () => {
  const COD = `driverId=codex-app-server&installationId=${TRUSTED_DTO.installationId}`;

  it("same key within 60s → one handshake; refresh=1 forces another", async () => {
    const rig = await createRig(fakeRegistry({}));
    host = rig.host;

    const r1 = await getCatalog(host, COD);
    expect(r1.status).toBe(200);
    expect(rig.drivers).toHaveLength(1);
    expect(r1.data?.cachedAt).toEqual(expect.any(String));

    // Cache hit: no new handshake, same cachedAt.
    const r2 = await getCatalog(host, COD);
    expect(rig.drivers).toHaveLength(1);
    expect(r2.data?.cachedAt).toBe(r1.data?.cachedAt);

    // refresh=1 bypasses the cache.
    await getCatalog(host, `${COD}&refresh=1`);
    expect(rig.drivers).toHaveLength(2);
  });

  it("after 60s the same key re-handshakes", async () => {
    const rig = await createRig(fakeRegistry({}));
    host = rig.host;

    await getCatalog(host, COD);
    expect(rig.drivers).toHaveLength(1);
    rig.clock.now += 61_000;
    await getCatalog(host, COD);
    expect(rig.drivers).toHaveLength(2);
  });

  it("failure backoff keeps 4xx semantics: two hits inside the window → same 403, one handshake", async () => {
    const rig = await createRig(fakeRegistry({}), {
      "codex-app-server": (participantId: string) =>
        createErroringDriver(
          participantId,
          Object.assign(new Error("codex local login not available"), {
            runtimeCode: "AUTH_REQUIRED",
          }),
        ),
    });
    host = rig.host;

    const r1 = await getCatalog(host, COD);
    expect(r1.status).toBe(403);
    expect(r1.errorCode).toBe("AUTH_REQUIRED");

    // Inside the 2s backoff window: cached error rethrown, same status/code,
    // no extra driver (createErroringDriver is not pushed to the array, so
    // count stays 0 — assert only the status/code shape).
    const r2 = await getCatalog(host, COD);
    expect(r2.status).toBe(403);
    expect(r2.errorCode).toBe("AUTH_REQUIRED");

    // Past the 2s window: a fresh failing handshake runs.
    rig.clock.now += 2_100;
    const r3 = await getCatalog(host, COD);
    expect(r3.status).toBe(403);
    expect(r3.errorCode).toBe("AUTH_REQUIRED");
  });

  it("V5: 退避序列握手计数 + 2s/10s/30s（每级窗口边界两侧断言，证明精确序列）", async () => {
    // A failing catalog driver is wrapped so each handshake is observable via a
    // counter (createErroringDriver is not pushed to the rig array). The 4xx
    // status/code stays constant across the whole sequence; only the handshake
    // count and the backoff windows change.
    //
    // 窗口边界两侧断言(对齐 profile-readiness 序列用例):每个退避级在「窗口内」
    // 断言无新握手、在「窗口刚过」断言发新握手,逐级收窄到 2s→10s→30s→30s(capped)。
    // 取边界外断言(t=R+0.1s 窗外必握手)排除「过宽断言让错误退避也能过」——例如若
    // 实际级是 6s,2s 窗口的 t=R+2.1s 窗外会与 10s 窗口冲突,handshake 序列错位即露馅。
    let handshakes = 0;
    const rig = await createRig(fakeRegistry({}), {
      "codex-app-server": (participantId: string) => {
        handshakes += 1;
        return createErroringDriver(
          participantId,
          Object.assign(new Error("codex local login not available"), {
            runtimeCode: "AUTH_REQUIRED",
          }),
        );
      },
    });
    host = rig.host;

    // R1: fresh failure → AUTH_REQUIRED 403, one handshake.
    const r1 = await getCatalog(host, COD);
    expect(r1.status).toBe(403);
    expect(r1.errorCode).toBe("AUTH_REQUIRED");
    expect(handshakes).toBe(1);

    // ── 2s 级窗口边界两侧 ──
    // +1s: 仍在 2s 窗口内 → 缓存错误,无新握手。
    rig.clock.now += 1_000;
    const r2 = await getCatalog(host, COD);
    expect(r2.status).toBe(403);
    expect(r2.errorCode).toBe("AUTH_REQUIRED");
    expect(handshakes).toBe(1);
    // +1.1s(累计 2.1s): 越过 2s 窗口边界 → 第 2 次失败握手,进入 10s 级。
    rig.clock.now += 1_100;
    const r3 = await getCatalog(host, COD);
    expect(r3.status).toBe(403);
    expect(r3.errorCode).toBe("AUTH_REQUIRED");
    expect(handshakes).toBe(2);

    // ── 10s 级窗口边界两侧 ──
    // 第 2 次失败发生在累计 2.1s,正确 10s 级 → 下次允许时刻 = 12.1s。
    // +8.9s(累计 11.0s): 仍在 10s 窗口内 → 缓存错误,无新握手。
    // 关键点:若实际级是 6s(允许时刻 8.1s),此请求必触发新握手——卡在 [6s,10s) 之间才能抓住它。
    rig.clock.now += 8_900;
    await getCatalog(host, COD);
    expect(handshakes).toBe(2);
    // +1.2s(累计 12.2s): 越过 10s 窗口边界 → 第 3 次失败握手,进入 30s 级(capped)。
    rig.clock.now += 1_200;
    const r5 = await getCatalog(host, COD);
    expect(r5.status).toBe(403);
    expect(r5.errorCode).toBe("AUTH_REQUIRED");
    expect(handshakes).toBe(3);

    // ── 30s 级窗口边界两侧(capped,过界后仍 30s)──
    // 第 3 次失败发生在累计 12.2s,正确 30s 级 → 下次允许时刻 = 42.2s。
    // +28.8s(累计 41.0s): 仍在 30s 窗口内 → 缓存错误,无新握手。
    // 同理:若实际级是 26s(允许时刻 38.2s),此请求必触发新握手——卡在 [26s,30s) 之间抓住它。
    rig.clock.now += 28_800;
    await getCatalog(host, COD);
    expect(handshakes).toBe(3);
    // +1.3s(累计 42.3s): 越过 30s 窗口边界 → 第 4 次失败握手,仍 capped 在 30s。
    rig.clock.now += 1_300;
    const r7 = await getCatalog(host, COD);
    expect(r7.status).toBe(403);
    expect(r7.errorCode).toBe("AUTH_REQUIRED");
    expect(handshakes).toBe(4);

    // ── capped 30s 第二循环:第 4 次失败在 42.3s → 允许时刻 72.3s ──
    // +28.7s(累计 71.0s)仍窗口内;+1.4s(累计 72.4s)越界 → 第 5 次握手,证明平顶不回退。
    rig.clock.now += 28_700;
    await getCatalog(host, COD);
    expect(handshakes).toBe(4);
    rig.clock.now += 1_400;
    await getCatalog(host, COD);
    expect(handshakes).toBe(5);
  });

  it("revalidate drops the catal key → next catalog re-handshakes", async () => {
    const rig = await createRig(fakeRegistry({}));
    host = rig.host;

    await getCatalog(host, COD);
    expect(rig.drivers).toHaveLength(1);
    await getCatalog(host, COD);
    expect(rig.drivers).toHaveLength(1);

    const res = await fetch(
      `${host.baseUrl}/api/v1/installations/${TRUSTED_DTO.installationId}/revalidate`,
      { method: "POST", headers: authedHeaders(host) },
    );
    expect(res.status).toBe(200);

    await getCatalog(host, COD);
    expect(rig.drivers).toHaveLength(2);
  });

  it("route normalization: explicit route and omitted route hit the same claude cache key", async () => {
    const claudeRegistry = fakeRegistry({
      dtos: [CLAUDE_DTO],
      assertExecutable: () => CLAUDE_RECORD,
    });
    let handshakes = 0;
    const rig = await createRig(claudeRegistry, {
      "claude-stream-json": (participantId: string) => {
        handshakes += 1;
        return createClaudeDriver(participantId);
      },
    });
    host = rig.host;

    const explicit = await getCatalog(
      host,
      `driverId=claude-stream-json&installationId=${CLAUDE_DTO.installationId}&route=ant-glm5.2`,
    );
    expect(explicit.status).toBe(200);
    expect(handshakes).toBe(1);
    const defaulted = await getCatalog(
      host,
      `driverId=claude-stream-json&installationId=${CLAUDE_DTO.installationId}`,
    );
    expect(defaulted.status).toBe(200);
    expect(handshakes).toBe(1); // omitted route defaults to ant-glm5.2 → cache hit
  });

  it("V2: catalog 握手 hang 期间 revalidate 升代 → settle 后缓存未写入；下次请求重新握手（drivers +1）", async () => {
    // Mirror of the readiness V2 fence, on the catalog cache path. A hung
    // catalog handshake, revalidated mid-flight, must not write the cache.
    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const rig = await createRig(fakeRegistry({}), {
      "codex-app-server": (participantId: string) =>
        createGatedDriver(participantId, { promise: gate, resolve: resolveGate }),
    });
    host = rig.host;

    // Fire the (hung) catalog handshake.
    const inflight = getCatalog(host, COD);
    await vi.waitFor(() => {
      expect(rig.drivers).toHaveLength(1);
      expect(rig.drivers[0]?.prewarmCount).toBe(1);
    });

    // While hung, revalidate the installation → generation bumped.
    const res = await fetch(
      `${host.baseUrl}/api/v1/installations/${TRUSTED_DTO.installationId}/revalidate`,
      { method: "POST", headers: authedHeaders(host) },
    );
    expect(res.status).toBe(200);

    // Let the stale handshake settle. Its response is returned but not cached.
    resolveGate();
    const settled = await inflight;
    expect(settled.status).toBe(200);

    // Next request must re-handshake (drivers 1 → 2): the fenced handshake
    // wrote nothing to the catalog cache.
    const next = await getCatalog(host, COD);
    expect(next.status).toBe(200);
    expect(rig.drivers).toHaveLength(2);

    // Now the live-generation cache holds: a third call hits.
    await getCatalog(host, COD);
    expect(rig.drivers).toHaveLength(2);
  });
});
