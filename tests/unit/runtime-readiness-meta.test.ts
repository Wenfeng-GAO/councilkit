import type { ExecutionProfileRecord } from "@/models/execution-profile";
import { buildSettingsReadiness } from "@/runtime/readiness";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import type { InstallationDto } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

function profile(id: string, name: string): ExecutionProfileRecord {
  return {
    id,
    name,
    driverId: "claude-stream-json",
    installationId: "cld-1",
    credentialMode: CREDENTIAL_MODE,
    options: { route: "cfuse" },
    revision: 1,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T01:00:00.000Z",
  };
}

function installation(state: InstallationDto["state"], detail: string | null): InstallationDto {
  return {
    installationId: `inst-${state}`,
    driverId: "kimi-stream-json",
    state,
    executablePath: null,
    fingerprint: null,
    components: [],
    detail,
  };
}

describe("buildSettingsReadiness probe metadata", () => {
  it("maps discovering installations and copies detail text", () => {
    const model = buildSettingsReadiness({
      hostOnline: null,
      installations: [
        installation("discovering", "scanning"),
        installation("trusted", null),
        installation("changed", "fingerprint moved"),
        installation("not_found", "missing"),
        installation("invalid", "bad"),
        installation("discovered", "needs approval"),
      ],
      driverCapabilities: [
        { driverId: "cursor-stream-json", capability: "checking" },
        { driverId: "grok-stream-json", capability: "auth_required" },
        { driverId: "codex-app-server", capability: "incompatible" },
        { driverId: "claude-stream-json", capability: "ready" },
      ],
      profiles: [],
      profileReadiness: {},
    });

    expect(model.host).toBe("unknown");
    expect(model.installations).toEqual([
      {
        installationId: "inst-discovering",
        driverId: "kimi-stream-json",
        status: "discovering",
        detail: "scanning",
        action: "wait",
      },
      {
        installationId: "inst-trusted",
        driverId: "kimi-stream-json",
        status: "trusted",
        detail: null,
        action: null,
      },
      {
        installationId: "inst-changed",
        driverId: "kimi-stream-json",
        status: "changed",
        detail: "fingerprint moved",
        action: "revalidate",
      },
      {
        installationId: "inst-not_found",
        driverId: "kimi-stream-json",
        status: "not_found",
        detail: "missing",
        action: "install-requirements",
      },
      {
        installationId: "inst-invalid",
        driverId: "kimi-stream-json",
        status: "invalid",
        detail: "bad",
        action: "install-requirements",
      },
      {
        installationId: "inst-discovered",
        driverId: "kimi-stream-json",
        status: "discovered",
        detail: "needs approval",
        action: "install-requirements",
      },
    ]);
    expect(model.drivers).toEqual([
      { driverId: "cursor-stream-json", status: "checking", action: "wait" },
      { driverId: "grok-stream-json", status: "auth_required", action: "cli-login" },
      { driverId: "codex-app-server", status: "incompatible", action: "driver-diagnostics" },
      { driverId: "claude-stream-json", status: "ready", action: null },
    ]);
  });

  it("attaches cachedAt and retryAfterMs only when the probe meta has them", () => {
    const model = buildSettingsReadiness({
      hostOnline: true,
      installations: [],
      driverCapabilities: [],
      profiles: [
        profile("both", "Both"),
        profile("cached-only", "Cached"),
        profile("retry-only", "Retry"),
        profile("empty-meta", "Empty"),
        profile("ready", "Ready"),
        profile("invalid", "Invalid"),
        profile("model", "Model"),
        profile("runtime", "Runtime"),
      ],
      profileReadiness: {
        ready: { state: "ready", detail: null },
        invalid: { state: "invalid_binding", detail: "binding" },
        model: { state: "model_unavailable", detail: "no model" },
        runtime: { state: "runtime_unavailable", detail: "down" },
        both: undefined,
      },
      profileProbeMeta: {
        both: { cachedAt: "2026-07-19T00:00:00.000Z", retryAfterMs: 2000 },
        "cached-only": { cachedAt: "2026-07-19T00:00:01.000Z" },
        "retry-only": { retryAfterMs: 10 },
        "empty-meta": {},
        ready: { cachedAt: "2026-07-19T00:00:02.000Z", retryAfterMs: 0 },
      },
    });

    expect(model.host).toBe("online");
    expect(model.profiles).toEqual([
      {
        profileId: "both",
        name: "Both",
        status: "runtime_unavailable",
        detail: "Readiness has not been established (Host unavailable or not refreshed).",
        action: "edit-binding",
        checkedAt: "2026-07-19T00:00:00.000Z",
        retryAfterMs: 2000,
      },
      {
        profileId: "cached-only",
        name: "Cached",
        status: "runtime_unavailable",
        detail: "Readiness has not been established (Host unavailable or not refreshed).",
        action: "edit-binding",
        checkedAt: "2026-07-19T00:00:01.000Z",
      },
      {
        profileId: "retry-only",
        name: "Retry",
        status: "runtime_unavailable",
        detail: "Readiness has not been established (Host unavailable or not refreshed).",
        action: "edit-binding",
        retryAfterMs: 10,
      },
      {
        profileId: "empty-meta",
        name: "Empty",
        status: "runtime_unavailable",
        detail: "Readiness has not been established (Host unavailable or not refreshed).",
        action: "edit-binding",
      },
      {
        profileId: "ready",
        name: "Ready",
        status: "ready",
        detail: null,
        action: null,
        checkedAt: "2026-07-19T00:00:02.000Z",
        retryAfterMs: 0,
      },
      {
        profileId: "invalid",
        name: "Invalid",
        status: "invalid_binding",
        detail: "binding",
        action: "edit-binding",
      },
      {
        profileId: "model",
        name: "Model",
        status: "model_unavailable",
        detail: "no model",
        action: "choose-model",
      },
      {
        profileId: "runtime",
        name: "Runtime",
        status: "runtime_unavailable",
        detail: "down",
        action: "edit-binding",
      },
    ]);
  });

  it("omits probe fields when profileProbeMeta is absent and the host is offline", () => {
    const model = buildSettingsReadiness({
      hostOnline: false,
      installations: [],
      driverCapabilities: [],
      profiles: [profile("prof-1", "Claude")],
      profileReadiness: { "prof-1": { state: "ready", detail: "ok" } },
    });

    expect(model).toEqual({
      host: "unavailable",
      installations: [],
      drivers: [],
      profiles: [
        {
          profileId: "prof-1",
          name: "Claude",
          status: "ready",
          detail: "ok",
          action: null,
        },
      ],
    });
  });
});
