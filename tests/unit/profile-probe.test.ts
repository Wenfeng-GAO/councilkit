import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DriverId } from "@shared/runtime/contracts";
import { canonicalJson } from "@shared/runtime/digest";
import type {
  ClaudeRoute,
  ExecutionProfileDto,
  InstallationDto,
  ResolvedBinding,
} from "@shared/runtime/schemas";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  ParticipantDriver,
  PrewarmInput,
  PrewarmResult,
} from "../../runtime-host/drivers/types";
import { discoverInstallations } from "../../runtime-host/installations/discovery";
import {
  InstallationError,
  type InstallationRecord,
  type InstallationRegistry,
  createInstallationRegistry,
} from "../../runtime-host/installations/registry";
import { type Logger, createLogger } from "../../runtime-host/logging";
import { createProfileProbe } from "../../runtime-host/profiles/probe";

/**
 * Dynamic profile probe. Driver factories are the process boundary: they record
 * the prewarm payload and never spawn a CLI. Trusted binaries live under
 * test-results/ because the installation trust policy rejects os.tmpdir().
 */

const PRIVATE_PARENT = join(process.cwd(), "test-results", "profile-unit");
const T0 = Date.parse("2026-07-17T00:00:00.000Z");
const T0_ISO = "2026-07-17T00:00:00.000Z";
const PROBE_ID = /^probe-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CODEX_PREWARM: PrewarmResult = {
  canonicalModelId: "gpt-5.6-sol",
  modelAliases: ["gpt-5.6"],
  capability: { protocol: "app-server", tools: ["shell"] },
  catalog: ["gpt-5.6-sol", "gpt-5.6"],
};

const roots: string[] = [];
let stableRoot = "";
let stableRegistry: InstallationRegistry | null = null;
let stableDtos: Partial<Record<DriverId, InstallationDto>> = {};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(async () => {
  if (stableRoot) await rm(stableRoot, { recursive: true, force: true });
});

