import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverInstallations } from "@host/installations/discovery";
import {
  InstallationError,
  type InstallationRegistry,
  type InstallationRegistryOptions,
  createInstallationRegistry,
} from "@host/installations/registry";
import { validateExecutable } from "@host/installations/validation";
import { createLogger } from "@host/logging";
import { assessProfileStatic } from "@host/profiles/readiness";
import {
  type ExecutionProfileDto,
  type InstallationDto,
  installationDtoSchema,
} from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Installation discovery/validation/registry behavior against real temp-dir
 * fixtures. Fixture scripts are never executed — discovery and validation are
 * filesystem metadata only.
 */

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  tempRoot = null;
});

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "councilkit-installations-"));
  return tempRoot;
}

async function writeExecutable(
  dir: string,
  name: string,
  content: string,
  mode = 0o755,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

function makeRegistry(
  pathEnv: string,
  extra: Partial<InstallationRegistryOptions> = {},
): InstallationRegistry {
  return createInstallationRegistry({
    logger: createLogger({ sink: () => undefined }),
    discover: () => discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
    ...extra,
  });
}

function first(list: InstallationDto[]): InstallationDto {
  expect(list).toHaveLength(1);
  return list[0] as InstallationDto;
}

function expectInstallationError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected InstallationError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(InstallationError);
    expect((error as InstallationError).runtimeError.code).toBe(code);
  }
}

function codexProfile(installationId: string): ExecutionProfileDto {
  return {
    driverId: "codex-app-server",
    installationId,
    credentialMode: "installation-managed",
    options: {},
  };
}

