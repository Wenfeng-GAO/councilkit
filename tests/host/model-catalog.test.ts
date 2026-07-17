import type { ParticipantDriver, PrewarmInput, PrewarmResult } from "@host/drivers/types";
import {
  InstallationError,
  type InstallationRecord,
  type InstallationRegistry,
} from "@host/installations/registry";
import type { Logger } from "@host/logging";
import { createProfileProbe } from "@host/profiles/probe";
import { modelRoutes } from "@host/routes/models";
import { CANONICAL_HOST_HEADER } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import type { InstallationDto, ModelCatalogResponse } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";
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
}

async function createRig(
  registry: InstallationRegistry,
  factories?: Record<string, (participantId: string) => ParticipantDriver>,
): Promise<Rig> {
  const drivers: FakeDriver[] = [];
  // Same constructor main.ts uses: probe composed from installations + the
  // per-driver factories.
  const profileProbe = createProfileProbe({
    installations: registry,
    driverFactories: factories ?? {
      "codex-app-server": (participantId: string) => {
        const driver = createFakeDriver(participantId);
        drivers.push(driver);
        return driver;
      },
    },
    logger: nullLogger,
  });
  const host = await createTestHost({
    extraServices: { installationRegistry: registry, profileProbe },
    routesFactory: (services) => modelRoutes(services),
  });
  return { host, drivers };
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
    expect(res.data).toEqual({ catalog: CATALOG });
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
    expect(res.data).toEqual({ catalog: served });
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
    expect(res.data).toEqual({ catalog: ["GLM-5.2[1m]"] });
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