async function makePrivate(prefix: string, track: boolean): Promise<string> {
  await mkdir(PRIVATE_PARENT, { recursive: true });
  await chmod(PRIVATE_PARENT, 0o755);
  const root = await mkdtemp(join(PRIVATE_PARENT, prefix));
  await chmod(root, 0o700);
  if (track) roots.push(root);
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

function stable(driverId: DriverId): InstallationDto {
  const dto = stableDtos[driverId];
  if (!stableRegistry || !dto) throw new Error(`stable ${driverId} installation is not ready`);
  return dto;
}

function stableInstallations(): InstallationRegistry {
  if (!stableRegistry) throw new Error("stable registry is not ready");
  return stableRegistry;
}

beforeAll(async () => {
  stableRoot = await makePrivate("stable-", false);
  await writeExecutable(stableRoot, "codex", "#!/bin/sh\nprintf 'codex\\n'\n");
  await writeExecutable(stableRoot, "cld", "#!/bin/sh\nprintf 'wrapper\\n'\n");
  await writeExecutable(stableRoot, "claude", "#!/bin/sh\nprintf 'claude\\n'\n");
  await writeExecutable(stableRoot, "cfuse-claude-code", "#!/bin/sh\nprintf 'cfuse\\n'\n");
  await writeExecutable(stableRoot, "kimi", "#!/bin/sh\nprintf 'kimi\\n'\n");
  await writeExecutable(stableRoot, "grok", "#!/bin/sh\nprintf 'grok\\n'\n");
  await writeExecutable(stableRoot, "cursor-agent", "#!/bin/sh\nprintf 'cursor\\n'\n");
  stableRegistry = registryFor(stableRoot);
  stableDtos = {
    "codex-app-server": byDriver(stableRegistry, "codex-app-server"),
    "claude-stream-json": byDriver(stableRegistry, "claude-stream-json"),
    "kimi-stream-json": byDriver(stableRegistry, "kimi-stream-json"),
    "grok-stream-json": byDriver(stableRegistry, "grok-stream-json"),
    "cursor-stream-json": byDriver(stableRegistry, "cursor-stream-json"),
  };
  for (const dto of Object.values(stableDtos)) {
    if (dto?.state !== "trusted") {
      throw new Error(`${dto?.driverId ?? "installation"} was ${dto?.state}, expected trusted`);
    }
  }
});

function codexProfile(installationId: string, reasoningEffort?: string): ExecutionProfileDto {
  return {
    driverId: "codex-app-server",
    installationId,
    credentialMode: "installation-managed",
    options: reasoningEffort ? { reasoningEffort } : {},
  };
}

function claudeProfile(installationId: string, route: ClaudeRoute): ExecutionProfileDto {
  return {
    driverId: "claude-stream-json",
    installationId,
    credentialMode: "installation-managed",
    options: { route },
  };
}

function emptyProfile(
  driverId: "kimi-stream-json" | "grok-stream-json" | "cursor-stream-json",
  installationId: string,
): ExecutionProfileDto {
  return { driverId, installationId, credentialMode: "installation-managed", options: {} };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function fileFingerprint(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function expectedBinding(
  profile: ExecutionProfileDto,
  modelId: string,
  installation: InstallationRecord,
  prewarm: PrewarmResult,
): ResolvedBinding {
  const capabilityDigest = sha256({ capability: prewarm.capability, catalog: prewarm.catalog });
  const installationFingerprint = sha256({
    realpath: installation.realpath,
    fingerprint: installation.fingerprint,
    components: installation.components,
  });
  const route = profile.driverId === "claude-stream-json" ? profile.options.route : undefined;
  const reasoningEffort =
    profile.driverId === "codex-app-server" ? profile.options.reasoningEffort : undefined;
  return {
    bindingDigest: sha256({
      driverId: profile.driverId,
      installationId: installation.installationId,
      installationFingerprint,
      capabilityDigest,
      canonicalModelId: prewarm.canonicalModelId,
      route,
      reasoningEffort,
    }),
    driverId: profile.driverId,
    installationId: installation.installationId,
    installationFingerprint,
    capabilityDigest,
    requestedModel: modelId,
    canonicalModelId: prewarm.canonicalModelId,
    modelAliases: prewarm.modelAliases,
    ...(profile.driverId === "claude-stream-json" ? { route: profile.options.route } : {}),
    ...(profile.driverId === "codex-app-server" && profile.options.reasoningEffort
      ? { reasoningEffort: profile.options.reasoningEffort }
      : {}),
  };
}

interface SeenCall {
  participantId: string;
  input: PrewarmInput;
}

interface DriverScript {
  seen: SeenCall[];
  closes: number;
  prewarm: (input: PrewarmInput) => Promise<PrewarmResult>;
  closeError?: unknown;
}

function scriptOf(prewarm: DriverScript["prewarm"]): DriverScript {
  return { seen: [], closes: 0, prewarm };
}

function factory(
  driverId: DriverId,
  script: DriverScript,
): (participantId: string) => ParticipantDriver {
  return (participantId: string) => ({
    participantId,
    driverId,
    sessionEpoch: 1,
    prewarm(input) {
      script.seen.push({ participantId, input });
      return script.prewarm(input);
    },
    execute() {
      return Promise.reject(new Error("probe drivers never execute"));
    },
    cancel() {
      return Promise.reject(new Error("probe drivers never cancel"));
    },
    async close() {
      script.closes += 1;
      if (script.closeError) throw script.closeError;
    },
    capabilityState: () => "ready",
    contextWindowTokens: () => 128_000,
  });
}

function clockAt(ms: number) {
  const clock = { ms };
  return {
    clock,
    now: () => clock.ms,
    iso: (value = clock.ms) => new Date(value).toISOString(),
  };
}

function probeWith(options: {
  registry?: InstallationRegistry;
  scripts: Partial<Record<DriverId, DriverScript>>;
  now?: () => number;
}) {
  const logger = createLogger({ sink: () => undefined });
  const driverFactories: Record<string, (participantId: string) => ParticipantDriver> = {};
  for (const [driverId, script] of Object.entries(options.scripts)) {
    if (!script) continue;
    driverFactories[driverId] = factory(driverId as DriverId, script);
  }
  const profileProbe = createProfileProbe({
    installations: options.registry ?? stableInstallations(),
    driverFactories,
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  return { profileProbe, logger };
}

function warnPayload(logger: Logger) {
  return logger.recentProblems().map((entry) => ({
    level: entry.level,
    event: entry.event,
    context: entry.context ?? null,
  }));
}

function authError(message = "cli is not logged in"): Error {
  return Object.assign(new Error(message), { runtimeCode: "AUTH_REQUIRED" });
}

describe("profile probe readiness", () => {
  it("returns a ready codex binding from the real installation and always closes the probe driver", async () => {
    const time = clockAt(T0);
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe, logger } = probeWith({
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    const dto = stable("codex-app-server");
    const profile = codexProfile(dto.installationId, "high");
    const record = stableInstallations().assertExecutable(dto.installationId);
    expect(record.fingerprint).toBe(fileFingerprint(record.realpath));

    const result = await profileProbe.readiness(profile, "gpt-5.6");
    expect(Object.keys(result).sort()).toEqual(["binding", "cachedAt", "readiness"]);
    expect(result).toEqual({
      readiness: { state: "ready", detail: null },
      binding: expectedBinding(profile, "gpt-5.6", record, CODEX_PREWARM),
      cachedAt: T0_ISO,
    });
    expect(script.seen).toHaveLength(1);
    const call = script.seen[0];
    if (!call) throw new Error("missing prewarm");
    expect(call.participantId).toMatch(PROBE_ID);
    expect(call.input).toEqual({
      participantId: call.participantId,
      spec: { participantId: call.participantId, profile, modelId: "gpt-5.6" },
      installation: record,
    });
    expect(script.closes).toBe(1);
    expect(warnPayload(logger)).toEqual([]);
  });

  it("stamps cachedAt from the default clock when no clock is injected", async () => {
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe } = probeWith({ scripts: { "codex-app-server": script } });
    const dto = stable("codex-app-server");
    const profile = codexProfile(dto.installationId);
    const before = Date.now();
    const result = await profileProbe.readiness(profile, "gpt-5.6-sol");
    const after = Date.now();
    const stamped = Date.parse(result.cachedAt);
    expect(result.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.cachedAt).toBe(new Date(stamped).toISOString());
    expect(stamped >= before && stamped <= after).toBe(true);
    expect(result.readiness).toEqual({ state: "ready", detail: null });
    expect(result.binding).toEqual(
      expectedBinding(
        profile,
        "gpt-5.6-sol",
        stableInstallations().assertExecutable(dto.installationId),
        CODEX_PREWARM,
      ),
    );
  });

  it("binds a claude cfuse route and a kimi profile with no route", async () => {
    const time = clockAt(T0);
    const claudeScript = scriptOf(async (input) => ({
      canonicalModelId: input.spec.modelId,
      modelAliases: ["default"],
      capability: { protocol: "claude-stream-json" },
      catalog: [input.spec.modelId],
    }));
    const kimiScript = scriptOf(async () => ({
      canonicalModelId: "kimi-code/k3",
      modelAliases: [],
      capability: { protocol: "kimi-stream-json" },
      catalog: ["kimi-code/k3"],
    }));
    const { profileProbe } = probeWith({
      scripts: { "claude-stream-json": claudeScript, "kimi-stream-json": kimiScript },
      now: time.now,
    });
    const claude = claudeProfile(stable("claude-stream-json").installationId, "cfuse");
    const claudeRecord = stableInstallations().assertExecutable(claude.installationId);
    const claudePrewarm: PrewarmResult = {
      canonicalModelId: "GLM-5.2[1m]",
      modelAliases: ["default"],
      capability: { protocol: "claude-stream-json" },
      catalog: ["GLM-5.2[1m]"],
    };
    const claudeResult = await profileProbe.readiness(claude, "GLM-5.2[1m]");
    expect(claudeResult).toEqual({
      readiness: { state: "ready", detail: null },
      binding: expectedBinding(claude, "GLM-5.2[1m]", claudeRecord, claudePrewarm),
      cachedAt: T0_ISO,
    });
    expect(claudeScript.closes).toBe(1);

    const kimi = emptyProfile("kimi-stream-json", stable("kimi-stream-json").installationId);
    const kimiRecord = stableInstallations().assertExecutable(kimi.installationId);
    const kimiPrewarm: PrewarmResult = {
      canonicalModelId: "kimi-code/k3",
      modelAliases: [],
      capability: { protocol: "kimi-stream-json" },
      catalog: ["kimi-code/k3"],
    };
    const kimiResult = await profileProbe.readiness(kimi, "kimi-code/k3");
    expect(kimiResult.binding).toEqual(
      expectedBinding(kimi, "kimi-code/k3", kimiRecord, kimiPrewarm),
    );
    expect(kimiScript.closes).toBe(1);
  });

  it("reports a model outside the handshake as model_unavailable without a driver warning", async () => {
    const time = clockAt(T0);
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe, logger } = probeWith({
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    const result = await profileProbe.readiness(
      codexProfile(stable("codex-app-server").installationId),
      "gpt-4",
    );
    expect(result).toEqual({
      readiness: {
        state: "model_unavailable",
        detail: "requested model is not the handshaken canonical model",
      },
      binding: null,
      cachedAt: T0_ISO,
      retryAfterMs: 2_000,
    });
    expect(script.closes).toBe(1);
    expect(warnPayload(logger)).toEqual([]);
  });

  it("maps a MODEL_UNAVAILABLE prewarm rejection and logs only the driver id and code", async () => {
    const time = clockAt(T0);
    const script = scriptOf(() =>
      Promise.reject(
        Object.assign(new Error("model gpt-x is not served"), { runtimeCode: "MODEL_UNAVAILABLE" }),
      ),
    );
    const { profileProbe, logger } = probeWith({
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    const result = await profileProbe.readiness(
      codexProfile(stable("codex-app-server").installationId),
      "gpt-x",
    );
    expect(result).toEqual({
      readiness: { state: "model_unavailable", detail: "model gpt-x is not served" },
      binding: null,
      cachedAt: T0_ISO,
      retryAfterMs: 2_000,
    });
    expect(script.closes).toBe(1);
    expect(warnPayload(logger)).toEqual([
      {
        level: "warn",
        event: "profile.probe_failed",
        context: { driverId: "codex-app-server", code: "MODEL_UNAVAILABLE" },
      },
    ]);
    expect(logger.recentProblems()[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("clips prewarm errors to 256 UTF-16 units and keeps a whole emoji", async () => {
    const time = clockAt(T0);
    const emoji = scriptOf(() =>
      Promise.reject(
        Object.assign(new Error(`${"a".repeat(255)}😀TAIL`), { runtimeCode: "AUTH_REQUIRED" }),
      ),
    );
    const exact = scriptOf(() => Promise.reject(new Error("b".repeat(256))));
    const over = scriptOf(() => Promise.reject(new Error("c".repeat(257))));
    const emojiProbe = probeWith({ scripts: { "codex-app-server": emoji }, now: time.now });
    const exactProbe = probeWith({ scripts: { "codex-app-server": exact }, now: time.now });
    const overProbe = probeWith({ scripts: { "codex-app-server": over }, now: time.now });
    const id = stable("codex-app-server").installationId;
    const emojiResult = await emojiProbe.profileProbe.readiness(codexProfile(id), "gpt-5.6-sol");
    const exactResult = await exactProbe.profileProbe.readiness(codexProfile(id), "gpt-5.6-sol");
    const overResult = await overProbe.profileProbe.readiness(codexProfile(id), "gpt-5.6-sol");
    expect(emojiResult.readiness.detail).toBe("a".repeat(255));
    expect(exactResult.readiness.detail).toBe("b".repeat(256));
    expect(overResult.readiness.detail).toBe("c".repeat(256));
    expect(warnPayload(overProbe.logger)).toEqual([
      {
        level: "warn",
        event: "profile.probe_failed",
        context: { driverId: "codex-app-server", code: "UNKNOWN" },
      },
    ]);
  });

  it("maps a non-Error prewarm rejection to the generic prewarm failure", async () => {
    const time = clockAt(T0);
    const script = scriptOf(() => Promise.reject("nope"));
    const { profileProbe, logger } = probeWith({
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    const result = await profileProbe.readiness(
      codexProfile(stable("codex-app-server").installationId),
      "gpt-5.6-sol",
    );
    expect(result.readiness).toEqual({ state: "runtime_unavailable", detail: "prewarm failed" });
    expect(result.binding).toBeNull();
    expect(result.retryAfterMs).toBe(2_000);
    expect(script.closes).toBe(1);
    expect(warnPayload(logger)).toEqual([
      {
        level: "warn",
        event: "profile.probe_failed",
        context: { driverId: "codex-app-server", code: "UNKNOWN" },
      },
    ]);
  });

  it("reports a missing driver factory and a non-Error factory failure without opening a driver", async () => {
    const time = clockAt(T0);
    const id = stable("codex-app-server").installationId;
    const missing = probeWith({ scripts: {}, now: time.now });
    const missingResult = await missing.profileProbe.readiness(codexProfile(id), "gpt-5.6-sol");
    expect(missingResult).toEqual({
      readiness: {
        state: "runtime_unavailable",
        detail: 'No driver factory is registered for "codex-app-server".',
      },
      binding: null,
      cachedAt: T0_ISO,
      retryAfterMs: 2_000,
    });
    expect(warnPayload(missing.logger)).toEqual([]);

    const thrownProbe = createProfileProbe({
      installations: stableInstallations(),
      driverFactories: {
        "codex-app-server": () => {
          throw "nope";
        },
      },
      logger: createLogger({ sink: () => undefined }),
      now: time.now,
    });
    const thrownResult = await thrownProbe.readiness(codexProfile(id), "gpt-5.6-sol");
    expect(thrownResult.readiness).toEqual({
      state: "runtime_unavailable",
      detail: "probe failed",
    });
    expect(thrownResult.binding).toBeNull();
  });

  it("turns static binding failures into readiness states and does not construct a driver", async () => {
    const time = clockAt(T0);
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe } = probeWith({
      scripts: { "codex-app-server": script, "claude-stream-json": script },
      now: time.now,
    });
    const unknown = await profileProbe.readiness(codexProfile("codex-000000000000"), "gpt-5.6-sol");
    expect(unknown).toEqual({
      readiness: { state: "invalid_binding", detail: "unknown installationId" },
      binding: null,
      cachedAt: T0_ISO,
      retryAfterMs: 2_000,
    });
    const mismatched = await profileProbe.readiness(
      claudeProfile(stable("codex-app-server").installationId, "moonshot"),
      "GLM-5.2[1m]",
    );
    expect(mismatched.readiness).toEqual({
      state: "invalid_binding",
      detail: "profile driver does not match installation",
    });
    const unsupported = await profileProbe.readiness(
      {
        driverId: "claude-stream-json",
        installationId: stable("claude-stream-json").installationId,
        credentialMode: "installation-managed",
        options: { route: "zenmux" },
      } as unknown as ExecutionProfileDto,
      "GLM-5.2[1m]",
    );
    expect(unsupported.readiness).toEqual({
      state: "invalid_binding",
      detail: "unsupported route zenmux",
    });
    expect(script.seen).toHaveLength(0);
    expect(script.closes).toBe(0);
  });

  it("maps a fresh fingerprint drift and a vanished binary to invalid_binding", async () => {
    const time = clockAt(T0);
    const driftRoot = await makePrivate("drift-", true);
    const driftPath = await writeExecutable(driftRoot, "codex", "#!/bin/sh\nprintf 'v1\\n'\n");
    const driftRegistry = registryFor(driftRoot);
    const driftDto = byDriver(driftRegistry, "codex-app-server");
    const driftScript = scriptOf(async () => CODEX_PREWARM);
    const driftProbe = probeWith({
      registry: driftRegistry,
      scripts: { "codex-app-server": driftScript },
      now: time.now,
    });
    await writeFile(driftPath, "#!/bin/sh\nprintf 'v2\\n'\n");
    await chmod(driftPath, 0o755);
    const drifted = await driftProbe.profileProbe.readiness(
      codexProfile(driftDto.installationId),
      "gpt-5.6-sol",
    );
    expect(drifted).toEqual({
      readiness: {
        state: "invalid_binding",
        detail: `Installation "${driftDto.installationId}" no longer matches its pinned fingerprint.`,
      },
      binding: null,
      cachedAt: T0_ISO,
      retryAfterMs: 2_000,
    });
    expect(driftScript.seen).toHaveLength(0);
    expect(warnPayload(driftProbe.logger)).toEqual([]);

    time.clock.ms = T0 + 2_000;
    const afterDrift = await driftProbe.profileProbe.readiness(
      codexProfile(driftDto.installationId),
      "gpt-5.6-sol",
    );
    expect(afterDrift.readiness).toEqual({
      state: "runtime_unavailable",
      detail: "installation is changed; revalidation required",
    });
    expect(driftScript.seen).toHaveLength(0);

    const goneRoot = await makePrivate("gone-", true);
    const gonePath = await writeExecutable(goneRoot, "kimi", "#!/bin/sh\nprintf 'kimi\\n'\n");
    const goneRegistry = registryFor(goneRoot);
    const goneDto = byDriver(goneRegistry, "kimi-stream-json");
    const goneScript = scriptOf(async () => CODEX_PREWARM);
    const goneProbe = probeWith({
      registry: goneRegistry,
      scripts: { "kimi-stream-json": goneScript },
      now: time.now,
    });
    await unlink(gonePath);
    const vanished = await goneProbe.profileProbe.readiness(
      emptyProfile("kimi-stream-json", goneDto.installationId),
      "kimi-code/k3",
    );
    expect(vanished.readiness).toEqual({
      state: "invalid_binding",
      detail: `Installation "${goneDto.installationId}" vanished since validation.`,
    });
    expect(vanished.binding).toBeNull();
    expect(goneScript.seen).toHaveLength(0);
  });

  it("keeps serving a discovered installation from the backoff cache after it becomes trusted", async () => {
    const time = clockAt(T0);
    const root = await makePrivate("promote-", true);
    const path = await writeExecutable(root, "codex", "#!/bin/sh\nprintf 'codex\\n'\n", 0o777);
    const registry = registryFor(root);
    const dto = byDriver(registry, "codex-app-server");
    expect(dto.state).toBe("discovered");
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe } = probeWith({
      registry,
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    const profile = codexProfile(dto.installationId);
    const first = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(first).toEqual({
      readiness: {
        state: "runtime_unavailable",
        detail: "installation is discovered; revalidation required",
      },
      binding: null,
      cachedAt: T0_ISO,
      retryAfterMs: 2_000,
    });
    await chmod(path, 0o755);
    registry.refresh();
    expect(registry.get(dto.installationId)?.state).toBe("trusted");
    const second = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(second).toEqual(first);
    expect(script.seen).toHaveLength(0);

    time.clock.ms = T0 + 2_000;
    const third = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(third.readiness).toEqual({ state: "ready", detail: null });
    expect(third.cachedAt).toBe(time.iso());
    expect(third.retryAfterMs).toBeUndefined();
    expect(script.seen).toHaveLength(1);
    expect(script.closes).toBe(1);
  });

  it("reuses a success for 60s, distinguishes profile key order from model and option changes, and refresh bypasses it", async () => {
    const time = clockAt(T0);
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe } = probeWith({ scripts: { "codex-app-server": script }, now: time.now });
    const id = stable("codex-app-server").installationId;
    const forward: ExecutionProfileDto = {
      driverId: "codex-app-server",
      installationId: id,
      credentialMode: "installation-managed",
      options: {},
    };
    const backward: ExecutionProfileDto = {
      options: {},
      credentialMode: "installation-managed",
      installationId: id,
      driverId: "codex-app-server",
    };
    const first = await profileProbe.readiness(forward, "gpt-5.6-sol");
    const reordered = await profileProbe.readiness(backward, "gpt-5.6-sol");
    expect(reordered).toEqual(first);
    expect(script.seen).toHaveLength(1);

    time.clock.ms = T0 + 59_999;
    const inside = await profileProbe.readiness(forward, "gpt-5.6-sol");
    expect(inside).toEqual(first);
    expect(script.seen).toHaveLength(1);

    time.clock.ms = T0 + 1;
    const refreshed = await profileProbe.readiness(forward, "gpt-5.6-sol", { refresh: true });
    expect(refreshed.cachedAt).toBe(time.iso());
    expect(refreshed.readiness).toEqual({ state: "ready", detail: null });
    expect(script.seen).toHaveLength(2);

    const otherModel = await profileProbe.readiness(forward, "gpt-5.6");
    expect(otherModel.binding?.requestedModel).toBe("gpt-5.6");
    expect(script.seen).toHaveLength(3);
    const again = await profileProbe.readiness(forward, "gpt-5.6-sol");
    expect(again.cachedAt).toBe(time.iso());
    expect(script.seen).toHaveLength(3);

    const withEffort = await profileProbe.readiness(codexProfile(id, "high"), "gpt-5.6-sol");
    expect(withEffort.binding?.reasoningEffort).toBe("high");
    expect(script.seen).toHaveLength(4);

    time.clock.ms = T0 + 1 + 60_000;
    await profileProbe.readiness(forward, "gpt-5.6-sol");
    expect(script.seen).toHaveLength(5);
  });

  it("serves readiness failures on a 2s, 10s, then capped 30s backoff and does not log cache hits", async () => {
    const time = clockAt(T0);
    const script = scriptOf(() => Promise.reject(authError()));
    const { profileProbe, logger } = probeWith({
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    const profile = codexProfile(stable("codex-app-server").installationId);
    const failure = (retryAfterMs: number, cachedAt: string) => ({
      readiness: { state: "runtime_unavailable", detail: "cli is not logged in" },
      binding: null,
      cachedAt,
      retryAfterMs,
    });

    expect(await profileProbe.readiness(profile, "gpt-5.6-sol")).toEqual(failure(2_000, T0_ISO));
    time.clock.ms = T0 + 1_999;
    expect(await profileProbe.readiness(profile, "gpt-5.6-sol")).toEqual(failure(1, T0_ISO));
    expect(script.seen).toHaveLength(1);
    expect(warnPayload(logger)).toEqual([
      {
        level: "warn",
        event: "profile.probe_failed",
        context: { driverId: "codex-app-server", code: "AUTH_REQUIRED" },
      },
    ]);

    time.clock.ms = T0 + 2_000;
    expect(await profileProbe.readiness(profile, "gpt-5.6-sol")).toEqual(
      failure(10_000, time.iso()),
    );
    time.clock.ms = T0 + 11_999;
    expect(await profileProbe.readiness(profile, "gpt-5.6-sol")).toEqual(
      failure(1, time.iso(T0 + 2_000)),
    );
    expect(script.seen).toHaveLength(2);

    time.clock.ms = T0 + 12_000;
    expect(await profileProbe.readiness(profile, "gpt-5.6-sol")).toEqual(
      failure(30_000, time.iso()),
    );
    time.clock.ms = T0 + 41_999;
    expect(await profileProbe.readiness(profile, "gpt-5.6-sol")).toEqual(
      failure(1, time.iso(T0 + 12_000)),
    );
    expect(script.seen).toHaveLength(3);

    time.clock.ms = T0 + 42_000;
    expect(await profileProbe.readiness(profile, "gpt-5.6-sol")).toEqual(
      failure(30_000, time.iso()),
    );
    expect(script.seen).toHaveLength(4);
    expect(warnPayload(logger)).toHaveLength(4);

    time.clock.ms = T0 + 42_000 + 100;
    const refreshed = await profileProbe.readiness(profile, "gpt-5.6-sol", { refresh: true });
    expect(refreshed.retryAfterMs).toBe(30_000);
    expect(refreshed.cachedAt).toBe(time.iso());
    expect(script.seen).toHaveLength(5);
  });

  it("resets the backoff after a success and stamps a slow handshake at settle time", async () => {
    const time = clockAt(T0);
    let fail = true;
    const script = scriptOf(async () => {
      time.clock.ms += fail ? 5_000 : 20_000;
      if (fail) return Promise.reject(authError());
      return CODEX_PREWARM;
    });
    const { profileProbe } = probeWith({ scripts: { "codex-app-server": script }, now: time.now });
    const profile = codexProfile(stable("codex-app-server").installationId);
    const failed = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(failed.cachedAt).toBe(time.iso(T0 + 5_000));
    expect(failed.retryAfterMs).toBe(2_000);
    time.clock.ms = T0 + 5_000 + 1_000;
    const cached = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(cached.retryAfterMs).toBe(1_000);
    expect(cached.cachedAt).toBe(time.iso(T0 + 5_000));
    expect(script.seen).toHaveLength(1);

    time.clock.ms = T0 + 7_000;
    fail = false;
    const ready = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(ready.cachedAt).toBe(time.iso(T0 + 7_000 + 20_000));
    expect(ready.retryAfterMs).toBeUndefined();
    expect(ready.readiness).toEqual({ state: "ready", detail: null });
    time.clock.ms = T0 + 27_000 + 1_000;
    const hit = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(hit.cachedAt).toBe(ready.cachedAt);
    expect(script.seen).toHaveLength(2);

    time.clock.ms = T0 + 27_000 + 60_000;
    fail = true;
    const again = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(again.retryAfterMs).toBe(2_000);
    expect(script.seen).toHaveLength(3);
  });

  it("drops one installation from the cache and discards an in-flight handshake superseded by invalidation", async () => {
    const time = clockAt(T0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const codexScript = scriptOf(async () => {
      markEntered();
      await gate;
      return CODEX_PREWARM;
    });
    const kimiScript = scriptOf(async () => ({
      canonicalModelId: "kimi-code/k3",
      modelAliases: [],
      capability: { protocol: "kimi-stream-json" },
      catalog: ["kimi-code/k3"],
    }));
    const { profileProbe } = probeWith({
      scripts: { "codex-app-server": codexScript, "kimi-stream-json": kimiScript },
      now: time.now,
    });
    const kimi = emptyProfile("kimi-stream-json", stable("kimi-stream-json").installationId);
    const kimiReady = await profileProbe.readiness(kimi, "kimi-code/k3");
    expect(kimiScript.seen).toHaveLength(1);

    const codex = codexProfile(stable("codex-app-server").installationId);
    const inflight = profileProbe.readiness(codex, "gpt-5.6-sol");
    await entered;
    profileProbe.invalidateInstallation(codex.installationId);
    release();
    const settled = await inflight;
    expect(settled.readiness).toEqual({ state: "ready", detail: null });
    expect(settled.cachedAt).toBe(T0_ISO);
    expect(codexScript.seen).toHaveLength(1);
    expect(codexScript.closes).toBe(1);

    const again = await profileProbe.readiness(codex, "gpt-5.6-sol");
    expect(again.readiness).toEqual({ state: "ready", detail: null });
    expect(codexScript.seen).toHaveLength(2);
    const cached = await profileProbe.readiness(codex, "gpt-5.6-sol");
    expect(cached).toEqual(again);
    expect(codexScript.seen).toHaveLength(2);

    const kimiHit = await profileProbe.readiness(kimi, "kimi-code/k3");
    expect(kimiHit).toEqual(kimiReady);
    expect(kimiScript.seen).toHaveLength(1);
  });

  it("invalidateInstallation drops a settled readiness entry and leaves other installations cached", async () => {
    const time = clockAt(T0);
    const codexScript = scriptOf(async () => CODEX_PREWARM);
    const kimiScript = scriptOf(async () => ({
      canonicalModelId: "kimi-code/k3",
      modelAliases: [],
      capability: { protocol: "kimi-stream-json" },
      catalog: ["kimi-code/k3"],
    }));
    const { profileProbe } = probeWith({
      scripts: { "codex-app-server": codexScript, "kimi-stream-json": kimiScript },
      now: time.now,
    });
    const codex = codexProfile(stable("codex-app-server").installationId);
    const kimi = emptyProfile("kimi-stream-json", stable("kimi-stream-json").installationId);
    const codexReady = await profileProbe.readiness(codex, "gpt-5.6-sol");
    const kimiReady = await profileProbe.readiness(kimi, "kimi-code/k3");
    await profileProbe.catalog("codex-app-server", codex.installationId);
    await profileProbe.catalog("kimi-stream-json", kimi.installationId);
    expect(codexScript.seen).toHaveLength(2);
    expect(kimiScript.seen).toHaveLength(2);

    profileProbe.invalidateInstallation(codex.installationId);
    profileProbe.invalidateInstallation("codex-not-cached");

    const codexAgain = await profileProbe.readiness(codex, "gpt-5.6-sol");
    expect(codexAgain).toEqual(codexReady);
    expect(await profileProbe.catalog("codex-app-server", codex.installationId)).toEqual({
      catalog: ["gpt-5.6-sol", "gpt-5.6"],
      cachedAt: T0_ISO,
    });
    expect(codexScript.seen).toHaveLength(4);

    expect(await profileProbe.readiness(kimi, "kimi-code/k3")).toEqual(kimiReady);
    expect(await profileProbe.catalog("kimi-stream-json", kimi.installationId)).toEqual({
      catalog: ["kimi-code/k3"],
      cachedAt: T0_ISO,
    });
    expect(kimiScript.seen).toHaveLength(2);
  });

  it("clearCache drops a cached failure so the next call handshakes immediately", async () => {
    const time = clockAt(T0);
    const script = scriptOf(() => Promise.reject(authError()));
    const { profileProbe } = probeWith({ scripts: { "codex-app-server": script }, now: time.now });
    const profile = codexProfile(stable("codex-app-server").installationId);
    await profileProbe.readiness(profile, "gpt-5.6-sol");
    time.clock.ms = T0 + 500;
    await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(script.seen).toHaveLength(1);
    profileProbe.clearCache();
    const again = await profileProbe.readiness(profile, "gpt-5.6-sol");
    expect(again.retryAfterMs).toBe(2_000);
    expect(again.cachedAt).toBe(time.iso());
    expect(script.seen).toHaveLength(2);
  });

  it("still returns the readiness result when closing the probe driver rejects", async () => {
    const time = clockAt(T0);
    const readyScript = scriptOf(async () => CODEX_PREWARM);
    readyScript.closeError = new Error("close failed");
    const readyProbe = probeWith({ scripts: { "codex-app-server": readyScript }, now: time.now });
    const id = stable("codex-app-server").installationId;
    const ready = await readyProbe.profileProbe.readiness(codexProfile(id), "gpt-5.6-sol");
    expect(ready.readiness).toEqual({ state: "ready", detail: null });
    expect(readyScript.closes).toBe(1);

    const failScript = scriptOf(() => Promise.reject(authError("handshake down")));
    failScript.closeError = new Error("close failed");
    const failProbe = probeWith({ scripts: { "codex-app-server": failScript }, now: time.now });
    const failed = await failProbe.profileProbe.readiness(codexProfile(id), "gpt-5.6-sol");
    expect(failed.readiness).toEqual({ state: "runtime_unavailable", detail: "handshake down" });
    expect(failScript.closes).toBe(1);
  });
});

describe("profile probe catalog", () => {
  it("returns the codex prewarm catalog for the placeholder model and caches it for 60s", async () => {
    const time = clockAt(T0);
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe, logger } = probeWith({
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    const dto = stable("codex-app-server");
    const record = stableInstallations().assertExecutable(dto.installationId);
    const result = await profileProbe.catalog("codex-app-server", dto.installationId);
    expect(result).toEqual({ catalog: ["gpt-5.6-sol", "gpt-5.6"], cachedAt: T0_ISO });
    const call = script.seen[0];
    if (!call) throw new Error("missing catalog prewarm");
    expect(call.participantId).toMatch(PROBE_ID);
    expect(call.input.spec).toEqual({
      participantId: call.participantId,
      profile: codexProfile(dto.installationId),
      modelId: "__catalog__",
    });
    expect(call.input.installation).toEqual(record);
    expect(script.closes).toBe(1);
    expect(warnPayload(logger)).toEqual([]);

    time.clock.ms = T0 + 59_999;
    expect(await profileProbe.catalog("codex-app-server", dto.installationId)).toEqual(result);
    expect(script.seen).toHaveLength(1);
    time.clock.ms = T0 + 60_000;
    const expired = await profileProbe.catalog("codex-app-server", dto.installationId);
    expect(expired).toEqual({ catalog: ["gpt-5.6-sol", "gpt-5.6"], cachedAt: time.iso() });
    expect(script.seen).toHaveLength(2);
    time.clock.ms = T0 + 60_000 + 1;
    const refreshed = await profileProbe.catalog(
      "codex-app-server",
      dto.installationId,
      undefined,
      {
        refresh: true,
      },
    );
    expect(refreshed.cachedAt).toBe(time.iso());
    expect(script.seen).toHaveLength(3);
  });

  it("keys claude catalogs by route and defaults a missing route to ant-glm5.2", async () => {
    const time = clockAt(T0);
    const script = scriptOf(async (input) => ({
      canonicalModelId: "GLM-5.2[1m]",
      modelAliases: [],
      capability: { protocol: "claude-stream-json" },
      catalog: [
        input.spec.profile.driverId === "claude-stream-json"
          ? input.spec.profile.options.route
          : "",
      ],
    }));
    const { profileProbe } = probeWith({
      scripts: { "claude-stream-json": script },
      now: time.now,
    });
    const id = stable("claude-stream-json").installationId;
    const first = await profileProbe.catalog("claude-stream-json", id);
    expect(first.catalog).toEqual(["ant-glm5.2"]);
    const same = await profileProbe.catalog("claude-stream-json", id, "ant-glm5.2");
    expect(same).toEqual(first);
    expect(script.seen).toHaveLength(1);
    expect(script.seen[0]?.input.spec.profile).toEqual(claudeProfile(id, "ant-glm5.2"));
    expect(script.seen[0]?.input.spec.modelId).toBe("__catalog__");

    for (const route of ["moonshot", "deepseek", "cfuse"] as const) {
      const result = await profileProbe.catalog("claude-stream-json", id, route);
      expect(result.catalog).toEqual([route]);
    }
    expect(script.seen.map((call) => call.input.spec.profile)).toEqual([
      claudeProfile(id, "ant-glm5.2"),
      claudeProfile(id, "moonshot"),
      claudeProfile(id, "deepseek"),
      claudeProfile(id, "cfuse"),
    ]);
    await profileProbe.catalog("claude-stream-json", id, "moonshot");
    expect(script.seen).toHaveLength(4);
  });

  it("uses empty options for kimi, grok, and cursor and ignores a route argument", async () => {
    const time = clockAt(T0);
    const kimi = scriptOf(async () => ({
      canonicalModelId: "kimi-code/k3",
      modelAliases: [],
      capability: { protocol: "kimi-stream-json" },
      catalog: ["kimi-code/k3"],
    }));
    const grok = scriptOf(async () => ({
      canonicalModelId: "grok-4",
      modelAliases: [],
      capability: { protocol: "grok-stream-json" },
      catalog: ["grok-4", "grok-4-mini"],
    }));
    const cursor = scriptOf(async () => ({
      canonicalModelId: "auto",
      modelAliases: [],
      capability: { protocol: "cursor-stream-json" },
      catalog: [],
    }));
    const { profileProbe } = probeWith({
      scripts: {
        "kimi-stream-json": kimi,
        "grok-stream-json": grok,
        "cursor-stream-json": cursor,
      },
      now: time.now,
    });
    const kimiId = stable("kimi-stream-json").installationId;
    expect(await profileProbe.catalog("kimi-stream-json", kimiId)).toEqual({
      catalog: ["kimi-code/k3"],
      cachedAt: T0_ISO,
    });
    expect(await profileProbe.catalog("kimi-stream-json", kimiId, "cfuse")).toEqual({
      catalog: ["kimi-code/k3"],
      cachedAt: T0_ISO,
    });
    expect(kimi.seen).toHaveLength(1);
    expect(kimi.seen[0]?.input.spec.profile).toEqual(emptyProfile("kimi-stream-json", kimiId));
    expect(kimi.seen[0]?.input.spec.modelId).toBe("__catalog__");

    expect(
      await profileProbe.catalog("grok-stream-json", stable("grok-stream-json").installationId),
    ).toEqual({
      catalog: ["grok-4", "grok-4-mini"],
      cachedAt: T0_ISO,
    });
    expect(grok.seen[0]?.input.spec.profile).toEqual(
      emptyProfile("grok-stream-json", stable("grok-stream-json").installationId),
    );
    expect(
      await profileProbe.catalog("cursor-stream-json", stable("cursor-stream-json").installationId),
    ).toEqual({ catalog: [], cachedAt: T0_ISO });
    expect(cursor.seen[0]?.input.spec.profile).toEqual(
      emptyProfile("cursor-stream-json", stable("cursor-stream-json").installationId),
    );
    expect(cursor.closes).toBe(1);
  });

  it("returns a served catalog from MODEL_UNAVAILABLE and caches that success", async () => {
    const time = clockAt(T0);
    const error = Object.assign(new Error("placeholder rejected"), {
      runtimeCode: "MODEL_UNAVAILABLE",
      catalog: ["gpt-5.6-sol", "gpt-5.6-mini"],
    });
    const script = scriptOf(() => Promise.reject(error));
    const { profileProbe, logger } = probeWith({
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    const id = stable("codex-app-server").installationId;
    const result = await profileProbe.catalog("codex-app-server", id);
    expect(result).toEqual({ catalog: ["gpt-5.6-sol", "gpt-5.6-mini"], cachedAt: T0_ISO });
    expect(await profileProbe.catalog("codex-app-server", id)).toEqual(result);
    expect(script.seen).toHaveLength(1);
    expect(script.closes).toBe(1);
    expect(warnPayload(logger)).toEqual([]);
  });

  it("rethrows MODEL_UNAVAILABLE when the served catalog is missing or empty", async () => {
    const time = clockAt(T0);
    const empty = Object.assign(new Error("empty catalog"), {
      runtimeCode: "MODEL_UNAVAILABLE",
      catalog: [],
    });
    const missing = Object.assign(new Error("no catalog"), { runtimeCode: "MODEL_UNAVAILABLE" });
    const text = Object.assign(new Error("catalog string"), {
      runtimeCode: "MODEL_UNAVAILABLE",
      catalog: "gpt-5.6-sol",
    });
    const emptyScript = scriptOf(() => Promise.reject(empty));
    const missingScript = scriptOf(() => Promise.reject(missing));
    const textScript = scriptOf(() => Promise.reject(text));
    const id = stable("codex-app-server").installationId;
    const emptyProbe = probeWith({ scripts: { "codex-app-server": emptyScript }, now: time.now });
    const missingProbe = probeWith({
      scripts: { "codex-app-server": missingScript },
      now: time.now,
    });
    const textProbe = probeWith({ scripts: { "codex-app-server": textScript }, now: time.now });
    await expect(emptyProbe.profileProbe.catalog("codex-app-server", id)).rejects.toBe(empty);
    await expect(missingProbe.profileProbe.catalog("codex-app-server", id)).rejects.toBe(missing);
    await expect(textProbe.profileProbe.catalog("codex-app-server", id)).rejects.toBe(text);
    expect(emptyScript.closes).toBe(1);
    expect(missingScript.closes).toBe(1);
    expect(textScript.closes).toBe(1);
  });

  it("rethrows catalog failures for 2s, 10s, then a capped 30s, including refresh", async () => {
    const time = clockAt(T0);
    const boom = Object.assign(new Error("socket closed"), { runtimeCode: "DRIVER_CRASHED" });
    const script = scriptOf(() => Promise.reject(boom));
    const { profileProbe } = probeWith({ scripts: { "codex-app-server": script }, now: time.now });
    const id = stable("codex-app-server").installationId;
    const attempt = () =>
      profileProbe.catalog("codex-app-server", id).then(
        () => {
          throw new Error("catalog should reject");
        },
        (error: unknown) => error,
      );

    expect(await attempt()).toBe(boom);
    time.clock.ms = T0 + 1_999;
    expect(await attempt()).toBe(boom);
    expect(script.seen).toHaveLength(1);
    time.clock.ms = T0 + 2_000;
    expect(await attempt()).toBe(boom);
    time.clock.ms = T0 + 11_999;
    expect(await attempt()).toBe(boom);
    expect(script.seen).toHaveLength(2);
    time.clock.ms = T0 + 12_000;
    expect(await attempt()).toBe(boom);
    time.clock.ms = T0 + 41_999;
    expect(await attempt()).toBe(boom);
    expect(script.seen).toHaveLength(3);
    time.clock.ms = T0 + 42_000;
    expect(await attempt()).toBe(boom);
    expect(script.seen).toHaveLength(4);
    time.clock.ms = T0 + 42_100;
    expect(
      await profileProbe.catalog("codex-app-server", id, undefined, { refresh: true }).then(
        () => null,
        (error: unknown) => error,
      ),
    ).toBe(boom);
    expect(script.seen).toHaveLength(5);
  });

  it("stamps a slow catalog handshake at settle time", async () => {
    const time = clockAt(T0);
    const script = scriptOf(async () => {
      time.clock.ms += 20_000;
      return CODEX_PREWARM;
    });
    const { profileProbe } = probeWith({ scripts: { "codex-app-server": script }, now: time.now });
    const id = stable("codex-app-server").installationId;
    const result = await profileProbe.catalog("codex-app-server", id);
    expect(result).toEqual({
      catalog: ["gpt-5.6-sol", "gpt-5.6"],
      cachedAt: time.iso(T0 + 20_000),
    });
    const hit = await profileProbe.catalog("codex-app-server", id);
    expect(hit).toEqual(result);
    expect(script.seen).toHaveLength(1);
  });

  it("keeps the previous catalog value only as a cache placeholder when a later handshake fails", async () => {
    const time = clockAt(T0);
    let fail = false;
    const boom = new Error("later failure");
    const script = scriptOf(async () => {
      if (fail) throw boom;
      return { ...CODEX_PREWARM, catalog: ["gpt-5.6-sol"] };
    });
    const { profileProbe } = probeWith({ scripts: { "codex-app-server": script }, now: time.now });
    const id = stable("codex-app-server").installationId;
    expect(await profileProbe.catalog("codex-app-server", id)).toEqual({
      catalog: ["gpt-5.6-sol"],
      cachedAt: T0_ISO,
    });
    time.clock.ms = T0 + 60_000;
    fail = true;
    await expect(profileProbe.catalog("codex-app-server", id)).rejects.toBe(boom);
    time.clock.ms = T0 + 60_000 + 1_000;
    await expect(profileProbe.catalog("codex-app-server", id)).rejects.toBe(boom);
    expect(script.seen).toHaveLength(2);
  });

  it("throws installation gate errors and caches them on the catalog backoff", async () => {
    const time = clockAt(T0);
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe } = probeWith({
      scripts: { "codex-app-server": script, "claude-stream-json": script },
      now: time.now,
    });
    const unknown = await profileProbe.catalog("codex-app-server", "codex-000000000000").then(
      () => null,
      (error: unknown) => error,
    );
    expect(unknown).toBeInstanceOf(InstallationError);
    expect((unknown as InstallationError).runtimeError).toEqual({
      code: "INSTALLATION_NOT_FOUND",
      phase: "discovery",
      retryable: false,
      message: "unknown installationId",
    });
    const again = await profileProbe.catalog("codex-app-server", "codex-000000000000").then(
      () => null,
      (error: unknown) => error,
    );
    expect(again).toBe(unknown);

    const mismatch = await profileProbe
      .catalog("claude-stream-json", stable("codex-app-server").installationId, "moonshot")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(mismatch).toBeInstanceOf(InstallationError);
    expect((mismatch as InstallationError).runtimeError).toEqual({
      code: "INSTALLATION_NOT_FOUND",
      phase: "discovery",
      retryable: false,
      message: "profile driver does not match installation",
    });
    expect(script.seen).toHaveLength(0);

    const root = await makePrivate("catalog-discovered-", true);
    await writeExecutable(root, "codex", "#!/bin/sh\nprintf 'codex\\n'\n", 0o777);
    const registry = registryFor(root);
    const dto = byDriver(registry, "codex-app-server");
    expect(dto.state).toBe("discovered");
    const discoveredProbe = probeWith({
      registry,
      scripts: { "codex-app-server": scriptOf(async () => CODEX_PREWARM) },
      now: time.now,
    });
    const untrusted = await discoveredProbe.profileProbe
      .catalog("codex-app-server", dto.installationId)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(untrusted).toBeInstanceOf(InstallationError);
    expect((untrusted as InstallationError).runtimeError).toEqual({
      code: "INSTALLATION_UNTRUSTED",
      phase: "discovery",
      retryable: false,
      message: "installation is discovered; revalidation required",
    });
  });

  it("throws INSTALLATION_CHANGED when the pinned binary drifts during the catalog gate", async () => {
    const time = clockAt(T0);
    const root = await makePrivate("catalog-drift-", true);
    const path = await writeExecutable(root, "codex", "#!/bin/sh\nprintf 'v1\\n'\n");
    const registry = registryFor(root);
    const dto = byDriver(registry, "codex-app-server");
    const script = scriptOf(async () => CODEX_PREWARM);
    const { profileProbe } = probeWith({
      registry,
      scripts: { "codex-app-server": script },
      now: time.now,
    });
    await writeFile(path, "#!/bin/sh\nprintf 'v2\\n'\n");
    await chmod(path, 0o755);
    const error = await profileProbe.catalog("codex-app-server", dto.installationId).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InstallationError);
    expect((error as InstallationError).runtimeError).toEqual({
      code: "INSTALLATION_CHANGED",
      phase: "discovery",
      retryable: false,
      message: `Installation "${dto.installationId}" no longer matches its pinned fingerprint.`,
    });
    expect(script.seen).toHaveLength(0);
    expect(script.closes).toBe(0);
  });

  it("invalidates one installation's catalog and drops an in-flight success or failure", async () => {
    const time = clockAt(T0);
    const kimi = scriptOf(async () => ({
      canonicalModelId: "kimi-code/k3",
      modelAliases: [],
      capability: { protocol: "kimi" },
      catalog: ["kimi-code/k3"],
    }));
    let releaseSuccess: () => void = () => undefined;
    const successGate = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    let successEntered: () => void = () => undefined;
    const successStarted = new Promise<void>((resolve) => {
      successEntered = resolve;
    });
    const codex = scriptOf(async () => {
      successEntered();
      await successGate;
      return CODEX_PREWARM;
    });
    const { profileProbe } = probeWith({
      scripts: { "codex-app-server": codex, "kimi-stream-json": kimi },
      now: time.now,
    });
    const codexId = stable("codex-app-server").installationId;
    const kimiId = stable("kimi-stream-json").installationId;
    const kimiCatalog = await profileProbe.catalog("kimi-stream-json", kimiId);
    const inflight = profileProbe.catalog("codex-app-server", codexId);
    await successStarted;
    profileProbe.invalidateInstallation(codexId);
    releaseSuccess();
    expect(await inflight).toEqual({ catalog: ["gpt-5.6-sol", "gpt-5.6"], cachedAt: T0_ISO });
    expect(await profileProbe.catalog("kimi-stream-json", kimiId)).toEqual(kimiCatalog);
    expect(kimi.seen).toHaveLength(1);
    await profileProbe.catalog("codex-app-server", codexId);
    expect(codex.seen).toHaveLength(2);

    let releaseFailure: (error: Error) => void = () => undefined;
    const failureGate = new Promise<PrewarmResult>((_resolve, reject) => {
      releaseFailure = reject;
    });
    let failureEntered: () => void = () => undefined;
    const failureStarted = new Promise<void>((resolve) => {
      failureEntered = resolve;
    });
    const boom = new Error("hung catalog");
    const failing = scriptOf(async () => {
      failureEntered();
      return failureGate;
    });
    const failingProbe = probeWith({
      scripts: { "grok-stream-json": failing },
      now: time.now,
    });
    const grokId = stable("grok-stream-json").installationId;
    const failingCall = failingProbe.profileProbe.catalog("grok-stream-json", grokId).then(
      () => null,
      (error: unknown) => error,
    );
    await failureStarted;
    failingProbe.profileProbe.invalidateInstallation(grokId);
    releaseFailure(boom);
    expect(await failingCall).toBe(boom);
    const next = await failingProbe.profileProbe.catalog("grok-stream-json", grokId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(next).toBeInstanceOf(Error);
    expect((next as Error).message).toBe("hung catalog");
    expect(failing.seen).toHaveLength(2);
  });

  it("propagates the prewarm error when close also rejects", async () => {
    const time = clockAt(T0);
    const boom = new Error("handshake down");
    const script = scriptOf(() => Promise.reject(boom));
    script.closeError = new Error("close failed");
    const { profileProbe } = probeWith({ scripts: { "codex-app-server": script }, now: time.now });
    const caught = await profileProbe
      .catalog("codex-app-server", stable("codex-app-server").installationId)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(caught).toBe(boom);
    expect(script.closes).toBe(1);

    const ok = scriptOf(async () => CODEX_PREWARM);
    ok.closeError = new Error("close failed");
    const okProbe = probeWith({ scripts: { "codex-app-server": ok }, now: time.now });
    expect(
      await okProbe.profileProbe.catalog(
        "codex-app-server",
        stable("codex-app-server").installationId,
      ),
    ).toEqual({
      catalog: ["gpt-5.6-sol", "gpt-5.6"],
      cachedAt: T0_ISO,
    });
    expect(ok.closes).toBe(1);
  });
});
