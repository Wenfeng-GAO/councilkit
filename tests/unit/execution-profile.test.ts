import { type ExecutionProfileRecord, toDto, validateProfileDto } from "@/models/execution-profile";
import { buildSettingsReadiness } from "@/runtime/readiness";
import {
  CREDENTIAL_MODE,
  type DriverCapabilityState,
  type InstallationState,
} from "@shared/runtime/contracts";
import type { InstallationDto, ProfileReadiness } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import { combineProfileReadiness } from "../../runtime-host/profiles/readiness";

/**
 * Browser Execution Profile model + readiness mapping. The DTO cases mirror
 * tests/unit/runtime-contract.test.ts but go through `validateProfileDto`,
 * the same entry point the Settings UI will use.
 */

function claudeRecord(overrides: Partial<ExecutionProfileRecord> = {}): ExecutionProfileRecord {
  return {
    id: "prof-1",
    name: "Claude GLM",
    driverId: "claude-stream-json",
    installationId: "cld-0123456789ab",
    credentialMode: CREDENTIAL_MODE,
    options: { route: "ant-glm5.2" },
    revision: 3,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T01:00:00.000Z",
    ...overrides,
  };
}

function installationDto(state: InstallationState): InstallationDto {
  return {
    installationId: `inst-${state}`,
    driverId: "codex-app-server",
    state,
    executablePath: state === "trusted" ? "/opt/homebrew/bin/codex" : null,
    fingerprint: state === "trusted" ? `sha256:${"a".repeat(64)}` : null,
    components: [],
    detail: null,
  };
}

describe("execution profile DTO", () => {
  it("round-trips a record to a validated DTO", () => {
    const dto = toDto(claudeRecord());
    expect(dto).toEqual({
      driverId: "claude-stream-json",
      installationId: "cld-0123456789ab",
      credentialMode: "installation-managed",
      options: { route: "ant-glm5.2" },
    });
    const validated = validateProfileDto(dto);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.dto).toEqual(dto);
    // The DTO carries no secrets or spawn configuration.
    expect(JSON.stringify(dto)).not.toMatch(/executable|argv|shell|token/i);
  });

  it("round-trips the codex profile variant", () => {
    const record = claudeRecord({
      driverId: "codex-app-server",
      installationId: "codex-fedcba987654",
      options: { reasoningEffort: "high" },
    });
    const validated = validateProfileDto(toDto(record));
    expect(validated.ok).toBe(true);
  });

  it("rejects executable/argv/shell/env/token injection", () => {
    const base = toDto(claudeRecord()) as unknown as Record<string, unknown>;
    const injections: Record<string, unknown>[] = [
      { ...base, executable: "/tmp/evil" },
      { ...base, argv: ["--danger"] },
      { ...base, shell: "bash -c id" },
      { ...base, env: { ANTHROPIC_AUTH_TOKEN: "x" } },
      { ...base, token: "secret" },
      { ...base, credentialMode: "api-key" },
      { ...base, driverId: "http" },
      { ...base, options: { route: "ant-glm5.2", executable: "/tmp/evil" } },
      { ...base, options: { route: "ant-glm5.2", model: "raw-override" } },
      { ...base, options: { route: "zenmux" } },
    ];
    for (const payload of injections) {
      expect(validateProfileDto(payload).ok).toBe(false);
    }
  });

  it("rejects options that do not match the driver", () => {
    expect(
      validateProfileDto({
        driverId: "codex-app-server",
        installationId: "codex-0123456789ab",
        credentialMode: CREDENTIAL_MODE,
        options: { route: "moonshot" },
      }).ok,
    ).toBe(false);
  });

  it("toDto refuses to emit an invalid DTO", () => {
    const bad = claudeRecord({ options: { route: "zenmux" } as never });
    expect(() => toDto(bad)).toThrow();
  });
});

