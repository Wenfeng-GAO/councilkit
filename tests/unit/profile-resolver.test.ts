import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DriverId } from "@shared/runtime/contracts";
import type {
  ExecutionProfileDto,
  InstallationDto,
  ParticipantSpec,
  ResolvedBinding,
} from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";
import type { PrewarmResult } from "../../runtime-host/drivers/types";
import { discoverInstallations } from "../../runtime-host/installations/discovery";
import {
  type InstallationRecord,
  type InstallationRegistry,
  createInstallationRegistry,
} from "../../runtime-host/installations/registry";
import { createLogger } from "../../runtime-host/logging";
import { buildBinding, digestOf, resolveStatic } from "../../runtime-host/profiles/resolver";

/**
 * Resolver behavior against real installation registries. Trusted binaries live
 * under test-results/ because os.tmpdir() (/tmp is 0777) can never be promoted.
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

async function writeExecutable(
  dir: string,
  name: string,
  body: string,
  mode = 0o755,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755);
  const path = join(dir, name);
  await writeFile(path, body);
  await chmod(path, mode);
  return path;
}

function registryFor(pathEnv: string): InstallationRegistry {
  return createInstallationRegistry({
    logger: createLogger({ sink: () => undefined }),
    discover: () => discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
  });
}

function byDriver(registry: InstallationRegistry, driverId: DriverId): InstallationDto {
  const matches = registry.list().filter((dto) => dto.driverId === driverId);
  if (matches.length !== 1) {
    throw new Error(`expected one ${driverId} installation, found ${matches.length}`);
  }
  const dto = matches[0];
  if (!dto) throw new Error(`missing ${driverId} installation`);
  return dto;
}

function codexProfile(installationId: string, reasoningEffort?: string): ExecutionProfileDto {
  return {
    driverId: "codex-app-server",
    installationId,
    credentialMode: "installation-managed",
    options: reasoningEffort ? { reasoningEffort } : {},
  };
}

function claudeProfile(installationId: string, route: string): ExecutionProfileDto {
  return {
    driverId: "claude-stream-json",
    installationId,
    credentialMode: "installation-managed",
    options: { route },
  } as ExecutionProfileDto;
}

function emptyOptionsProfile(
  driverId: "kimi-stream-json" | "grok-stream-json" | "cursor-stream-json",
  installationId: string,
): ExecutionProfileDto {
  return {
    driverId,
    installationId,
    credentialMode: "installation-managed",
    options: {},
  };
}

const CODEX_FINGERPRINT = `sha256:${"ab".repeat(32)}`;
const CODEX_INSTALLATION: InstallationRecord = {
  installationId: "codex-0123456789ab",
  driverId: "codex-app-server",
  name: "codex",
  discoveredPath: "/opt/bin/codex",
  realpath: "/opt/bin/codex",
  fingerprint: CODEX_FINGERPRINT,
  state: "trusted",
  components: [{ role: "wrapper", path: "/opt/bin/codex", fingerprint: CODEX_FINGERPRINT }],
  detail: null,
};

const CODEX_PREWARM: PrewarmResult = {
  canonicalModelId: "gpt-5.6-sol",
  modelAliases: ["gpt-5.6"],
  capability: { protocol: "app-server", tools: ["shell"] },
  catalog: ["gpt-5.6-sol", "gpt-5.6"],
};

const CLAUDE_WRAPPER_FINGERPRINT = `sha256:${"cd".repeat(32)}`;
const CLAUDE_BINARY_FINGERPRINT = `sha256:${"ef".repeat(32)}`;
const CLAUDE_INSTALLATION: InstallationRecord = {
  installationId: "cld-0123456789ab",
  driverId: "claude-stream-json",
  name: "cld",
  discoveredPath: "/opt/bin/cld",
  realpath: "/opt/bin/cld",
  fingerprint: CLAUDE_WRAPPER_FINGERPRINT,
  state: "trusted",
  components: [
    { role: "wrapper", path: "/opt/bin/cld", fingerprint: CLAUDE_WRAPPER_FINGERPRINT },
    { role: "claude-binary", path: "/opt/bin/claude", fingerprint: CLAUDE_BINARY_FINGERPRINT },
  ],
  detail: null,
};

const CLAUDE_PREWARM: PrewarmResult = {
  canonicalModelId: "GLM-5.2[1m]",
  modelAliases: ["default"],
  capability: { protocol: "claude-stream-json", route: "cfuse" },
  catalog: ["GLM-5.2[1m]"],
};

const KIMI_FINGERPRINT = `sha256:${"11".repeat(32)}`;
const KIMI_INSTALLATION: InstallationRecord = {
  installationId: "kimi-0123456789ab",
  driverId: "kimi-stream-json",
  name: "kimi",
  discoveredPath: "/opt/bin/kimi",
  realpath: "/opt/bin/kimi",
  fingerprint: KIMI_FINGERPRINT,
  state: "trusted",
  components: [{ role: "wrapper", path: "/opt/bin/kimi", fingerprint: KIMI_FINGERPRINT }],
  detail: null,
};

const KIMI_PREWARM: PrewarmResult = {
  canonicalModelId: "kimi-code/k3",
  modelAliases: [],
  capability: { protocol: "kimi-stream-json", sessionResume: true },
  catalog: ["kimi-code/k3"],
};

function spec(profile: ExecutionProfileDto, modelId: string): ParticipantSpec {
  return { participantId: "seat-1", profile, modelId };
}

describe("digestOf", () => {
  it("is the sha256 of canonical JSON, independent of key insertion order", () => {
    expect(digestOf({ hello: "world" })).toBe(
      "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588",
    );
    expect(digestOf({ hello: "world!" })).toBe(
      "e4ad238ea8173c0d8539f6b53cda958084913856f1e731d61ca2cc7521dc43b4",
    );
    expect(digestOf({ b: 1, a: { d: true, c: "x" } })).toBe(
      "8db12c99f4ab6cb9510437ba655f2ce027fe900d0c2bcb0d9f4a8ad05ce2cda9",
    );
    expect(digestOf({ a: { c: "x", d: true }, b: 1 })).toBe(
      "8db12c99f4ab6cb9510437ba655f2ce027fe900d0c2bcb0d9f4a8ad05ce2cda9",
    );
  });
});

describe("resolveStatic", () => {
  it("treats an unknown installation and a throwing registry lookup as invalid_binding", async () => {
    const root = await privateDir("empty-");
    const registry = registryFor(root);
    expect(resolveStatic(codexProfile("codex-000000000000"), "gpt-5.6-sol", registry)).toEqual({
      readiness: { state: "invalid_binding", detail: "unknown installationId" },
      installation: null,
    });
    const throwing: InstallationRegistry = {
      refresh: () => [],
      list: () => [],
      get: () => {
        throw new Error("registry offline");
      },
      revalidate: () => {
        throw new Error("unused");
      },
      assertExecutable: () => {
        throw new Error("unused");
      },
    };
    expect(resolveStatic(codexProfile("codex-0123456789ab"), "gpt-5.6-sol", throwing)).toEqual({
      readiness: { state: "invalid_binding", detail: "unknown installationId" },
      installation: null,
    });
  });

  it("rejects a driver that does not match the discovered installation", async () => {
    const root = await privateDir("mismatch-");
    await writeExecutable(root, "codex", "#!/bin/sh\nexit 0\n");
    const registry = registryFor(root);
    const dto = byDriver(registry, "codex-app-server");
    expect(dto.state).toBe("trusted");
    expect(
      resolveStatic(claudeProfile(dto.installationId, "moonshot"), "GLM-5.2[1m]", registry),
    ).toEqual({
      readiness: { state: "invalid_binding", detail: "profile driver does not match installation" },
      installation: null,
    });
  });

  it("reports every non-trusted real installation state without a handshake", async () => {
    const discoveredRoot = await privateDir("discovered-");
    await writeExecutable(discoveredRoot, "codex", "#!/bin/sh\nexit 0\n");
    // writeExecutable resets the directory to 0755. chmod the ancestor after
    // that so the path is untrusted on macOS, where os.tmpdir() is user-private.
    await chmod(discoveredRoot, 0o777);
    const discovered = registryFor(discoveredRoot);
    const discoveredDto = byDriver(discovered, "codex-app-server");
    expect(discoveredDto.state).toBe("discovered");
    expect(
      resolveStatic(codexProfile(discoveredDto.installationId), "gpt-5.6-sol", discovered),
    ).toEqual({
      readiness: {
        state: "runtime_unavailable",
        detail: "installation is discovered; revalidation required",
      },
      installation: discoveredDto,
    });

    const changedRoot = await privateDir("changed-");
    const changedPath = await writeExecutable(changedRoot, "codex", "#!/bin/sh\nprintf 'v1\\n'\n");
    const changed = registryFor(changedRoot);
    const changedDto = byDriver(changed, "codex-app-server");
    expect(changedDto.state).toBe("trusted");
    await writeFile(changedPath, "#!/bin/sh\nprintf 'v2\\n'\n");
    await chmod(changedPath, 0o755);
    expect(changed.revalidate(changedDto.installationId).state).toBe("changed");
    expect(resolveStatic(codexProfile(changedDto.installationId), "other-model", changed)).toEqual({
      readiness: {
        state: "runtime_unavailable",
        detail: "installation is changed; revalidation required",
      },
      installation: changed.get(changedDto.installationId),
    });

    const missingRoot = await privateDir("missing-");
    const missingPath = await writeExecutable(missingRoot, "kimi", "#!/bin/sh\nexit 0\n");
    const missing = registryFor(missingRoot);
    const missingDto = byDriver(missing, "kimi-stream-json");
    await unlink(missingPath);
    expect(missing.revalidate(missingDto.installationId).state).toBe("not_found");
    expect(
      resolveStatic(
        emptyOptionsProfile("kimi-stream-json", missingDto.installationId),
        "kimi-code/k3",
        missing,
      ),
    ).toEqual({
      readiness: {
        state: "runtime_unavailable",
        detail: "installation is not_found; revalidation required",
      },
      installation: missing.get(missingDto.installationId),
    });

    const invalidRoot = await privateDir("invalid-cld-");
    await writeExecutable(invalidRoot, "cld", "#!/bin/sh\nexit 0\n");
    const invalid = registryFor(invalidRoot);
    const invalidDto = byDriver(invalid, "claude-stream-json");
    expect(invalidDto.state).toBe("invalid");
    expect(
      resolveStatic(claudeProfile(invalidDto.installationId, "cfuse"), "GLM-5.2[1m]", invalid),
    ).toEqual({
      readiness: {
        state: "runtime_unavailable",
        detail: "installation is invalid; revalidation required",
      },
      installation: invalidDto,
    });
  });

  it("rejects a claude route outside the supported set before any model check", async () => {
    const root = await privateDir("route-");
    await writeExecutable(root, "cld", "#!/bin/sh\nprintf 'wrapper\\n'\n");
    await writeExecutable(root, "claude", "#!/bin/sh\nprintf 'claude\\n'\n");
    const registry = registryFor(root);
    const dto = byDriver(registry, "claude-stream-json");
    expect(dto.state).toBe("trusted");
    expect(
      resolveStatic(claudeProfile(dto.installationId, "zenmux"), "GLM-5.2[1m]", registry),
    ).toEqual({
      readiness: { state: "invalid_binding", detail: "unsupported route zenmux" },
      installation: dto,
    });
  });

  it("accepts every supported claude route and ignores the requested model id", async () => {
    const root = await privateDir("routes-");
    await writeExecutable(root, "cld", "#!/bin/sh\nprintf 'wrapper\\n'\n");
    await writeExecutable(root, "claude", "#!/bin/sh\nprintf 'claude\\n'\n");
    await writeExecutable(root, "cfuse-claude-code", "#!/bin/sh\nprintf 'cfuse\\n'\n");
    const registry = registryFor(root);
    const dto = byDriver(registry, "claude-stream-json");
    expect(dto.state).toBe("trusted");
    expect(dto.components.map((component) => component.role)).toEqual([
      "wrapper",
      "claude-binary",
      "cfuse-binary",
    ]);
    for (const route of ["ant-glm5.2", "moonshot", "deepseek", "cfuse"] as const) {
      const first = resolveStatic(claudeProfile(dto.installationId, route), "model-a", registry);
      const second = resolveStatic(claudeProfile(dto.installationId, route), "model-b", registry);
      expect(first).toEqual(second);
      expect(first).toEqual({
        readiness: {
          state: "ready",
          detail: "static binding ok; driver handshake still required",
        },
        installation: dto,
      });
    }
  });

  it("accepts trusted codex, kimi, grok, and cursor profiles with no route check", async () => {
    const root = await privateDir("drivers-");
    await writeExecutable(root, "codex", "#!/bin/sh\nprintf 'codex\\n'\n");
    await writeExecutable(root, "kimi", "#!/bin/sh\nprintf 'kimi\\n'\n");
    await writeExecutable(root, "grok", "#!/bin/sh\nprintf 'grok\\n'\n");
    await writeExecutable(root, "cursor-agent", "#!/bin/sh\nprintf 'cursor\\n'\n");
    const registry = registryFor(root);
    const cases: Array<{
      driverId: DriverId;
      profile: (id: string) => ExecutionProfileDto;
      modelId: string;
    }> = [
      {
        driverId: "codex-app-server",
        profile: (id) => codexProfile(id, "high"),
        modelId: "gpt-5.6-sol",
      },
      {
        driverId: "kimi-stream-json",
        profile: (id) => emptyOptionsProfile("kimi-stream-json", id),
        modelId: "kimi-code/k3",
      },
      {
        driverId: "grok-stream-json",
        profile: (id) => emptyOptionsProfile("grok-stream-json", id),
        modelId: "grok-4",
      },
      {
        driverId: "cursor-stream-json",
        profile: (id) => emptyOptionsProfile("cursor-stream-json", id),
        modelId: "auto",
      },
    ];
    for (const entry of cases) {
      const dto = byDriver(registry, entry.driverId);
      expect(dto.state).toBe("trusted");
      expect(resolveStatic(entry.profile(dto.installationId), entry.modelId, registry)).toEqual({
        readiness: {
          state: "ready",
          detail: "static binding ok; driver handshake still required",
        },
        installation: dto,
      });
    }
  });
});

describe("buildBinding", () => {
  it("refuses a model that is neither the canonical id nor a declared alias", () => {
    const resolved = buildBinding(
      spec(codexProfile(CODEX_INSTALLATION.installationId, "high"), "gpt-4"),
      CODEX_INSTALLATION,
      CODEX_PREWARM,
    );
    expect(resolved).toEqual({
      readiness: {
        state: "model_unavailable",
        detail: "requested model is not the handshaken canonical model",
      },
      binding: null,
    });
  });

  it("binds an alias request to the canonical codex model and includes reasoningEffort", () => {
    const profile = codexProfile(CODEX_INSTALLATION.installationId, "high");
    const resolved = buildBinding(spec(profile, "gpt-5.6"), CODEX_INSTALLATION, CODEX_PREWARM);
    const binding: ResolvedBinding = {
      bindingDigest: "445fa50ad6f3ca1bf350908f2cba29982f8cba2551e63f05e7c15693dff97504",
      driverId: "codex-app-server",
      installationId: "codex-0123456789ab",
      installationFingerprint: "c32fb8474ff5d4a4cd149558c3eefd288af2760a5ab83f4345051c76e2e17714",
      capabilityDigest: "a6a04bf82a79206bec8b26f3c873af734a16eba313a5cae147b798bbdb836bc4",
      requestedModel: "gpt-5.6",
      canonicalModelId: "gpt-5.6-sol",
      modelAliases: ["gpt-5.6"],
      reasoningEffort: "high",
    };
    expect(resolved).toEqual({ readiness: { state: "ready", detail: null }, binding });
  });

  it("uses the same binding digest for the canonical model id and omits an absent reasoningEffort", () => {
    const canonical = buildBinding(
      spec(codexProfile(CODEX_INSTALLATION.installationId), "gpt-5.6-sol"),
      CODEX_INSTALLATION,
      CODEX_PREWARM,
    );
    expect(canonical).toEqual({
      readiness: { state: "ready", detail: null },
      binding: {
        bindingDigest: "7358716dea49f75f2fb69b40f5df302b90a9d53d68430397342366adefd17eec",
        driverId: "codex-app-server",
        installationId: "codex-0123456789ab",
        installationFingerprint: "c32fb8474ff5d4a4cd149558c3eefd288af2760a5ab83f4345051c76e2e17714",
        capabilityDigest: "a6a04bf82a79206bec8b26f3c873af734a16eba313a5cae147b798bbdb836bc4",
        requestedModel: "gpt-5.6-sol",
        canonicalModelId: "gpt-5.6-sol",
        modelAliases: ["gpt-5.6"],
      },
    });
    const alias = buildBinding(
      spec(codexProfile(CODEX_INSTALLATION.installationId), "gpt-5.6"),
      CODEX_INSTALLATION,
      CODEX_PREWARM,
    );
    expect(alias).toEqual({
      readiness: { state: "ready", detail: null },
      binding: {
        bindingDigest: "7358716dea49f75f2fb69b40f5df302b90a9d53d68430397342366adefd17eec",
        driverId: "codex-app-server",
        installationId: "codex-0123456789ab",
        installationFingerprint: "c32fb8474ff5d4a4cd149558c3eefd288af2760a5ab83f4345051c76e2e17714",
        capabilityDigest: "a6a04bf82a79206bec8b26f3c873af734a16eba313a5cae147b798bbdb836bc4",
        requestedModel: "gpt-5.6",
        canonicalModelId: "gpt-5.6-sol",
        modelAliases: ["gpt-5.6"],
      },
    });
  });

  it("puts the claude route on the binding and in its digest", () => {
    const resolved = buildBinding(
      spec(claudeProfile(CLAUDE_INSTALLATION.installationId, "cfuse"), "default"),
      CLAUDE_INSTALLATION,
      CLAUDE_PREWARM,
    );
    expect(resolved).toEqual({
      readiness: { state: "ready", detail: null },
      binding: {
        bindingDigest: "2fda7e6001ca37f6fea3a96c33d4a7575d33ebc6cbbaf71b4887342b0381f9d2",
        driverId: "claude-stream-json",
        installationId: "cld-0123456789ab",
        installationFingerprint: "25f13415a572665411959cc87ab4dc3534146c0cb2a48ebfad8bdb855f134df8",
        capabilityDigest: "06d6f0b0cbb22e0dcc9b734624fd4b75fad3f793064044c0c722dae082757c30",
        requestedModel: "default",
        canonicalModelId: "GLM-5.2[1m]",
        modelAliases: ["default"],
        route: "cfuse",
      },
    });
  });

  it("binds kimi with an empty alias list and no route or reasoningEffort", () => {
    const resolved = buildBinding(
      spec(
        emptyOptionsProfile("kimi-stream-json", KIMI_INSTALLATION.installationId),
        "kimi-code/k3",
      ),
      KIMI_INSTALLATION,
      KIMI_PREWARM,
    );
    expect(resolved).toEqual({
      readiness: { state: "ready", detail: null },
      binding: {
        bindingDigest: "5231093316ce3f29e0e219695abfedaac01840e806419c2216c29cda8a0ce3b0",
        driverId: "kimi-stream-json",
        installationId: "kimi-0123456789ab",
        installationFingerprint: "7c618ea9abe24f956993dfb1bc1c86d2ccb7212f078f4c7b92fa01e401e068d8",
        capabilityDigest: "c91a8824dc2106617280547edab6461d157cd8ee47e9430776a8c8ba18e53fa4",
        requestedModel: "kimi-code/k3",
        canonicalModelId: "kimi-code/k3",
        modelAliases: [],
      },
    });
  });

  it("accepts a request that is both the canonical id and listed as an alias", () => {
    const prewarm: PrewarmResult = {
      ...CODEX_PREWARM,
      modelAliases: ["gpt-5.6-sol", "gpt-5.6"],
    };
    const resolved = buildBinding(
      spec(codexProfile(CODEX_INSTALLATION.installationId), "gpt-5.6-sol"),
      CODEX_INSTALLATION,
      prewarm,
    );
    expect(resolved).toEqual({
      readiness: { state: "ready", detail: null },
      binding: {
        bindingDigest: "7358716dea49f75f2fb69b40f5df302b90a9d53d68430397342366adefd17eec",
        driverId: "codex-app-server",
        installationId: "codex-0123456789ab",
        installationFingerprint: "c32fb8474ff5d4a4cd149558c3eefd288af2760a5ab83f4345051c76e2e17714",
        capabilityDigest: "a6a04bf82a79206bec8b26f3c873af734a16eba313a5cae147b798bbdb836bc4",
        requestedModel: "gpt-5.6-sol",
        canonicalModelId: "gpt-5.6-sol",
        modelAliases: ["gpt-5.6-sol", "gpt-5.6"],
      },
    });
  });
});