describe("validateExecutable", () => {
  it("validates a well-formed executable (realpath, owner, sha256 fingerprint)", async () => {
    const root = await makeRoot();
    const path = await writeExecutable(root, "codex", "#!/bin/sh\nexit 0\n");
    const result = validateExecutable(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.realpath).toBe(await realpath(path));
    expect(result.record.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.record.uid).toBe(process.getuid?.());
    expect(result.record.mode & 0o100).not.toBe(0);
  });

  it("returns not_found for missing files without throwing", async () => {
    const root = await makeRoot();
    const result = validateExecutable(join(root, "missing"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("rejects a file without the owner execute bit", async () => {
    const root = await makeRoot();
    const path = await writeExecutable(root, "plain", "x", 0o644);
    const result = validateExecutable(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_executable");
  });

  it("rejects group/other-writable files and writable directories in the chain", async () => {
    const root = await makeRoot();
    const writableFile = await writeExecutable(root, "writable", "x", 0o777);
    const fileResult = validateExecutable(writableFile);
    expect(fileResult.ok).toBe(false);
    if (fileResult.ok) return;
    expect(fileResult.reason).toBe("writable_path");

    const dir = join(root, "grp");
    const path = await writeExecutable(dir, "codex", "x");
    await chmod(dir, 0o775);
    const dirResult = validateExecutable(path);
    expect(dirResult.ok).toBe(false);
    if (dirResult.ok) return;
    expect(dirResult.reason).toBe("writable_path");
  });
});

describe("discoverInstallations", () => {
  it("records name/path/source/index and never executes candidates", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    const marker = join(root, "executed-marker");
    // If discovery ever executed the candidate, this script would create the
    // marker file and exit non-zero.
    await writeExecutable(bin, "codex", `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    const outcome = discoverInstallations({ env: { PATH: bin }, wellKnownDirs: [] });
    expect(outcome.installations).toHaveLength(1);
    expect(outcome.installations[0]?.wrapper).toMatchObject({
      name: "codex",
      path: join(bin, "codex"),
      source: "path",
      pathIndex: 0,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("scans well-known directories after PATH directories", async () => {
    const root = await makeRoot();
    const wellKnown = join(root, "opt", "homebrew", "bin");
    await writeExecutable(wellKnown, "codex", "x");
    const outcome = discoverInstallations({
      env: { PATH: join(root, "empty") },
      wellKnownDirs: [wellKnown],
    });
    expect(outcome.installations).toHaveLength(1);
    expect(outcome.installations[0]?.wrapper.source).toBe("well-known");
    expect(outcome.installations[0]?.wrapper.pathIndex).toBe(1);
  });
});

describe("installation registry (end-to-end temp-dir discovery)", () => {
  it("discovers a PATH fixture and pins the validated absolute realpath", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    const codexPath = await writeExecutable(bin, "codex", "#!/bin/sh\nexit 0\n");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(installationDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto.driverId).toBe("codex-app-server");
    expect(dto.state).toBe("trusted");
    expect(dto.executablePath).toBe(await realpath(codexPath));
    expect(dto.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dto.installationId).toMatch(/^codex-[0-9a-f]{12}$/);
  });

  it("keeps the pinned candidate across PATH reorders (first found wins, no silent switch)", async () => {
    const root = await makeRoot();
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    const pathA = await writeExecutable(dirA, "codex", "a-content");
    const pathB = await writeExecutable(dirB, "codex", "b-content");
    let pathEnv = `${dirA}:${dirB}`;
    const registry = createInstallationRegistry({
      logger: createLogger({ sink: () => undefined }),
      discover: () => discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
    });

    const pinned = first(registry.list());
    expect(pinned.executablePath).toBe(await realpath(pathA));
    expect(pinned.state).toBe("trusted");

    pathEnv = `${dirB}:${dirA}`;
    registry.refresh();
    const after = registry.list();
    expect(after).toHaveLength(2);
    // The pinned record is untouched: same id, same realpath, same fingerprint.
    const stillPinned = registry.get(pinned.installationId);
    expect(stillPinned?.state).toBe("trusted");
    expect(stillPinned?.fingerprint).toBe(pinned.fingerprint);
    expect(stillPinned?.executablePath).toBe(await realpath(pathA));
    // The original pin stays executable at its original path.
    expect(registry.assertExecutable(pinned.installationId).realpath).toBe(await realpath(pathA));
    // The reorder winner is a separate, explicitly listed record — no switch.
    const other = after.find((dto) => dto.installationId !== pinned.installationId);
    expect(other?.executablePath).toBe(await realpath(pathB));
    expect(other?.state).toBe("trusted");
  });

  it("detects a symlink swap after pinning as changed", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const target1 = await writeExecutable(join(root, "t1"), "codex", "v1");
    const target2 = await writeExecutable(join(root, "t2"), "codex", "v2");
    const link = join(bin, "codex");
    await symlink(target1, link);
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("trusted");
    expect(dto.executablePath).toBe(await realpath(target1));

    await rm(link);
    await symlink(target2, link);
    expect(registry.revalidate(dto.installationId).state).toBe("changed");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_CHANGED",
    );
  });

  it("flags an in-place replacement after validation as changed (fingerprint drift)", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "v1");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("trusted");

    await writeFile(path, "v2-with-different-content");
    await chmod(path, 0o755);
    expect(registry.revalidate(dto.installationId).state).toBe("changed");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_CHANGED",
    );

    // Restoring the pinned bytes re-validates back to trusted.
    await writeFile(path, "v1");
    await chmod(path, 0o755);
    expect(registry.revalidate(dto.installationId).state).toBe("trusted");
  });

  it("transitions to not_found when the pinned file vanishes", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "x");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    await rm(path);
    expect(registry.revalidate(dto.installationId).state).toBe("not_found");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_NOT_FOUND",
    );
  });

  it("revalidate throws INSTALLATION_NOT_FOUND for unknown ids", async () => {
    const root = await makeRoot();
    const registry = makeRegistry(join(root, "bin"));
    expectInstallationError(
      () => registry.revalidate("codex-000000000000"),
      "INSTALLATION_NOT_FOUND",
    );
  });
});

describe("trust policy (auto-promotion rules)", () => {
  it("keeps group/other-writable candidates discovered and never executable", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "codex", "x", 0o777);
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("discovered");
    expect(dto.fingerprint).toBeNull();
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_UNTRUSTED",
    );
    // There is no protocol-handshake pathway in this layer: nothing short of
    // passing filesystem validation at a discovery refresh establishes trust.
    expect(registry.revalidate(dto.installationId).state).toBe("discovered");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_UNTRUSTED",
    );
  });

  it("keeps candidates under a group-writable directory discovered", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "codex", "x");
    await chmod(bin, 0o775);
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("discovered");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_UNTRUSTED",
    );
  });

  it("maps injected bad_owner failures to discovered (owner rule code path)", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "codex", "x");
    // Tests cannot chown to another uid; the injected validator drives the
    // owner-rule classification directly.
    const registry = makeRegistry(bin, {
      validate: () => ({ ok: false, reason: "bad_owner", detail: "owned by uid 999" }),
    });
    const dto = first(registry.list());
    expect(dto.state).toBe("discovered");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_UNTRUSTED",
    );
  });

  it("accepts root-owned candidates reported by validation", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "x");
    const real = validateExecutable(path);
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    // Simulate a root-owned binary (owner uid 0 is allowed next to the
    // current uid) through the injected validator.
    const registry = makeRegistry(bin, {
      validate: () => ({ ok: true, record: { ...real.record, uid: 0 } }),
    });
    const dto = first(registry.list());
    expect(dto.state).toBe("trusted");
    expect(registry.assertExecutable(dto.installationId).realpath).toBe(real.record.realpath);
  });

  it("assertExecutable throws NOT_FOUND for unknown ids and returns the pinned record when trusted", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "codex", "x");
    const registry = makeRegistry(bin);
    expectInstallationError(
      () => registry.assertExecutable("codex-000000000000"),
      "INSTALLATION_NOT_FOUND",
    );
    const dto = first(registry.list());
    const record = registry.assertExecutable(dto.installationId);
    expect(record.state).toBe("trusted");
    expect(record.realpath).toBe(dto.executablePath);
    expect(record.fingerprint).toBe(dto.fingerprint);
  });
});

describe("cld composite installation", () => {
  it("pins wrapper and claude binary with two fingerprints", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-v1");
    await writeExecutable(bin, "claude", "claude-v1");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(installationDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto.driverId).toBe("claude-stream-json");
    expect(dto.state).toBe("trusted");
    expect(dto.components.map((component) => component.role)).toEqual(["wrapper", "claude-binary"]);
    const wrapper = dto.components[0];
    const claude = dto.components[1];
    expect(wrapper?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(claude?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(wrapper?.fingerprint).not.toBe(claude?.fingerprint);
  });

  it("is invalid when the underlying claude executable is missing", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-only");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("invalid");
    expect(dto.detail).toContain("claude");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_UNTRUSTED",
    );
  });

  it("goes changed when the pinned claude binary is replaced", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-v1");
    const claudePath = await writeExecutable(bin, "claude", "claude-v1");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("trusted");

    await writeFile(claudePath, "claude-v2-replaced");
    await chmod(claudePath, 0o755);
    expect(registry.revalidate(dto.installationId).state).toBe("changed");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_CHANGED",
    );
  });
});

describe("cld cfuse backend (cfuse-claude-code)", () => {
  it("discovers cfuse-claude-code alongside cld and claude", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-v1");
    await writeExecutable(bin, "claude", "claude-v1");
    await writeExecutable(bin, "cfuse-claude-code", "cfuse-v1");
    const outcome = discoverInstallations({ env: { PATH: bin }, wellKnownDirs: [] });
    const cld = outcome.installations.find((entry) => entry.name === "cld");
    expect(cld).toBeDefined();
    expect(cld?.claude?.name).toBe("claude");
    expect(cld?.cfuse?.name).toBe("cfuse-claude-code");
  });

  it("pins wrapper + claude + cfuse when all three backends validate", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-v1");
    await writeExecutable(bin, "claude", "claude-v1");
    await writeExecutable(bin, "cfuse-claude-code", "cfuse-v1");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("trusted");
    expect(dto.components.map((component) => component.role)).toEqual([
      "wrapper",
      "claude-binary",
      "cfuse-binary",
    ]);
    const cfuse = dto.components[2];
    expect(cfuse?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is trusted with only wrapper + cfuse when claude is absent (cfuse-only env)", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-v1");
    await writeExecutable(bin, "cfuse-claude-code", "cfuse-v1");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("trusted");
    expect(dto.components.map((component) => component.role)).toEqual(["wrapper", "cfuse-binary"]);
    expect(registry.assertExecutable(dto.installationId).realpath).toBeTruthy();
  });

  it("is invalid when the wrapper exists but neither backend is present", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-only");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("invalid");
    expect(dto.detail).toContain("backend");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_UNTRUSTED",
    );
  });

  it("goes changed when the pinned cfuse binary is replaced", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-v1");
    await writeExecutable(bin, "claude", "claude-v1");
    const cfusePath = await writeExecutable(bin, "cfuse-claude-code", "cfuse-v1");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("trusted");

    await writeFile(cfusePath, "cfuse-v2-replaced");
    await chmod(cfusePath, 0o755);
    expect(registry.revalidate(dto.installationId).state).toBe("changed");
    expectInstallationError(
      () => registry.assertExecutable(dto.installationId),
      "INSTALLATION_CHANGED",
    );
  });
});

describe("assessProfileStatic", () => {
  it("maps unknown/mismatched/untrusted/trusted installations", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "codex", "x");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());

    expect(assessProfileStatic(codexProfile("codex-000000000000"), registry).state).toBe(
      "invalid_binding",
    );
    const mismatched = assessProfileStatic(
      {
        driverId: "claude-stream-json",
        installationId: dto.installationId,
        credentialMode: "installation-managed",
        options: { route: "moonshot" },
      },
      registry,
    );
    expect(mismatched.state).toBe("invalid_binding");

    const ready = assessProfileStatic(codexProfile(dto.installationId), registry);
    expect(ready.state).toBe("ready");
    expect(ready.detail).toContain("handshake");
  });

  it("reports runtime_unavailable for non-trusted installations", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "codex", "x", 0o777);
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.state).toBe("discovered");
    expect(assessProfileStatic(codexProfile(dto.installationId), registry).state).toBe(
      "runtime_unavailable",
    );
  });

  it("accepts the cfuse route on a trusted cld installation (route whitelist)", async () => {
    const root = await makeRoot();
    const bin = join(root, "bin");
    await writeExecutable(bin, "cld", "wrapper-v1");
    await writeExecutable(bin, "cfuse-claude-code", "cfuse-v1");
    const registry = makeRegistry(bin);
    const dto = first(registry.list());
    expect(dto.driverId).toBe("claude-stream-json");
    const result = assessProfileStatic(
      {
        driverId: "claude-stream-json",
        installationId: dto.installationId,
        credentialMode: "installation-managed",
        options: { route: "cfuse" },
      },
      registry,
    );
    expect(result.state).toBe("ready");
  });
});
