import { statSync } from "node:fs";
import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DiscoveredCandidate,
  DiscoveryOutcome,
} from "../../runtime-host/installations/discovery";
import { discoverInstallations } from "../../runtime-host/installations/discovery";
import {
  InstallationError,
  createInstallationRegistry,
} from "../../runtime-host/installations/registry";
import { validateExecutable } from "../../runtime-host/installations/validation";
import type { InstallationComponent, InstallationDto } from "../../shared/runtime/schemas";
import {
  type LogCall,
  RUNNING_AS_ROOT,
  cleanupInstallationFixtures,
  fingerprintOf,
  installationIdFor,
  privateDir,
  recordingLogger,
  writeExecutable,
} from "./installation-fixtures";

afterEach(cleanupInstallationFixtures);

const SYSTEM_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const DRIVER_FILE_NAMES = ["cld", "codex", "kimi", "grok", "cursor-agent"] as const;

function fromPath(
  pathEnv: string,
  validate?: (path: string) => ReturnType<typeof validateExecutable>,
) {
  const recorded = recordingLogger();
  const registry = createInstallationRegistry({
    logger: recorded.logger,
    discover: () => discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
    ...(validate ? { validate } : {}),
  });
  return { registry, calls: recorded.calls };
}

function openRegistry(discover: () => DiscoveryOutcome) {
  const recorded = recordingLogger();
  const registry = createInstallationRegistry({
    logger: recorded.logger,
    discover,
  });
  return { registry, calls: recorded.calls };
}

function only(list: InstallationDto[]): InstallationDto {
  expect(list).toHaveLength(1);
  const dto = list[0];
  if (!dto) throw new Error("expected one installation");
  return dto;
}

function catchInstallation(fn: () => unknown): InstallationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InstallationError);
    if (error instanceof InstallationError) return error;
  }
  expect.unreachable("expected InstallationError");
}

function wrapperComponent(real: string): InstallationComponent {
  return { role: "wrapper", path: real, fingerprint: fingerprintOf(real) };
}

function trustedDto(
  name: string,
  driverId: InstallationDto["driverId"],
  real: string,
  components: InstallationComponent[],
): InstallationDto {
  const wrapper = components[0];
  return {
    installationId: installationIdFor(name, real),
    driverId,
    state: "trusted",
    executablePath: real,
    fingerprint: wrapper?.fingerprint ?? null,
    components,
    detail: null,
  };
}

function runtimeError(code: string, message: string) {
  return { code, phase: "discovery", message, retryable: false };
}

