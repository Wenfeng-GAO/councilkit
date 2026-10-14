import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverCapabilityState, InstallationState } from "@shared/runtime/contracts";
import type { ExecutionProfileDto, InstallationDto } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { discoverInstallations } from "../../runtime-host/installations/discovery";
import {
  type InstallationRegistry,
  createInstallationRegistry,
} from "../../runtime-host/installations/registry";
import { createLogger } from "../../runtime-host/logging";
import {
  type InstallationLookup,
  assessProfileStatic,
  combineProfileReadiness,
} from "../../runtime-host/profiles/readiness";

/**
 * Static profile readiness is a pure lookup. Trusted fixtures cannot live in
 * os.tmpdir() because /tmp is group/other-writable and the installation trust
 * policy rejects that path chain. Discovered fixtures use os.tmpdir() on purpose.
 */

const PRIVATE_PARENT = join(process.cwd(), "test-results", "profile-unit");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateDir(prefix: string): Promise<string> {
  await mkdir(PRIVATE_PARENT, { recursive: true });
  await chmod(PRIVATE_PARENT, 0o755);
  const root = await mkdtemp(join(PRIVATE_PARENT, prefix));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

async function writeExecutable(dir: string, name: string, mode: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755);
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' ${name}\n`);
  await chmod(path, mode);
  return path;
}

function registryFor(pathEnv: string): InstallationRegistry {
  return createInstallationRegistry({
    logger: createLogger({ sink: () => undefined }),
    discover: () => discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
  });
}

function onlyInstallation(registry: InstallationRegistry): InstallationDto {
  const list = registry.list();
  if (list.length !== 1) {
    throw new Error(`expected one installation, found ${list.length}`);
  }
  const dto = list[0];
  if (!dto) throw new Error("missing installation");
  return dto;
}

function codexProfile(installationId: string): ExecutionProfileDto {
  return {
    driverId: "codex-app-server",
    installationId,
    credentialMode: "installation-managed",
    options: {},
  };
}

function installation(
  state: InstallationState,
  driverId: InstallationDto["driverId"] = "codex-app-server",
): InstallationDto {
  return {
    installationId: "codex-0123456789ab",
    driverId,
    state,
    executablePath: state === "trusted" ? "/opt/bin/codex" : null,
    fingerprint: state === "trusted" ? `sha256:${"ab".repeat(32)}` : null,
    components: [],
    detail: null,
  };
}

function lookup(dto: InstallationDto | undefined): InstallationLookup {
  return {
    get(installationId: string) {
      return dto?.installationId === installationId ? dto : undefined;
    },
  };
}

