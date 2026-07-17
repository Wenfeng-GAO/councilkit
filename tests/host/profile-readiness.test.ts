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
import { afterEach, describe, expect, it } from "vitest";
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
  options: { prewarmError?: Error } = {},
): FakeDriver {
  const fake: FakeDriver = {
    participantId,
    driverId: "codex-app-server",
    sessionEpoch: 0,
    prewarmCount: 0,
    closeCount: 0,
    prewarm(): Promise<PrewarmResult> {
      fake.prewarmCount += 1;
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
}

async function createRig(
  registry: InstallationRegistry,
  driverOptions: { prewarmError?: Error } = {},
): Promise<Rig> {
  const drivers: FakeDriver[] = [];
  // Same constructor main.ts uses: probe composed from installations + the
  // per-driver factories.
  const profileProbe = createProfileProbe({
    installations: registry,
    driverFactories: {
      "codex-app-server": (participantId: string) => {
        const driver = createFakeDriver(participantId, driverOptions);
        drivers.push(driver);
        return driver;
      },
    },
    logger: nullLogger,
  });
  const host = await createTestHost({
    extraServices: { installationRegistry: registry, profileProbe },
    routesFactory: (services) => installationRoutes(services),
  });
  return { host, drivers };
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
): Promise<{ status: number; data?: ResolveProfileResponse; errorCode?: string }> {
  const res = await fetch(`${target.baseUrl}/api/v1/profiles/readiness`, {
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