describe("installation registry", () => {
  it("pins a PATH executable, logs the refresh, and keeps that pin on a second refresh", async () => {
    const root = await privateDir("pin-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "codex-v1");
    const real = await realpath(path);
    const dto = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
    const { registry, calls } = fromPath(bin);
    expect(only(registry.list())).toEqual(dto);
    expect(registry.get(dto.installationId)).toEqual(dto);
    expect(registry.get("codex-000000000000")).toBeUndefined();
    expect(calls).toEqual([
      {
        event: "installations.refresh",
        context: { total: 1, trusted: 1, discovered: 0, changed: 0, invalid: 0, notFound: 0 },
      },
    ]);
    expect(only(registry.refresh())).toEqual(dto);
    expect(calls[1]).toEqual(calls[0]);
    expect(registry.assertExecutable(dto.installationId)).toEqual({
      installationId: dto.installationId,
      driverId: "codex-app-server",
      name: "codex",
      discoveredPath: path,
      realpath: real,
      fingerprint: dto.fingerprint,
      state: "trusted",
      components: dto.components,
      detail: null,
    });
    expect(calls).toHaveLength(2);
  });

  it("lists installations by driver name, not by PATH order", async () => {
    const root = await privateDir("sort-");
    const cldBin = join(root, "cld");
    const codexBin = join(root, "codex");
    const cursorBin = join(root, "cursor");
    const grokBin = join(root, "grok");
    const kimiBin = join(root, "kimi");
    const cldPath = await writeExecutable(cldBin, "cld", "wrapper");
    const claudePath = await writeExecutable(cldBin, "claude", "claude");
    const codexPath = await writeExecutable(codexBin, "codex", "codex");
    const cursorPath = await writeExecutable(cursorBin, "cursor-agent", "cursor");
    const grokPath = await writeExecutable(grokBin, "grok", "grok");
    const kimiPath = await writeExecutable(kimiBin, "kimi", "kimi");
    const cldReal = await realpath(cldPath);
    const claudeReal = await realpath(claudePath);
    const { registry } = fromPath([kimiBin, grokBin, cursorBin, codexBin, cldBin].join(":"));
    expect(registry.list()).toEqual([
      trustedDto("cld", "claude-stream-json", cldReal, [
        { role: "wrapper", path: cldReal, fingerprint: fingerprintOf(cldReal) },
        { role: "claude-binary", path: claudeReal, fingerprint: fingerprintOf(claudeReal) },
      ]),
      trustedDto("codex", "codex-app-server", await realpath(codexPath), [
        wrapperComponent(await realpath(codexPath)),
      ]),
      trustedDto("cursor-agent", "cursor-stream-json", await realpath(cursorPath), [
        wrapperComponent(await realpath(cursorPath)),
      ]),
      trustedDto("grok", "grok-stream-json", await realpath(grokPath), [
        wrapperComponent(await realpath(grokPath)),
      ]),
      trustedDto("kimi", "kimi-stream-json", await realpath(kimiPath), [
        wrapperComponent(await realpath(kimiPath)),
      ]),
    ]);
  });

  it("trusts a well-known symlink and records the link path separately from the realpath", async () => {
    const root = await privateDir("link-");
    const empty = join(root, "empty");
    const wellKnown = join(root, "well");
    const target = await writeExecutable(join(root, "target"), "codex-real", "via-link");
    await mkdir(empty, { recursive: true });
    await chmod(empty, 0o755);
    await mkdir(wellKnown, { recursive: true });
    await chmod(wellKnown, 0o755);
    const link = join(wellKnown, "codex");
    await symlink(target, link);
    const real = await realpath(target);
    const recorded = recordingLogger();
    const registry = createInstallationRegistry({
      logger: recorded.logger,
      discover: () => discoverInstallations({ env: { PATH: empty }, wellKnownDirs: [wellKnown] }),
    });
    const dto = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
    expect(only(registry.list())).toEqual(dto);
    expect(registry.assertExecutable(dto.installationId).discoveredPath).toBe(link);
    expect(registry.assertExecutable(dto.installationId).realpath).toBe(real);
  });

  it("keeps the pinned codex when PATH order changes and lists the new path as its own installation", async () => {
    const root = await privateDir("reorder-");
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    const pathA = await writeExecutable(dirA, "codex", "content-a");
    const pathB = await writeExecutable(dirB, "codex", "content-b");
    const realA = await realpath(pathA);
    const realB = await realpath(pathB);
    let pathEnv = `${dirA}:${dirB}`;
    const { registry } = openRegistry(() =>
      discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
    );
    const pinned = trustedDto("codex", "codex-app-server", realA, [wrapperComponent(realA)]);
    expect(only(registry.list())).toEqual(pinned);
    pathEnv = `${dirB}:${dirA}`;
    const listed = registry.refresh();
    const other = trustedDto("codex", "codex-app-server", realB, [wrapperComponent(realB)]);
    const expected = [pinned, other].sort((a, b) =>
      a.installationId.localeCompare(b.installationId),
    );
    expect(listed).toEqual(expected);
    expect(registry.assertExecutable(pinned.installationId).realpath).toBe(realA);
    expect(registry.assertExecutable(other.installationId).realpath).toBe(realB);
  });

  it("rechecks a pin that left PATH and returns to trusted when the same bytes reappear", async () => {
    const root = await privateDir("leave-path-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "stable");
    const real = await realpath(path);
    let pathEnv = bin;
    const { registry, calls } = openRegistry(() =>
      discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
    );
    const dto = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
    expect(only(registry.list())).toEqual(dto);
    pathEnv = "";
    expect(only(registry.refresh())).toEqual(dto);
    await rm(path);
    expect(only(registry.refresh())).toEqual({
      ...dto,
      state: "not_found",
      detail: `Pinned executable "${real}" is missing.`,
    });
    expect(calls[2]).toEqual({
      event: "installations.refresh",
      context: { total: 1, trusted: 0, discovered: 0, changed: 0, invalid: 0, notFound: 1 },
    });
    await writeExecutable(bin, "codex", "stable");
    expect(only(registry.refresh())).toEqual(dto);
  });

  it("marks a deleted symlink changed-to-missing even when the same real file is still on PATH", async () => {
    const root = await privateDir("same-real-");
    const realDir = join(root, "real");
    const linkDir = join(root, "link");
    const target = await writeExecutable(realDir, "codex", "same-bytes");
    await mkdir(linkDir, { recursive: true });
    await chmod(linkDir, 0o755);
    const link = join(linkDir, "codex");
    await symlink(target, link);
    const real = await realpath(target);
    let pathEnv = linkDir;
    const { registry } = openRegistry(() =>
      discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
    );
    const dto = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
    expect(only(registry.list())).toEqual(dto);
    expect(registry.assertExecutable(dto.installationId).discoveredPath).toBe(link);
    await rm(link);
    pathEnv = realDir;
    expect(only(registry.refresh())).toEqual({
      ...dto,
      state: "not_found",
      detail: `Pinned executable "${real}" is missing.`,
    });
  });

  it("on symlink swap, marks the old pin changed and trusts the new target under a new id", async () => {
    const root = await privateDir("swap-");
    const bin = join(root, "bin");
    const first = await writeExecutable(join(root, "t1"), "codex", "v1");
    const second = await writeExecutable(join(root, "t2"), "codex", "v2");
    await mkdir(bin, { recursive: true });
    await chmod(bin, 0o755);
    const link = join(bin, "codex");
    await symlink(first, link);
    const real1 = await realpath(first);
    const real2 = await realpath(second);
    const { registry } = fromPath(bin);
    const original = trustedDto("codex", "codex-app-server", real1, [wrapperComponent(real1)]);
    expect(only(registry.list())).toEqual(original);
    await rm(link);
    await symlink(second, link);
    const replacement = trustedDto("codex", "codex-app-server", real2, [wrapperComponent(real2)]);
    const changed = {
      ...original,
      state: "changed" as const,
      detail: "Pinned wrapper drifted: realpath changed.",
    };
    expect(registry.refresh()).toEqual(
      [changed, replacement].sort((a, b) => a.installationId.localeCompare(b.installationId)),
    );
    const error = catchInstallation(() => registry.assertExecutable(original.installationId));
    expect(error.runtimeError).toEqual(
      runtimeError(
        "INSTALLATION_CHANGED",
        `Installation "${original.installationId}" changed since validation.`,
      ),
    );
    expect(registry.assertExecutable(replacement.installationId).realpath).toBe(real2);
  });

  it("reports fingerprint drift and trusts the pin again when the original bytes are restored", async () => {
    const root = await privateDir("bytes-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "v1");
    const real = await realpath(path);
    const { registry, calls } = fromPath(bin);
    const dto = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
    expect(only(registry.list())).toEqual(dto);
    await writeFile(path, "v2-different");
    await chmod(path, 0o755);
    const changed = {
      ...dto,
      state: "changed" as const,
      detail: "Pinned wrapper drifted: fingerprint changed.",
    };
    expect(registry.revalidate(dto.installationId)).toEqual(changed);
    expect(calls[1]).toEqual({
      event: "installations.revalidated",
      context: { installationId: dto.installationId, state: "changed" },
    });
    const during = catchInstallation(() => registry.assertExecutable(dto.installationId));
    expect(during.runtimeError).toEqual(
      runtimeError(
        "INSTALLATION_CHANGED",
        `Installation "${dto.installationId}" changed since validation.`,
      ),
    );
    await writeFile(path, "v1");
    await chmod(path, 0o755);
    expect(registry.get(dto.installationId)).toEqual(changed);
    expect(registry.revalidate(dto.installationId)).toEqual(dto);
    expect(registry.assertExecutable(dto.installationId).fingerprint).toBe(dto.fingerprint);
  });

  it("reports permission drift separately from a wrapper that no longer validates", async () => {
    const root = await privateDir("mode-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "v1");
    const real = await realpath(path);
    const { registry } = fromPath(bin);
    const dto = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
    await chmod(path, 0o700);
    expect(registry.revalidate(dto.installationId)).toEqual({
      ...dto,
      state: "changed",
      detail: "Pinned wrapper drifted: permissions or ownership changed.",
    });
    await chmod(path, 0o755);
    expect(registry.revalidate(dto.installationId)).toEqual(dto);

    await chmod(path, 0o777);
    expect(registry.revalidate(dto.installationId)).toEqual({
      ...dto,
      state: "changed",
      detail: `Pinned wrapper no longer validates (writable_path): "${real}" is group- or other-writable.`,
    });
    await chmod(path, 0o755);
    expect(registry.revalidate(dto.installationId)).toEqual(dto);
    await chmod(path, 0o644);
    expect(registry.revalidate(dto.installationId)).toEqual({
      ...dto,
      state: "changed",
      detail: `Pinned wrapper no longer validates (not_executable): "${real}" lacks the owner execute bit.`,
    });
  });

  it("says an already-trusted installation vanished when assertExecutable races a delete", async () => {
    const root = await privateDir("vanish-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "v1");
    const real = await realpath(path);
    const { registry } = fromPath(bin);
    const dto = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
    await rm(path);
    const error = catchInstallation(() => registry.assertExecutable(dto.installationId));
    expect(error.name).toBe("InstallationError");
    expect(error.message).toBe(`Installation "${dto.installationId}" vanished since validation.`);
    expect(error.runtimeError).toEqual(
      runtimeError(
        "INSTALLATION_NOT_FOUND",
        `Installation "${dto.installationId}" vanished since validation.`,
      ),
    );
    expect(registry.get(dto.installationId)).toEqual({
      ...dto,
      state: "not_found",
      detail: `Pinned executable "${real}" is missing.`,
    });
    const again = catchInstallation(() => registry.assertExecutable(dto.installationId));
    expect(again.runtimeError).toEqual(
      runtimeError("INSTALLATION_NOT_FOUND", `Installation "${dto.installationId}" is missing.`),
    );
  });

  it("says the pinned fingerprint no longer matches when bytes change during assertExecutable", async () => {
    const root = await privateDir("assert-drift-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "v1");
    const real = await realpath(path);
    const { registry } = fromPath(bin);
    const dto = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
    await writeFile(path, "v2");
    await chmod(path, 0o755);
    const error = catchInstallation(() => registry.assertExecutable(dto.installationId));
    expect(error.runtimeError).toEqual(
      runtimeError(
        "INSTALLATION_CHANGED",
        `Installation "${dto.installationId}" no longer matches its pinned fingerprint.`,
      ),
    );
    expect(registry.get(dto.installationId)).toEqual({
      ...dto,
      state: "changed",
      detail: "Pinned wrapper drifted: fingerprint changed.",
    });
  });

  it("rejects unknown ids and strips control characters before truncating them", async () => {
    const root = await privateDir("unknown-");
    const { registry, calls } = fromPath(join(root, "empty"));
    const unknown = catchInstallation(() => registry.revalidate("codex-000000000000"));
    expect(unknown.runtimeError).toEqual(
      runtimeError("INSTALLATION_NOT_FOUND", 'Unknown installation "codex-000000000000".'),
    );
    const asserted = catchInstallation(() => registry.assertExecutable("codex-000000000000"));
    expect(asserted.runtimeError).toEqual(unknown.runtimeError);
    const raw = `codex-\n${"b".repeat(300)}`;
    const shown = `${`codex-${"b".repeat(300)}`.slice(0, 128)}…(truncated)`;
    const long = catchInstallation(() => registry.revalidate(raw));
    expect(long.message).toBe(`Unknown installation "${shown}".`);
    expect(long.runtimeError).toEqual(
      runtimeError("INSTALLATION_NOT_FOUND", `Unknown installation "${shown}".`),
    );
    expect(calls.map((call: LogCall) => call.event)).toEqual(["installations.refresh"]);
  });

  it("leaves group-writable files and directories discovered and not executable", async () => {
    const root = await privateDir("writable-");
    const fileBin = join(root, "file");
    const dirBin = join(root, "dir", "bin");
    const writableFile = await writeExecutable(fileBin, "grok", "x", 0o707);
    const nested = await writeExecutable(dirBin, "kimi", "x");
    await chmod(join(root, "dir"), 0o775);
    const fileReal = await realpath(writableFile);
    const kimiReal = await realpath(nested);
    const { registry } = fromPath(`${fileBin}:${dirBin}`);
    const grokId = installationIdFor("grok", fileReal);
    const kimiId = installationIdFor("kimi", kimiReal);
    const kimiDto = {
      installationId: kimiId,
      driverId: "kimi-stream-json" as const,
      state: "discovered" as const,
      executablePath: kimiReal,
      fingerprint: null,
      components: [],
      detail: `Wrapper validation failed (writable_path): Directory "${await realpath(join(root, "dir"))}" in the path chain is group- or other-writable.`,
    };
    expect(registry.list()).toEqual([
      {
        installationId: grokId,
        driverId: "grok-stream-json",
        state: "discovered",
        executablePath: fileReal,
        fingerprint: null,
        components: [],
        detail: `Wrapper validation failed (writable_path): "${fileReal}" is group- or other-writable.`,
      },
      kimiDto,
    ]);
    const grokError = catchInstallation(() => registry.assertExecutable(grokId));
    expect(grokError.runtimeError).toEqual(
      runtimeError(
        "INSTALLATION_UNTRUSTED",
        `Installation "${grokId}" is discovered, not trusted.`,
      ),
    );
    expect(registry.revalidate(kimiId)).toEqual(kimiDto);
  });

  it.skipIf(RUNNING_AS_ROOT)(
    "maps a uid mismatch to discovered and an unreadable executable to invalid",
    async () => {
      const root = await privateDir("owner-hash-");
      const bin = join(root, "bin");
      const owned = await writeExecutable(bin, "codex", "x");
      const hidden = await writeExecutable(bin, "kimi", "secret", 0o111);
      const ownedReal = await realpath(owned);
      const hiddenReal = await realpath(hidden);
      const uid = statSync(ownedReal).uid;
      const { registry } = fromPath(bin, (path) =>
        path.endsWith("/kimi") ? validateExecutable(path) : validateExecutable(path, { uid: 0 }),
      );
      const codexId = installationIdFor("codex", ownedReal);
      const kimiId = installationIdFor("kimi", hiddenReal);
      expect(registry.get(codexId)).toEqual({
        installationId: codexId,
        driverId: "codex-app-server",
        state: "discovered",
        executablePath: ownedReal,
        fingerprint: null,
        components: [],
        detail: `Wrapper validation failed (bad_owner): "${ownedReal}" is owned by uid ${uid}, not the current user or root.`,
      });
      expect(registry.get(kimiId)).toEqual({
        installationId: kimiId,
        driverId: "kimi-stream-json",
        state: "invalid",
        executablePath: hiddenReal,
        fingerprint: null,
        components: [],
        detail: `Wrapper validation failed (unreadable): "${hiddenReal}" cannot be fingerprinted (EACCES).`,
      });
      const error = catchInstallation(() => registry.assertExecutable(kimiId));
      expect(error.runtimeError).toEqual(
        runtimeError("INSTALLATION_UNTRUSTED", `Installation "${kimiId}" is invalid, not trusted.`),
      );
    },
  );

  it("trusts a repaired executable only on refresh, not on the revalidate that first sees it", async () => {
    const root = await privateDir("repair-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "v1", 0o644);
    const real = await realpath(path);
    const id = installationIdFor("codex", real);
    const { registry, calls } = fromPath(bin);
    expect(only(registry.list())).toEqual({
      installationId: id,
      driverId: "codex-app-server",
      state: "invalid",
      executablePath: real,
      fingerprint: null,
      components: [],
      detail: `Wrapper validation failed (not_executable): "${real}" lacks the owner execute bit.`,
    });
    await chmod(path, 0o755);
    const fingerprint = fingerprintOf(real);
    expect(registry.revalidate(id)).toEqual({
      installationId: id,
      driverId: "codex-app-server",
      state: "discovered",
      executablePath: real,
      fingerprint,
      components: [{ role: "wrapper", path: real, fingerprint }],
      detail: "Validation passes, but trust is (re)assigned only at discovery refresh.",
    });
    expect(calls[1]).toEqual({
      event: "installations.revalidated",
      context: { installationId: id, state: "discovered" },
    });
    const refused = catchInstallation(() => registry.assertExecutable(id));
    expect(refused.runtimeError).toEqual(
      runtimeError("INSTALLATION_UNTRUSTED", `Installation "${id}" is discovered, not trusted.`),
    );
    expect(only(registry.refresh())).toEqual(
      trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]),
    );
  });

  it("does not promote an untrusted installation when revalidate is called twice", async () => {
    const root = await privateDir("double-revalidate-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "v1", 0o644);
    const real = await realpath(path);
    const id = installationIdFor("codex", real);
    const { registry } = fromPath(bin);
    await chmod(path, 0o755);
    expect(registry.revalidate(id).state).toBe("discovered");
    expect(registry.revalidate(id)).toEqual({
      installationId: id,
      driverId: "codex-app-server",
      state: "discovered",
      executablePath: real,
      fingerprint: fingerprintOf(real),
      components: [wrapperComponent(real)],
      detail: "Validation passes, but trust is (re)assigned only at discovery refresh.",
    });
  });

  it("keeps an invalid installation invalid when it disappears from PATH", async () => {
    const root = await privateDir("drop-invalid-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "x", 0o644);
    const real = await realpath(path);
    let pathEnv = bin;
    const { registry, calls } = openRegistry(() =>
      discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
    );
    const invalid = {
      installationId: installationIdFor("codex", real),
      driverId: "codex-app-server" as const,
      state: "invalid" as const,
      executablePath: real,
      fingerprint: null,
      components: [],
      detail: `Wrapper validation failed (not_executable): "${real}" lacks the owner execute bit.`,
    };
    expect(only(registry.list())).toEqual(invalid);
    pathEnv = "";
    expect(only(registry.refresh())).toEqual(invalid);
    expect(calls[1]).toEqual({
      event: "installations.refresh",
      context: { total: 1, trusted: 0, discovered: 0, changed: 0, invalid: 1, notFound: 0 },
    });
  });

  it("pins cld with claude, with cfuse, or with both backends", async () => {
    const root = await privateDir("cld-ok-");
    const both = join(root, "both");
    const cfuseOnly = join(root, "cfuse");
    const claudeOnly = join(root, "claude");
    const bothWrapper = await writeExecutable(both, "cld", "wrapper");
    const bothClaude = await writeExecutable(both, "claude", "claude");
    const bothCfuse = await writeExecutable(both, "cfuse-claude-code", "cfuse");
    const cfuseWrapper = await writeExecutable(cfuseOnly, "cld", "wrapper-cfuse");
    const cfuseBin = await writeExecutable(cfuseOnly, "cfuse-claude-code", "cfuse-only");
    const claudeWrapper = await writeExecutable(claudeOnly, "cld", "wrapper-claude");
    const claudeBin = await writeExecutable(claudeOnly, "claude", "claude-only");
    let pathEnv = both;
    const { registry } = openRegistry(() =>
      discoverInstallations({ env: { PATH: pathEnv }, wellKnownDirs: [] }),
    );
    const bothReal = await realpath(bothWrapper);
    const bothDto = trustedDto("cld", "claude-stream-json", bothReal, [
      { role: "wrapper", path: bothReal, fingerprint: fingerprintOf(bothReal) },
      {
        role: "claude-binary",
        path: await realpath(bothClaude),
        fingerprint: fingerprintOf(await realpath(bothClaude)),
      },
      {
        role: "cfuse-binary",
        path: await realpath(bothCfuse),
        fingerprint: fingerprintOf(await realpath(bothCfuse)),
      },
    ]);
    expect(only(registry.list())).toEqual(bothDto);
    const record = registry.assertExecutable(bothDto.installationId);
    expect(record.components).toEqual(bothDto.components);
    expect(record.name).toBe("cld");

    pathEnv = cfuseOnly;
    const cfuseReal = await realpath(cfuseWrapper);
    // The previous pin is no longer discovered; refresh drift-checks it and
    // also classifies the new path.
    const listed = registry.refresh();
    const cfuseDto = trustedDto("cld", "claude-stream-json", cfuseReal, [
      { role: "wrapper", path: cfuseReal, fingerprint: fingerprintOf(cfuseReal) },
      {
        role: "cfuse-binary",
        path: await realpath(cfuseBin),
        fingerprint: fingerprintOf(await realpath(cfuseBin)),
      },
    ]);
    expect(listed).toEqual(
      [
        cfuseDto,
        {
          ...bothDto,
          state: "trusted",
          detail: null,
        },
      ].sort((a, b) => a.installationId.localeCompare(b.installationId)),
    );
    expect(registry.assertExecutable(cfuseDto.installationId).components).toEqual(
      cfuseDto.components,
    );

    pathEnv = claudeOnly;
    const claudeReal = await realpath(claudeWrapper);
    const claudeDto = trustedDto("cld", "claude-stream-json", claudeReal, [
      { role: "wrapper", path: claudeReal, fingerprint: fingerprintOf(claudeReal) },
      {
        role: "claude-binary",
        path: await realpath(claudeBin),
        fingerprint: fingerprintOf(await realpath(claudeBin)),
      },
    ]);
    const afterClaude = registry.refresh();
    expect(afterClaude).toContainEqual(claudeDto);
    expect(registry.get(cfuseDto.installationId)).toEqual(cfuseDto);
    expect(registry.get(bothDto.installationId)).toEqual(bothDto);
  });

  it("rejects a cld wrapper with no valid backend and names each backend reason", async () => {
    const root = await privateDir("cld-bad-");
    const cases = [
      {
        dir: "bare",
        files: [["cld", "wrapper", 0o755]] as const,
        state: "invalid" as const,
        detail:
          "Composite installation has no valid backend (claude: not_found, cfuse: not_found).",
      },
      {
        dir: "plain",
        files: [
          ["cld", "wrapper", 0o755],
          ["claude", "claude", 0o644],
        ] as const,
        state: "invalid" as const,
        detail:
          "Composite installation has no valid backend (claude: not_executable, cfuse: not_found).",
      },
      {
        dir: "writable",
        files: [
          ["cld", "wrapper", 0o755],
          ["claude", "claude", 0o707],
        ] as const,
        state: "discovered" as const,
        detail:
          "Composite installation has no valid backend (claude: writable_path, cfuse: not_found).",
      },
      {
        dir: "mixed",
        files: [
          ["cld", "wrapper", 0o755],
          ["claude", "claude", 0o644],
          ["cfuse-claude-code", "cfuse", 0o707],
        ] as const,
        state: "discovered" as const,
        detail:
          "Composite installation has no valid backend (claude: not_executable, cfuse: writable_path).",
      },
    ];
    for (const entry of cases) {
      const bin = join(root, entry.dir);
      for (const [name, content, mode] of entry.files) {
        await writeExecutable(bin, name, content, mode);
      }
      const real = await realpath(join(bin, "cld"));
      const { registry } = fromPath(bin);
      expect(only(registry.list())).toEqual({
        installationId: installationIdFor("cld", real),
        driverId: "claude-stream-json",
        state: entry.state,
        executablePath: real,
        fingerprint: null,
        components: [],
        detail: entry.detail,
      });
    }
  });

  it("keeps cld discovered when a backend is owned by an unexpected uid", async () => {
    const root = await privateDir("cld-owner-");
    const bin = join(root, "bin");
    const wrapper = await writeExecutable(bin, "cld", "wrapper");
    await writeExecutable(bin, "claude", "claude");
    await writeExecutable(bin, "cfuse-claude-code", "cfuse");
    const { registry } = fromPath(bin, (path) =>
      path.endsWith("/cld") ? validateExecutable(path) : validateExecutable(path, { uid: 0 }),
    );
    const id = installationIdFor("cld", await realpath(wrapper));
    expect(registry.get(id)).toEqual({
      installationId: id,
      driverId: "claude-stream-json",
      state: "discovered",
      executablePath: await realpath(wrapper),
      fingerprint: null,
      components: [],
      detail: "Composite installation has no valid backend (claude: bad_owner, cfuse: bad_owner).",
    });
  });

  it("drops a drifted cld backend and reports a backend that stops validating", async () => {
    const root = await privateDir("cld-drift-");
    const bin = join(root, "bin");
    const wrapper = await writeExecutable(bin, "cld", "wrapper");
    const claude = await writeExecutable(bin, "claude", "claude-v1");
    const cfuse = await writeExecutable(bin, "cfuse-claude-code", "cfuse-v1");
    const { registry } = fromPath(bin);
    const dto = only(registry.list());
    expect(dto.state).toBe("trusted");
    await writeFile(claude, "claude-v2");
    await chmod(claude, 0o755);
    expect(registry.revalidate(dto.installationId)).toEqual({
      ...dto,
      state: "changed",
      detail: "Pinned claude binary drifted: fingerprint changed.",
    });
    await writeFile(claude, "claude-v1");
    await chmod(claude, 0o755);
    expect(registry.revalidate(dto.installationId)).toEqual(dto);
    await rm(cfuse);
    expect(registry.revalidate(dto.installationId)).toEqual({
      ...dto,
      state: "changed",
      detail: `Pinned cfuse binary no longer validates (not_found): Executable "${cfuse}" does not exist.`,
    });
    await writeExecutable(bin, "cfuse-claude-code", "cfuse-v1");
    expect(registry.revalidate(dto.installationId)).toEqual(dto);
    await chmod(claude, 0o644);
    expect(registry.revalidate(dto.installationId)).toEqual({
      ...dto,
      state: "changed",
      detail: `Pinned claude binary no longer validates (not_executable): "${await realpath(claude)}" lacks the owner execute bit.`,
    });
    await chmod(wrapper, 0o755);
    await chmod(claude, 0o755);
    expect(registry.revalidate(dto.installationId)).toEqual(dto);
    await writeFile(wrapper, "wrapper-v2");
    await chmod(wrapper, 0o755);
    expect(registry.revalidate(dto.installationId)).toEqual({
      ...dto,
      state: "changed",
      detail: "Pinned wrapper drifted: fingerprint changed.",
    });
  });

  it("does not auto-promote a candidate whose source is neither PATH nor a well-known directory", async () => {
    const root = await privateDir("source-");
    const codex = await writeExecutable(join(root, "codex"), "codex", "x");
    const cld = await writeExecutable(join(root, "cld"), "cld", "wrapper");
    await writeExecutable(join(root, "cld"), "claude", "claude");
    const codexReal = await realpath(codex);
    const cldReal = await realpath(cld);
    const source = "sidecar" as DiscoveredCandidate["source"];
    let which: "codex" | "cld" = "codex";
    const { registry } = openRegistry(() => {
      if (which === "codex") {
        return {
          installations: [
            {
              name: "codex",
              driverId: "codex-app-server",
              wrapper: { name: "codex", path: codex, source, pathIndex: 0 },
              claude: null,
              cfuse: null,
            },
          ],
        };
      }
      return {
        installations: [
          {
            name: "cld",
            driverId: "claude-stream-json",
            wrapper: { name: "cld", path: cld, source, pathIndex: 0 },
            claude: {
              name: "claude",
              path: join(root, "cld", "claude"),
              source,
              pathIndex: 0,
            },
            cfuse: null,
          },
        ],
      };
    });
    const codexId = installationIdFor("codex", codexReal);
    const unpromoted = {
      installationId: codexId,
      driverId: "codex-app-server" as const,
      state: "discovered" as const,
      executablePath: codexReal,
      fingerprint: null,
      components: [],
      detail: "Candidate source is not eligible for V1 auto-promotion.",
    };
    expect(registry.get(codexId)).toEqual(unpromoted);
    expect(registry.revalidate(codexId)).toEqual(unpromoted);
    which = "cld";
    const cldId = installationIdFor("cld", cldReal);
    expect(registry.refresh().find((dto) => dto.installationId === cldId)).toEqual({
      installationId: cldId,
      driverId: "claude-stream-json",
      state: "discovered",
      executablePath: cldReal,
      fingerprint: null,
      components: [],
      detail: "Candidate source is not eligible for V1 auto-promotion.",
    });
    expect(registry.get(codexId)).toEqual(unpromoted);
  });

  it("pins every repaired cld backend on refresh after revalidate withholds trust", async () => {
    const root = await privateDir("cld-repair-");
    const bin = join(root, "bin");
    const wrapper = await writeExecutable(bin, "cld", "wrapper", 0o644);
    const claude = await writeExecutable(bin, "claude", "claude");
    const cfuse = await writeExecutable(bin, "cfuse-claude-code", "cfuse");
    const { registry } = fromPath(bin);
    const real = await realpath(wrapper);
    const id = installationIdFor("cld", real);
    expect(only(registry.list()).state).toBe("invalid");
    await chmod(wrapper, 0o755);
    const claudeReal = await realpath(claude);
    const cfuseReal = await realpath(cfuse);
    const components = [
      wrapperComponent(real),
      { role: "claude-binary" as const, path: claudeReal, fingerprint: fingerprintOf(claudeReal) },
      { role: "cfuse-binary" as const, path: cfuseReal, fingerprint: fingerprintOf(cfuseReal) },
    ];
    expect(registry.revalidate(id)).toEqual({
      installationId: id,
      driverId: "claude-stream-json",
      state: "discovered",
      executablePath: real,
      fingerprint: fingerprintOf(real),
      components,
      detail: "Validation passes, but trust is (re)assigned only at discovery refresh.",
    });
    expect(only(registry.refresh())).toEqual({
      installationId: id,
      driverId: "claude-stream-json",
      state: "trusted",
      executablePath: real,
      fingerprint: fingerprintOf(real),
      components,
      detail: null,
    });
    expect(registry.assertExecutable(id).components).toEqual(components);
  });

  it("records a missing candidate as not_found and a directory candidate as invalid", async () => {
    const root = await privateDir("missing-dir-");
    const missing = join(root, "missing-codex");
    const directory = join(root, "grok-dir");
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);
    const dirReal = await realpath(directory);
    const { registry } = openRegistry(() => ({
      installations: [
        {
          name: "codex",
          driverId: "codex-app-server",
          wrapper: { name: "codex", path: missing, source: "path", pathIndex: 0 },
          claude: null,
          cfuse: null,
        },
        {
          name: "grok",
          driverId: "grok-stream-json",
          wrapper: { name: "grok", path: directory, source: "path", pathIndex: 1 },
          claude: null,
          cfuse: null,
        },
      ],
    }));
    const missingId = installationIdFor("codex", missing);
    const grokId = installationIdFor("grok", dirReal);
    expect(registry.list()).toEqual([
      {
        installationId: missingId,
        driverId: "codex-app-server",
        state: "not_found",
        executablePath: null,
        fingerprint: null,
        components: [],
        detail: `Wrapper validation failed (not_found): Executable "${missing}" does not exist.`,
      },
      {
        installationId: grokId,
        driverId: "grok-stream-json",
        state: "invalid",
        executablePath: dirReal,
        fingerprint: null,
        components: [],
        detail: `Wrapper validation failed (not_executable): "${dirReal}" is not a regular file.`,
      },
    ]);
    await writeExecutable(root, "missing-codex", "now-here");
    const real = await realpath(missing);
    expect(registry.revalidate(missingId)).toEqual({
      installationId: missingId,
      driverId: "codex-app-server",
      state: "discovered",
      executablePath: real,
      fingerprint: fingerprintOf(real),
      components: [wrapperComponent(real)],
      detail: "Validation passes, but trust is (re)assigned only at discovery refresh.",
    });
  });

  it("strips control characters and caps validation detail at 1024 bytes", async () => {
    const root = await privateDir("detail-");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "x");
    const real = await realpath(path);
    const stripped = `Wrapper validation failed (unreadable): ${"y".repeat(2000)}`;
    const { registry } = fromPath(bin, () => ({
      ok: false,
      reason: "unreadable",
      detail: `\n${"y".repeat(2000)}`,
    }));
    expect(only(registry.list())).toEqual({
      installationId: installationIdFor("codex", real),
      driverId: "codex-app-server",
      state: "invalid",
      executablePath: real,
      fingerprint: null,
      components: [],
      detail: `${stripped.slice(0, 1024)}…(truncated)`,
    });
  });

  it("logs a refresh that contains every installation state at once", async () => {
    const root = await privateDir("counts-");
    const bin = join(root, "bin");
    const codex = await writeExecutable(bin, "codex", "ok");
    await writeExecutable(bin, "kimi", "plain", 0o644);
    await writeExecutable(bin, "grok", "wide", 0o707);
    await writeExecutable(bin, "cld", "wrapper");
    await writeExecutable(bin, "cursor-agent", "cursor");
    const { registry, calls } = fromPath(bin);
    expect(calls[0]).toEqual({
      event: "installations.refresh",
      context: { total: 5, trusted: 2, discovered: 1, changed: 0, invalid: 2, notFound: 0 },
    });
    await rm(codex);
    registry.refresh();
    expect(calls[1]).toEqual({
      event: "installations.refresh",
      context: { total: 5, trusted: 1, discovered: 1, changed: 0, invalid: 2, notFound: 1 },
    });
    const cursor = join(bin, "cursor-agent");
    await chmod(cursor, 0o644);
    registry.refresh();
    expect(calls[2]).toEqual({
      event: "installations.refresh",
      context: { total: 5, trusted: 0, discovered: 1, changed: 1, invalid: 2, notFound: 1 },
    });
    expect(registry.list().map((dto) => dto.state)).toEqual([
      "invalid",
      "not_found",
      "changed",
      "discovered",
      "invalid",
    ]);
  });

  it("uses discoverInstallations when no discover function is injected", async () => {
    const root = await privateDir("default-discover-");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const path = await writeExecutable(bin, "codex", "from-path");
    const real = await realpath(path);
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = bin;
    process.env.HOME = home;
    try {
      const recorded = recordingLogger();
      const registry = createInstallationRegistry({ logger: recorded.logger });
      const id = installationIdFor("codex", real);
      const expected = trustedDto("codex", "codex-app-server", real, [wrapperComponent(real)]);
      expect(registry.get(id)).toEqual(expected);
      const names = DRIVER_FILE_NAMES.filter((name) => {
        if (name === "codex") return true;
        return SYSTEM_BIN_DIRS.some((dir) => {
          try {
            return statSync(join(dir, name)).isFile();
          } catch {
            return false;
          }
        });
      });
      expect(
        registry.list().map((dto) => dto.installationId.replace(/-[0-9a-f]{12}$/, "")),
      ).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      expect(recorded.calls[0]).toEqual({
        event: "installations.refresh",
        context: {
          total: names.length,
          trusted: names.length,
          discovered: 0,
          changed: 0,
          invalid: 0,
          notFound: 0,
        },
      });
    } finally {
      // process.env entries are removed only by delete; assigning undefined stringifies them.
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("logs an empty refresh when discovery finds nothing", async () => {
    const root = await privateDir("empty-");
    const { registry, calls } = fromPath(join(root, "nowhere"));
    expect(registry.list()).toEqual([]);
    expect(calls).toEqual([
      {
        event: "installations.refresh",
        context: { total: 0, trusted: 0, discovered: 0, changed: 0, invalid: 0, notFound: 0 },
      },
    ]);
  });
});