describe("assessProfileStatic", () => {
  it("names the missing installation, replacing non-ASCII and clipping the id to 64 characters", () => {
    const registry = lookup(undefined);
    expect(assessProfileStatic(codexProfile("codex-0123456789ab"), registry)).toEqual({
      state: "invalid_binding",
      detail: 'Profile references unknown installation "codex-0123456789ab".',
    });
    expect(assessProfileStatic(codexProfile("ok ~ id"), registry)).toEqual({
      state: "invalid_binding",
      detail: 'Profile references unknown installation "ok ~ id".',
    });
    expect(assessProfileStatic(codexProfile("inst-审查"), registry)).toEqual({
      state: "invalid_binding",
      detail: 'Profile references unknown installation "inst-??".',
    });
    const noisy = `codex-\u0001\u007fü${"x".repeat(80)}`;
    expect(assessProfileStatic(codexProfile(noisy), registry)).toEqual({
      state: "invalid_binding",
      detail: `Profile references unknown installation "codex-???${"x".repeat(55)}".`,
    });
    expect(assessProfileStatic(codexProfile("a".repeat(64)), registry).detail).toBe(
      `Profile references unknown installation "${"a".repeat(64)}".`,
    );
    expect(assessProfileStatic(codexProfile("a".repeat(65)), registry).detail).toBe(
      `Profile references unknown installation "${"a".repeat(64)}".`,
    );
    expect(assessProfileStatic(codexProfile(""), registry)).toEqual({
      state: "invalid_binding",
      detail: 'Profile references unknown installation "".',
    });
  });

  it("rejects a profile whose driver does not match the installation", () => {
    const dto = installation("trusted");
    const profile: ExecutionProfileDto = {
      driverId: "claude-stream-json",
      installationId: dto.installationId,
      credentialMode: "installation-managed",
      options: { route: "moonshot" },
    };
    expect(assessProfileStatic(profile, lookup(dto))).toEqual({
      state: "invalid_binding",
      detail:
        'Profile driver "claude-stream-json" does not match installation driver "codex-app-server".',
    });
  });

  it.each(["discovering", "discovered", "changed", "not_found", "invalid"] as const)(
    "requires a trusted installation and reports %s as runtime_unavailable",
    (state) => {
      expect(
        assessProfileStatic(codexProfile("codex-0123456789ab"), lookup(installation(state))),
      ).toEqual({
        state: "runtime_unavailable",
        detail: `Installation is ${state}; a trusted installation is required.`,
      });
    },
  );

  it("accepts a trusted installation and still asks for the driver handshake", () => {
    expect(
      assessProfileStatic(codexProfile("codex-0123456789ab"), lookup(installation("trusted"))),
    ).toEqual({
      state: "ready",
      detail: "Static binding is valid; the dynamic driver handshake is still required.",
    });
  });

  it("accepts a real trusted codex installation discovered on a private path", async () => {
    const root = await privateDir("trusted-");
    await writeExecutable(root, "codex", 0o755);
    const registry = registryFor(root);
    const dto = onlyInstallation(registry);
    expect(dto.state).toBe("trusted");
    expect(dto.driverId).toBe("codex-app-server");
    expect(assessProfileStatic(codexProfile(dto.installationId), registry)).toEqual({
      state: "ready",
      detail: "Static binding is valid; the dynamic driver handshake is still required.",
    });
  });

  it("reports a group-writable codex binary as runtime_unavailable", async () => {
    const root = await privateDir("writable-file-");
    await writeExecutable(root, "codex", 0o777);
    const registry = registryFor(root);
    const dto = onlyInstallation(registry);
    expect(dto.state).toBe("discovered");
    expect(assessProfileStatic(codexProfile(dto.installationId), registry)).toEqual({
      state: "runtime_unavailable",
      detail: "Installation is discovered; a trusted installation is required.",
    });
  });

  it("reports a codex binary under os.tmpdir() as runtime_unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "councilkit-profile-readiness-"));
    roots.push(root);
    await writeExecutable(root, "codex", 0o755);
    const registry = registryFor(root);
    const dto = onlyInstallation(registry);
    expect(dto.state).toBe("discovered");
    expect(assessProfileStatic(codexProfile(dto.installationId), registry)).toEqual({
      state: "runtime_unavailable",
      detail: "Installation is discovered; a trusted installation is required.",
    });
  });
});

describe("combineProfileReadiness", () => {
  const staticReady = {
    state: "ready" as const,
    detail: "Static binding is valid; the dynamic driver handshake is still required.",
  };

  it("returns a non-ready static result unchanged, including a null detail", () => {
    expect(
      combineProfileReadiness(
        { state: "invalid_binding", detail: "unknown installationId" },
        "ready",
        false,
      ),
    ).toEqual({ state: "invalid_binding", detail: "unknown installationId" });
    expect(
      combineProfileReadiness({ state: "runtime_unavailable", detail: null }, "incompatible", true),
    ).toEqual({ state: "runtime_unavailable", detail: null });
  });

  it.each(["checking", "auth_required", "incompatible"] as const)(
    "maps driver capability %s to runtime_unavailable even when the model is known",
    (capability: DriverCapabilityState) => {
      expect(combineProfileReadiness(staticReady, capability, true)).toEqual({
        state: "runtime_unavailable",
        detail: `Driver capability is ${capability}, not ready.`,
      });
      expect(combineProfileReadiness(staticReady, capability, false)).toEqual({
        state: "runtime_unavailable",
        detail: `Driver capability is ${capability}, not ready.`,
      });
    },
  );

  it("maps a ready driver with an unknown model to model_unavailable", () => {
    expect(combineProfileReadiness(staticReady, "ready", false)).toEqual({
      state: "model_unavailable",
      detail: "Selected modelId is not in the driver model catalog.",
    });
  });

  it("is ready only when the static binding, the driver, and the model are all ready", () => {
    expect(combineProfileReadiness(staticReady, "ready", true)).toEqual({
      state: "ready",
      detail: null,
    });
  });
});
