import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Unit tests for driver preflight probe cache + lightweight connectivity.
 * No real LLM subprocesses — spawn/LLM path is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GROK_ISOLATED_HOME_DIR,
  ISOLATED_GROK_CONFIG,
  disposeIsolatedGrokHome,
  ensureWarmGrokHome,
  resetWarmGrokHomeForTests,
  spawnEnvForDriver,
} from "../src/auto/driver-commands";
import {
  DEFAULT_PROBE_CACHE_TTL_MS,
  clearProbeCache,
  getProbeCacheEntryForTests,
  lightweightConnectivityCheck,
  localProxyConfigBroken,
  probeCacheKey,
  probeCacheTtlMs,
  runDriverProbe,
} from "../src/auto/driver-probe";
import type { AgentRecord } from "../src/store/schemas";

function agent(driverSelection: AgentRecord["driverSelection"], modelId = "model-x"): AgentRecord {
  return {
    id: "a-1",
    name: "A",
    personaPrompt: "persona",
    modelId,
    color: "#aabbcc",
    enabled: true,
    driverSelection,
  };
}

const GROK = { driverId: "grok-stream-json" as const, options: {} };
const KIMI = { driverId: "kimi-stream-json" as const, options: {} };
const CLAUDE = {
  driverId: "claude-stream-json" as const,
  options: { route: "cfuse" as const },
};

