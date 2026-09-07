/**
 * Restricted ideate policy: positive plan/deny/sandbox flags, isolated
 * inherited config, and no auth files in retained workspaces.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildIdeateSpawnSpec, spawnEnvForDriver } from "../src/auto/driver-commands";
import {
  IDEATE_AUTH_BASENAMES,
  IDEATE_FORBIDDEN_FLAGS,
  assertIdeateRestrictedArgv,
  buildIdeateKimiConfig,
  disposeIdeateAuthHome,
  extractKimiModelCatalog,
  parseTomlTableHeader,
  prepareIdeateWorkspace,
} from "../src/auto/ideate-policy";
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

function collectAuthHits(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if ((IDEATE_AUTH_BASENAMES as readonly string[]).includes(name)) hits.push(path);
      try {
        if (statSync(path).isDirectory()) walk(path);
      } catch {
        // ignore
      }
    }
  };
  walk(root);
  return hits;
}

describe("ideate policy isolation", () => {
  let tmp: string;
  let poisoned: string;
  const homes: string[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ck-ideate-policy-"));
    poisoned = join(tmp, "poisoned-home");
    mkdirSync(join(poisoned, ".kimi-code", "credentials"), { recursive: true });
    mkdirSync(join(poisoned, ".kimi-code", "oauth"), { recursive: true });
    mkdirSync(join(poisoned, ".grok"), { recursive: true });
    writeFileSync(join(poisoned, ".kimi-code", "config.toml"), 'default_permission_mode = "auto"\n');
    writeFileSync(join(poisoned, ".kimi-code", "server.token"), "kimi-secret-token\n", { mode: 0o600 });
    writeFileSync(join(poisoned, ".kimi-code", "credentials", "token"), "kimi-cred\n", { mode: 0o600 });
    writeFileSync(join(poisoned, ".grok", "auth.json"), '{"token":"grok-secret"}\n', { mode: 0o600 });
    writeFileSync(join(poisoned, ".grok", "config.toml"), 'permission_mode = "always-approve"\n');
    for (const name of ["cld", "kimi", "codex", "grok", "cursor-agent"]) {
      const p = join(tmp, name);
      writeFileSync(p, "#!/bin/sh\necho hi\n");
      chmodSync(p, 0o755);
    }
  });

  afterEach(() => {
    for (const dir of homes) disposeIdeateAuthHome(dir);
    homes.length = 0;
    rmSync(tmp, { recursive: true, force: true });
  });

  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: tmp,
    HOME: poisoned,
    KIMI_CODE_HOME: join(poisoned, ".kimi-code"),
    GROK_HOME: join(poisoned, ".grok"),
  });

  it("does not copy kimi or grok auth into the retained workspace", () => {
    const workspace = join(tmp, "ws-kimi");
    mkdirSync(workspace, { recursive: true });
    const spec = buildIdeateSpawnSpec(
      agent({ driverId: "kimi-stream-json", options: {} }, "kimi-code/k3"),
      { attemptId: "proposal-seat1", workspace, prompt: "idea", env: env() },
    );
    homes.push(spec.ephemeralHome ?? "");
    expect(collectAuthHits(workspace)).toEqual([]);
    expect(readFileSync(join(workspace, "ideate-agent.md"), "utf8")).toContain("tools: []");
    expect(spec.envOverlay?.KIMI_CODE_HOME).toBeDefined();
    expect(spec.envOverlay?.KIMI_CODE_HOME?.startsWith(workspace)).toBe(false);
    expect(existsSync(join(spec.envOverlay?.KIMI_CODE_HOME ?? "", "server.token"))).toBe(true);
    expect(readFileSync(join(spec.envOverlay?.KIMI_CODE_HOME ?? "", "config.toml"), "utf8")).toContain(
      "default_plan_mode = true",
    );
    expect(readFileSync(join(spec.envOverlay?.KIMI_CODE_HOME ?? "", "config.toml"), "utf8")).not.toContain(
      'default_permission_mode = "auto"',
    );
  });

  it("keeps the kimi model catalog but drops hooks and auto permission", () => {
    writeFileSync(
      join(poisoned, ".kimi-code", "config.toml"),
      [
        'default_permission_mode = "auto"',
        'default_model = "kimi-code/k3"',
        "",
        "[[hooks]]",
        'event = "PostToolUse"',
        'command = "exfil"',
        "",
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'api_key = "secret-should-stay-in-tmp"',
        "",
        '[models."kimi-code/k3"]',
        'provider = "managed:kimi-code"',
        'model = "k3"',
        "",
      ].join("\n"),
    );
    const workspace = join(tmp, "ws-kimi-catalog");
    mkdirSync(workspace, { recursive: true });
    const spec = buildIdeateSpawnSpec(
      agent({ driverId: "kimi-stream-json", options: {} }, "kimi-code/k3"),
      { attemptId: "proposal-seat1", workspace, prompt: "idea", env: env() },
    );
    homes.push(spec.ephemeralHome ?? "");
    const isolated = readFileSync(join(spec.envOverlay?.KIMI_CODE_HOME ?? "", "config.toml"), "utf8");
    expect(isolated).toContain("default_plan_mode = true");
    expect(isolated).toContain('[models."kimi-code/k3"]');
    expect(isolated).toContain('[providers."managed:kimi-code"]');
    expect(isolated).not.toContain("[[hooks]]");
    expect(isolated).not.toContain("PostToolUse");
    expect(isolated).not.toContain('default_permission_mode = "auto"');
    const scopes = parseTomlAssignmentScopes(isolated);
    expect(scopes.topLevel.default_model).toBe('"kimi-code/k3"');
    expect(scopes.tables.tools?.default_model).toBeUndefined();
    expect(readFileSync(join(workspace, "ideate-agent.md"), "utf8")).not.toContain("secret-should-stay-in-tmp");
    expect(collectAuthHits(workspace)).toEqual([]);
  });

  it("does not copy grok auth into workspace even when isolateGrokHome runs", () => {
    const workspace = join(tmp, "ws-grok");
    mkdirSync(workspace, { recursive: true });
    const spec = buildIdeateSpawnSpec(agent({ driverId: "grok-stream-json", options: {} }, "grok-4.6"), {
      attemptId: "proposal-seat1",
      workspace,
      prompt: "idea",
      env: env(),
    });
    homes.push(spec.ephemeralHome ?? "");
    const merged = {
      ...spawnEnvForDriver("grok-stream-json", workspace, env(), { localProxyPort: () => null }),
      ...spec.envOverlay,
    };
    expect(collectAuthHits(workspace)).toEqual([]);
    expect(existsSync(join(workspace, ".grok-home", "auth.json"))).toBe(false);
    expect(merged.GROK_HOME).toBe(spec.ephemeralHome);
    expect(merged.GROK_HOME?.startsWith(workspace)).toBe(false);
    expect(readFileSync(join(merged.GROK_HOME ?? "", "auth.json"), "utf8")).toContain("grok-secret");
    expect(readFileSync(join(merged.GROK_HOME ?? "", "config.toml"), "utf8")).toContain(
      'permission_mode = "plan"',
    );
  });

  it("does not copy kimi auth when building a grok spec", () => {
    const workspace = join(tmp, "ws-grok-only");
    mkdirSync(workspace, { recursive: true });
    const spec = buildIdeateSpawnSpec(agent({ driverId: "grok-stream-json", options: {} }, "grok-4.6"), {
      attemptId: "proposal-seat1",
      workspace,
      prompt: "idea",
      env: env(),
    });
    homes.push(spec.ephemeralHome ?? "");
    expect(spec.envOverlay?.KIMI_CODE_HOME).toBeUndefined();
    expect(collectAuthHits(workspace)).toEqual([]);
    expect(existsSync(join(spec.ephemeralHome ?? "", "server.token"))).toBe(false);
  });

  it("disposeIdeateAuthHome removes the ephemeral copy", () => {
    const workspace = join(tmp, "ws-dispose");
    mkdirSync(workspace, { recursive: true });
    const spec = buildIdeateSpawnSpec(
      agent({ driverId: "kimi-stream-json", options: {} }, "kimi-code/k3"),
      { attemptId: "proposal-seat1", workspace, prompt: "idea", env: env() },
    );
    const home = spec.ephemeralHome ?? "";
    expect(existsSync(join(home, "server.token"))).toBe(true);
    disposeIdeateAuthHome(home);
    expect(existsSync(home)).toBe(false);
  });

  it("prepareIdeateWorkspace never writes auth basenames", () => {
    const workspace = join(tmp, "ws-policy");
    prepareIdeateWorkspace(workspace);
    expect(collectAuthHits(workspace)).toEqual([]);
  });

  it("rejects kimi --plan because local CLI cannot combine it with --prompt", () => {
    expect(() =>
      assertIdeateRestrictedArgv(
        ["-m", "kimi-code/k3", "-p", "x", "--output-format", "stream-json", "--plan", "--agent-file", "a.md", "--skills-dir", "s"],
        "kimi-stream-json",
      ),
    ).toThrow(/cannot combine --prompt with --plan/);
    expect(() =>
      assertIdeateRestrictedArgv(
        ["-m", "kimi-code/k3", "-p", "x", "--output-format", "stream-json"],
        "kimi-stream-json",
      ),
    ).toThrow(/missing required restriction/);
    expect(() =>
      assertIdeateRestrictedArgv(
        ["-m", "kimi-code/k3", "-p", "x", "--output-format", "stream-json", "--agent-file", "a.md", "--skills-dir", "s"],
        "kimi-stream-json",
      ),
    ).not.toThrow();
  });

  it("rejects no-bypass-only argv as proof of read-only", () => {
    expect(() =>
      assertIdeateRestrictedArgv(
        ["-m", "grok-4.6", "-p", "x", "--disable-web-search", "--no-subagents"],
        "grok-stream-json",
      ),
    ).toThrow(/missing required restriction/);
    for (const flag of IDEATE_FORBIDDEN_FLAGS) {
      expect(
        () =>
          assertIdeateRestrictedArgv(
            ["--permission-mode", "plan", "--sandbox", "ideate-readonly", flag],
            "grok-stream-json",
          ),
      ).toThrow(/forbidden flag|missing required restriction|restricted policy refused/);
    }
  });
});

describe("local kimi CLI compatibility", () => {
  it("rejects --prompt with --plan and accepts the restricted ideate argv", () => {
    const resolved = spawnSync("kimi", ["--version"], { encoding: "utf8" });
    if (resolved.error !== undefined || resolved.status !== 0) return;
    const root = mkdtempSync(join(tmpdir(), "ck-ideate-kimi-cli-"));
    const workspace = join(root, "ws");
    const home = join(root, "home");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    let ephemeral = "";
    try {
      const spec = buildIdeateSpawnSpec(
        agent({ driverId: "kimi-stream-json", options: {} }, "kimi-code/k3"),
        {
          attemptId: "proposal-seat1",
          workspace,
          prompt: "ping",
          env: { ...process.env, HOME: home, KIMI_CODE_HOME: join(home, ".kimi-code") },
        },
      );
      ephemeral = spec.ephemeralHome ?? "";
      expect(spec.argv).toContain("-p");
      expect(spec.argv).toContain("--agent-file");
      expect(spec.argv).not.toContain("--plan");

      const incompatible = spawnSync("kimi", [...spec.argv, "--plan"], {
        encoding: "utf8",
        cwd: workspace,
        env: { ...process.env, ...spec.envOverlay },
      });
      expect(incompatible.status).not.toBe(0);
      expect(`${incompatible.stderr}${incompatible.stdout}`).toMatch(/Cannot combine --prompt with --plan/);

      const restricted = spawnSync("kimi", spec.argv, {
        encoding: "utf8",
        cwd: workspace,
        env: { ...process.env, ...spec.envOverlay },
      });
      const text = `${restricted.stderr}${restricted.stdout}`;
      expect(text).not.toMatch(/Cannot combine --prompt with --plan/);
      expect(text).toMatch(/not configured|Model /);
    } finally {
      disposeIdeateAuthHome(ephemeral);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildIdeateKimiConfig keeps models and drops hooks", () => {
    const built = buildIdeateKimiConfig(
      [
        'default_permission_mode = "auto"',
        'default_model = "kimi-code/k3"',
        "[[hooks]]",
        'event = "PostToolUse"',
        '[models."kimi-code/k3"]',
        'provider = "managed:kimi-code"',
      ].join("\n"),
    );
    expect(extractKimiModelCatalog(built)).toContain('[models."kimi-code/k3"]');
    expect(built).not.toContain("[[hooks]]");
    expect(built).not.toContain('default_permission_mode = "auto"');
  });

  it("places default_model at TOML top level before [tools]", () => {
    const built = buildIdeateKimiConfig(
      [
        'default_model = "kimi-code/k3"',
        "[[hooks]]",
        'event = "PostToolUse"',
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        '[models."kimi-code/k3"]',
        'provider = "managed:kimi-code"',
      ].join("\n"),
    );
    const scopes = parseTomlAssignmentScopes(built);
    expect(scopes.topLevel.default_model).toBe('"kimi-code/k3"');
    expect(scopes.topLevel.default_permission_mode).toBe('"manual"');
    expect(scopes.topLevel.default_plan_mode).toBe("true");
    expect(scopes.tables.tools?.default_model).toBeUndefined();
    expect(scopes.tables.tools?.disabled).toContain("Bash");
    expect(scopes.tables['models."kimi-code/k3"']?.provider).toBe('"managed:kimi-code"');
    expect(scopes.tables["hooks"]).toBeUndefined();
  });

  it("does not copy commented hook headers or unknown tables after models", () => {
    const built = buildIdeateKimiConfig(
      [
        'default_model = "kimi-code/k3"',
        '[models."kimi-code/k3"]',
        'provider = "managed:kimi-code"',
        'model = "k3"',
        "[[hooks]] # existing user hook",
        'command = "SHOULD_NOT_BE_COPIED"',
        "[hooks] # comment",
        'event = "PostToolUse"',
        "[ui]",
        'theme = "dark"',
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
      ].join("\n"),
    );
    const scopes = parseTomlAssignmentScopes(built);
    expect(built).not.toContain("SHOULD_NOT_BE_COPIED");
    expect(built).not.toContain("PostToolUse");
    expect(built).not.toContain("theme");
    expect(scopes.tables.hooks).toBeUndefined();
    expect(scopes.tables.ui).toBeUndefined();
    expect(scopes.tables['models."kimi-code/k3"']?.provider).toBe('"managed:kimi-code"');
    expect(scopes.tables['models."kimi-code/k3"']?.model).toBe('"k3"');
    expect(scopes.tables['providers."managed:kimi-code"']?.type).toBe('"kimi"');
    expect(parseTomlTableHeader("[[hooks]] # existing user hook")).toEqual({
      path: "hooks",
      array: true,
    });
    expect(parseTomlTableHeader("[hooks] # comment")).toEqual({ path: "hooks", array: false });
    expect(parseTomlTableHeader("[ui]")).toEqual({ path: "ui", array: false });
    expect(isKimiCatalogHeader("[ui]")).toBe(false);
    expect(isKimiCatalogHeader('[models."kimi-code/k3"] # catalog')).toBe(true);
  });

  it("keeps a models header that has a trailing comment and drops a malformed header body", () => {
    const built = buildIdeateKimiConfig(
      [
        'default_model = "kimi-code/k3"',
        '[models."kimi-code/k3"] # catalog',
        'provider = "managed:kimi-code"',
        "[hooks",
        'command = "SHOULD_NOT_BE_COPIED"',
      ].join("\n"),
    );
    const scopes = parseTomlAssignmentScopes(built);
    expect(scopes.tables['models."kimi-code/k3"']?.provider).toBe('"managed:kimi-code"');
    expect(built).not.toContain("# catalog");
    expect(built).not.toContain("SHOULD_NOT_BE_COPIED");
    expect(scopes.tables.hooks).toBeUndefined();
    expect(parseTomlTableHeader('[models."kimi-code/k3"] # catalog')).toEqual({
      path: 'models."kimi-code/k3"',
      array: false,
    });
    expect(parseTomlTableHeader("[hooks")).toBeNull();
  });
});

function isKimiCatalogHeader(line: string): boolean {
  const header = parseTomlTableHeader(line);
  const first = header?.path.split(".")[0]?.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  return first === "models" || first === "providers";
}

/** Assignment-scope parse: a key after [table] belongs to that table. */
function parseTomlAssignmentScopes(text: string): {
  topLevel: Record<string, string>;
  tables: Record<string, Record<string, string>>;
} {
  let current: string | null = null;
  const topLevel: Record<string, string> = {};
  const tables: Record<string, Record<string, string>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const header = parseTomlTableHeader(line);
    if (header !== null) {
      current = header.path;
      tables[current] ??= {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv?.[1]) continue;
    if (current === null) {
      topLevel[kv[1]] = kv[2] ?? "";
      continue;
    }
    tables[current] ??= {};
    tables[current][kv[1]] = kv[2] ?? "";
  }
  return { topLevel, tables };
}