describe("settings readiness mapping (Readiness table rows)", () => {
  it("maps host reachability", () => {
    const base = { installations: [], driverCapabilities: [], profiles: [], profileReadiness: {} };
    expect(buildSettingsReadiness({ ...base, hostOnline: null }).host).toBe("unknown");
    expect(buildSettingsReadiness({ ...base, hostOnline: false }).host).toBe("unavailable");
    expect(buildSettingsReadiness({ ...base, hostOnline: true }).host).toBe("online");
  });

  it("maps every Installation status with its single repair action", () => {
    const states: InstallationState[] = [
      "not_found",
      "invalid",
      "changed",
      "trusted",
      "discovered",
    ];
    const model = buildSettingsReadiness({
      hostOnline: true,
      installations: states.map(installationDto),
      driverCapabilities: [],
      profiles: [],
      profileReadiness: {},
    });
    const byStatus = new Map(model.installations.map((item) => [item.status, item]));
    expect(byStatus.get("not_found")?.action).toBe("install-requirements");
    expect(byStatus.get("invalid")?.action).toBe("install-requirements");
    expect(byStatus.get("changed")?.action).toBe("revalidate");
    expect(byStatus.get("trusted")?.action).toBeNull();
    expect(byStatus.get("discovered")?.action).toBe("install-requirements");
  });

  it("maps every Driver capability status", () => {
    const capabilities: DriverCapabilityState[] = [
      "checking",
      "auth_required",
      "incompatible",
      "ready",
    ];
    const model = buildSettingsReadiness({
      hostOnline: true,
      installations: [],
      driverCapabilities: capabilities.map((capability) => ({
        driverId: "claude-stream-json" as const,
        capability,
      })),
      profiles: [],
      profileReadiness: {},
    });
    const byStatus = new Map(model.drivers.map((item) => [item.status, item]));
    expect(byStatus.get("checking")?.action).toBe("wait");
    expect(byStatus.get("auth_required")?.action).toBe("cli-login");
    expect(byStatus.get("incompatible")?.action).toBe("driver-diagnostics");
    expect(byStatus.get("ready")?.action).toBeNull();
  });

  it("maps every Profile readiness status", () => {
    const states: ProfileReadiness["state"][] = [
      "invalid_binding",
      "runtime_unavailable",
      "model_unavailable",
      "ready",
    ];
    const profiles = states.map((state) => claudeRecord({ id: `p-${state}`, name: state }));
    const profileReadiness = Object.fromEntries(
      states.map((state) => [`p-${state}`, { state, detail: null }]),
    );
    const model = buildSettingsReadiness({
      hostOnline: true,
      installations: [],
      driverCapabilities: [],
      profiles,
      profileReadiness,
    });
    const byStatus = new Map(model.profiles.map((item) => [item.status, item]));
    expect(byStatus.get("invalid_binding")?.action).toBe("edit-binding");
    expect(byStatus.get("runtime_unavailable")?.action).toBe("edit-binding");
    expect(byStatus.get("model_unavailable")?.action).toBe("choose-model");
    expect(byStatus.get("ready")?.action).toBeNull();
  });

  it("marks profiles without a readiness response as runtime_unavailable", () => {
    const model = buildSettingsReadiness({
      hostOnline: false,
      installations: [],
      driverCapabilities: [],
      profiles: [claudeRecord()],
      profileReadiness: {},
    });
    expect(model.host).toBe("unavailable");
    expect(model.profiles[0]?.status).toBe("runtime_unavailable");
    expect(model.profiles[0]?.action).toBe("edit-binding");
  });
});

describe("combineProfileReadiness truth table", () => {
  const staticReady = { state: "ready" as const, detail: null };

  it("passes non-ready static states through unchanged", () => {
    expect(
      combineProfileReadiness({ state: "invalid_binding", detail: "x" }, "ready", true),
    ).toEqual({ state: "invalid_binding", detail: "x" });
    expect(
      combineProfileReadiness({ state: "runtime_unavailable", detail: "y" }, "ready", false),
    ).toEqual({ state: "runtime_unavailable", detail: "y" });
  });

  it("maps checking/auth_required/incompatible driver capability to runtime_unavailable", () => {
    for (const capability of ["checking", "auth_required", "incompatible"] as const) {
      const readiness = combineProfileReadiness(staticReady, capability, true);
      expect(readiness.state).toBe("runtime_unavailable");
    }
  });

  it("maps an unknown catalog model to model_unavailable", () => {
    expect(combineProfileReadiness(staticReady, "ready", false).state).toBe("model_unavailable");
  });

  it("yields ready only for ready static + ready driver + known model", () => {
    expect(combineProfileReadiness(staticReady, "ready", true)).toEqual({
      state: "ready",
      detail: null,
    });
  });
});