describe("driver-probe cache + lightweight", () => {
  let tmp: string;
  let clock: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ck-probe-"));
    for (const name of ["cld", "kimi", "codex", "grok", "cursor-agent"]) {
      const p = join(tmp, name);
      writeFileSync(p, "#!/bin/sh\necho hi\n");
      chmodSync(p, 0o755);
    }
    clearProbeCache();
    resetWarmGrokHomeForTests();
    clock = 1_000_000;
  });

  afterEach(() => {
    clearProbeCache();
    resetWarmGrokHomeForTests();
    rmSync(tmp, { recursive: true, force: true });
  });

  const env = (): NodeJS.ProcessEnv => ({ PATH: tmp });
  const now = () => clock;

  it("probeCacheTtlMs defaults to 90s and accepts explicit overrides", () => {
    expect(probeCacheTtlMs({})).toBe(DEFAULT_PROBE_CACHE_TTL_MS);
    expect(probeCacheTtlMs({ COUNCILKIT_PROBE_CACHE_TTL_MS: "75000" })).toBe(75_000);
    expect(probeCacheTtlMs({ COUNCILKIT_PROBE_CACHE_TTL_MS: "nope" })).toBe(
      DEFAULT_PROBE_CACHE_TTL_MS,
    );
  });

  it("cache hit reuses last SUCCESS within TTL without calling LLM", async () => {
    let llmCalls = 0;
    const a = agent(GROK, "grok-4.6");
    const first = await runDriverProbe({
      agent: a,
      probeId: "p1",
      cwd: tmp,
      env: env(),
      now,
      ttlMs: 90_000,
      lightweightDeps: {
        platform: "linux",
        detectLocalProxyPort: () => null,
        findExecutable: (name, e) => join((e?.PATH as string | undefined) ?? tmp, name),
      },
      runLlmProbe: async () => {
        llmCalls += 1;
        return {
          attemptId: "p1",
          agentId: a.id,
          agentName: a.name,
          driverId: a.driverSelection.driverId,
          modelId: a.modelId,
          status: "success",
          output: "ok",
          exitCode: 0,
          durationMs: 12_000,
          workspace: tmp,
        };
      },
    });
    // Linux + CLI present → lightweight success (no LLM).
    expect(first.path).toBe("lightweight");
    expect(first.status).toBe("success");
    expect(llmCalls).toBe(0);

    clock += 1_000;
    const second = await runDriverProbe({
      agent: a,
      probeId: "p2",
      cwd: tmp,
      env: env(),
      now,
      ttlMs: 90_000,
      lightweightDeps: {
        platform: "linux",
        detectLocalProxyPort: () => null,
        findExecutable: (name, e) => join((e?.PATH as string | undefined) ?? tmp, name),
      },
      runLlmProbe: async () => {
        llmCalls += 1;
        throw new Error("LLM must not run on cache hit");
      },
    });
    expect(second.path).toBe("cache");
    expect(second.status).toBe("success");
    expect(llmCalls).toBe(0);
    expect(getProbeCacheEntryForTests(probeCacheKey(a))?.record.status).toBe("success");
  });

  it("cache expiry forces a fresh path after TTL", async () => {
    const a = agent(KIMI, "kimi-code/k3");
    let llmCalls = 0;
    await runDriverProbe({
      agent: a,
      probeId: "p1",
      cwd: tmp,
      env: env(),
      now,
      ttlMs: 60_000,
      lightweightDeps: {
        findExecutable: (name, e) => join((e?.PATH as string | undefined) ?? tmp, name),
      },
      runLlmProbe: async () => {
        llmCalls += 1;
        return {
          attemptId: "p1",
          agentId: a.id,
          agentName: a.name,
          driverId: a.driverSelection.driverId,
          modelId: a.modelId,
          status: "success",
          output: "ok",
          exitCode: 0,
          durationMs: 100,
          workspace: tmp,
        };
      },
    });
    expect(llmCalls).toBe(0);

    clock += 60_001;
    // Force LLM after expiry by marking lightweight suspicious via broken proxy
    // is N/A for kimi; instead disable lightweight so expiry → LLM.
    const expired = await runDriverProbe({
      agent: a,
      probeId: "p2",
      cwd: tmp,
      env: env(),
      now,
      ttlMs: 60_000,
      disableLightweight: true,
      lightweightDeps: {
        findExecutable: (name, e) => join((e?.PATH as string | undefined) ?? tmp, name),
      },
      runLlmProbe: async () => {
        llmCalls += 1;
        return {
          attemptId: "p2",
          agentId: a.id,
          agentName: a.name,
          driverId: a.driverSelection.driverId,
          modelId: a.modelId,
          status: "success",
          output: "ok",
          exitCode: 0,
          durationMs: 200,
          workspace: tmp,
        };
      },
    });
    expect(expired.path).toBe("llm");
    expect(llmCalls).toBe(1);
  });

  it("lightweight path succeeds without LLM when CLI is present (linux)", async () => {
    const a = agent(CLAUDE);
    let llmCalls = 0;
    const out = await runDriverProbe({
      agent: a,
      probeId: "p1",
      cwd: tmp,
      env: env(),
      now,
      lightweightDeps: {
        platform: "linux",
        findExecutable: (name, e) => join((e?.PATH as string | undefined) ?? tmp, name),
      },
      runLlmProbe: async () => {
        llmCalls += 1;
        throw new Error("should not LLM");
      },
    });
    expect(out.path).toBe("lightweight");
    expect(out.status).toBe("success");
    expect(llmCalls).toBe(0);
  });

  it("lightweight hard-fail (missing CLI) does not cache and does not call LLM", async () => {
    const a = agent(GROK);
    let llmCalls = 0;
    const out = await runDriverProbe({
      agent: a,
      probeId: "p1",
      cwd: tmp,
      env: { PATH: join(tmp, "empty") },
      now,
      lightweightDeps: {
        platform: "linux",
        findExecutable: () => null,
      },
      runLlmProbe: async () => {
        llmCalls += 1;
        throw new Error("should not LLM");
      },
    });
    expect(out.status).toBe("failure");
    expect(out.path).toBe("lightweight");
    expect(out.failure?.code).toBe("DRIVER_UNREACHABLE");
    expect(llmCalls).toBe(0);
    expect(getProbeCacheEntryForTests(probeCacheKey(a))).toBeUndefined();
  });

  it("failures from LLM are not cached", async () => {
    const a = agent(GROK);
    await runDriverProbe({
      agent: a,
      probeId: "p1",
      cwd: tmp,
      env: env(),
      now,
      forceLlm: true,
      lightweightDeps: {
        platform: "linux",
        findExecutable: (name, e) => join((e?.PATH as string | undefined) ?? tmp, name),
      },
      runLlmProbe: async () => ({
        attemptId: "p1",
        agentId: a.id,
        agentName: a.name,
        driverId: a.driverSelection.driverId,
        modelId: a.modelId,
        status: "failure",
        output: "",
        exitCode: 1,
        durationMs: 50,
        workspace: tmp,
        failure: { code: "EXIT", message: "boom", retryable: true },
      }),
    });
    expect(getProbeCacheEntryForTests(probeCacheKey(a))).toBeUndefined();
  });

  it("darwin grok without proxy/Clash is suspicious and escalates to LLM", async () => {
    const a = agent(GROK);
    let llmCalls = 0;
    const out = await runDriverProbe({
      agent: a,
      probeId: "p1",
      cwd: tmp,
      env: env(), // no proxy
      now,
      lightweightDeps: {
        platform: "darwin",
        detectLocalProxyPort: () => null,
        findExecutable: (name, e) => join((e?.PATH as string | undefined) ?? tmp, name),
      },
      runLlmProbe: async () => {
        llmCalls += 1;
        return {
          attemptId: "p1",
          agentId: a.id,
          agentName: a.name,
          driverId: a.driverSelection.driverId,
          modelId: a.modelId,
          status: "success",
          output: "ok",
          exitCode: 0,
          durationMs: 9000,
          workspace: tmp,
        };
      },
    });
    expect(out.path).toBe("llm");
    expect(llmCalls).toBe(1);
    expect(out.status).toBe("success");
  });

  it("darwin grok with Clash port listening uses lightweight (no LLM)", async () => {
    const a = agent(GROK);
    let llmCalls = 0;
    const out = await runDriverProbe({
      agent: a,
      probeId: "p1",
      cwd: tmp,
      env: env(),
      now,
      lightweightDeps: {
        platform: "darwin",
        detectLocalProxyPort: () => 7897,
        findExecutable: (name, e) => join((e?.PATH as string | undefined) ?? tmp, name),
      },
      runLlmProbe: async () => {
        llmCalls += 1;
        throw new Error("no LLM");
      },
    });
    expect(out.path).toBe("lightweight");
    expect(llmCalls).toBe(0);
  });

  it("kimi lightweight never requires a proxy and stays unproxied in spawn env", () => {
    const check = lightweightConnectivityCheck(
      agent(KIMI),
      {
        PATH: tmp,
        HTTPS_PROXY: "http://127.0.0.1:7897",
      },
      {
        findExecutable: (name) => join(tmp, name),
        detectLocalProxyPort: () => {
          throw new Error("kimi must not probe for a proxy");
        },
      },
    );
    expect(check.ok).toBe(true);
    expect(check.suspicious).toBe(false);

    const spawnEnv = spawnEnvForDriver(
      "kimi-stream-json",
      "/tmp/kimi-probe",
      {
        PATH: tmp,
        HTTPS_PROXY: "http://127.0.0.1:7897",
        https_proxy: "http://127.0.0.1:7897",
        ALL_PROXY: "socks5://127.0.0.1:7897",
      },
      {
        localProxyPort: () => {
          throw new Error("kimi must not probe for a proxy");
        },
      },
    );
    for (const k of [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      expect(spawnEnv[k]).toBeUndefined();
    }
    expect(spawnEnv.NO_PROXY).toBe("*");
    expect(spawnEnv.no_proxy).toBe("*");
  });

  it("proxy auto-inject for grok/codex still works (#176)", () => {
    const grokEnv = spawnEnvForDriver(
      "grok-stream-json",
      mkdtempSync(join(tmpdir(), "ck-g-")),
      { PATH: tmp },
      { localProxyPort: () => 7897 },
    );
    expect(grokEnv.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(grokEnv.https_proxy).toBe("http://127.0.0.1:7897");

    const codexEnv = spawnEnvForDriver(
      "codex-app-server",
      "/tmp/ck-codex",
      { PATH: tmp },
      { localProxyPort: () => 7897 },
    );
    expect(codexEnv.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    expect(codexEnv.HTTP_PROXY).toBe("http://127.0.0.1:7897");
  });

  it("localProxyConfigBroken detects a dead 127.0.0.1 proxy URL", () => {
    expect(localProxyConfigBroken({ HTTPS_PROXY: "http://127.0.0.1:17997" }, () => null)).toBe(
      true,
    );
    expect(localProxyConfigBroken({ HTTPS_PROXY: "http://127.0.0.1:7897" }, () => 7897)).toBe(
      false,
    );
  });

  it("warm GROK_HOME reuses one credentials-only dir across probe spawns", () => {
    const orig = mkdtempSync(join(tmpdir(), "ck-grok-src-"));
    writeFileSync(join(orig, "auth.json"), '{"token":"warm"}\n', { mode: 0o600 });
    mkdirSync(join(orig, "skills"), { recursive: true });

    const first = ensureWarmGrokHome(orig);
    expect(first).not.toBeNull();
    if (first === null) throw new Error("expected warm home");
    expect(first.includes("warm-home")).toBe(true);
    expect(readFileSync(join(first, "auth.json"), "utf8")).toContain("warm");
    expect(readFileSync(join(first, "config.toml"), "utf8")).toBe(ISOLATED_GROK_CONFIG);
    expect(existsSync(join(first, "skills"))).toBe(false);

    const cwd1 = mkdtempSync(join(tmpdir(), "ck-probe-cwd-"));
    const cwd2 = mkdtempSync(join(tmpdir(), "ck-probe-cwd-"));
    const e1 = spawnEnvForDriver(
      "grok-stream-json",
      cwd1,
      { PATH: tmp, GROK_HOME: orig },
      { localProxyPort: () => null, warmGrokHome: true },
    );
    const e2 = spawnEnvForDriver(
      "grok-stream-json",
      cwd2,
      { PATH: tmp, GROK_HOME: orig },
      { localProxyPort: () => null, warmGrokHome: true },
    );
    expect(e1.GROK_HOME).toBe(first);
    expect(e2.GROK_HOME).toBe(first);
    expect(existsSync(join(cwd1, GROK_ISOLATED_HOME_DIR))).toBe(false);
    disposeIsolatedGrokHome(cwd1);
    expect(existsSync(first)).toBe(true);

    // Non-warm (review attempt) still uses per-cwd isolation.
    const reviewCwd = mkdtempSync(join(tmpdir(), "ck-review-cwd-"));
    const reviewEnv = spawnEnvForDriver(
      "grok-stream-json",
      reviewCwd,
      { PATH: tmp, GROK_HOME: orig },
      { localProxyPort: () => null },
    );
    expect(reviewEnv.GROK_HOME).toBe(join(reviewCwd, GROK_ISOLATED_HOME_DIR));
  });
});
