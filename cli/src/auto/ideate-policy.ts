/**
 * Restricted invocation for `councilkit ideate`.
 *
 * Removing review bypass flags is not a read-only policy. Each supported
 * driver must apply the local CLI's real plan/sandbox/deny-tools switches
 * and isolate inherited user config / MCP / hooks. If a driver cannot
 * satisfy that, construction fails closed.
 *
 * Local help (2026-09-07) that this file is written against:
 *  - grok: --permission-mode plan, --tools, --deny, --disallowed-tools,
 *    --sandbox (custom profiles fail closed; built-in `read-only` can warn
 *    and continue). Grok also reads ~/.claude settings/MCP unless HOME is
 *    isolated. GROK_SANDBOX is a real env alias for --sandbox.
 *  - kimi: headless is `-p` / `--prompt` + `--output-format`. Local 0.41.0
 *    and official docs reject combining --prompt with --plan / --auto / -y.
 *    Restriction is --agent-file (tools: []) + --skills-dir + isolated
 *    KIMI_CODE_HOME with default_plan_mode=true. Data root is
 *    $KIMI_CODE_HOME else ~/.kimi-code. User default_permission_mode=auto
 *    and PostToolUse hooks must not be inherited.
 *  - claude/cld: --permission-mode plan, --tools "", --disallowedTools,
 *    --strict-mcp-config, --safe-mode (Host-verified).
 *  - codex: -s read-only, --ignore-user-config. Never
 *    --dangerously-bypass-approvals-and-sandbox.
 *  - cursor-agent: --mode ask (documented read-only), --sandbox enabled.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { errors } from "../errors";

export const IDEATE_POLICY_MARKER = ".councilkit-ideate-policy";
export const IDEATE_OS_HOME_DIR = ".ideate-os-home";
export const IDEATE_KIMI_AGENT_FILE = "ideate-agent.md";
export const IDEATE_KIMI_SKILLS_DIR = "ideate-skills";
export const IDEATE_CLAUDE_CONFIG_DIR = ".claude-ideate-config";
export const IDEATE_CLAUDE_MCP_FILE = "ideate-mcp.json";
export const IDEATE_GROK_SANDBOX_PROFILE = "ideate-readonly";
export const IDEATE_AUTH_TMP_PREFIX = "ck-ideate-";
export const IDEATE_AUTH_BASENAMES = [
  "auth.json",
  "credentials.json",
  "credentials",
  "oauth",
  "server.token",
  "device_id",
] as const;

export const IDEATE_FORBIDDEN_FLAGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--always-approve",
  "--force",
  "--yolo",
  "--auto",
  "-y",
  "--approve-mcps",
  "--approve-for-me",
] as const;

/** Headless built-in ids (docs: run_terminal_cmd, not bash). */
export const IDEATE_GROK_DISALLOWED_TOOLS = [
  "write",
  "search_replace",
  "run_terminal_cmd",
  "run_terminal_command",
  "web_search",
  "web_fetch",
  "spawn_subagent",
  "todo_write",
  "Agent",
].join(",");

/** Empty allowlist. MCP meta-tools still need --deny MCPTool. */
export const IDEATE_GROK_TOOLS = "";

export const IDEATE_GROK_DENY_RULES = [
  "Bash",
  "Edit",
  "Write",
  "MCPTool",
  "WebFetch",
  "WebSearch",
] as const;

export const IDEATE_GROK_CONFIG = [
  "[compat.claude]",
  "skills = false",
  "hooks = false",
  "mcps = false",
  "rules = false",
  "agents = false",
  "[compat.cursor]",
  "skills = false",
  "hooks = false",
  "mcps = false",
  "rules = false",
  "agents = false",
  "[compat.codex]",
  "hooks = false",
  "skills = false",
  "[ui]",
  'permission_mode = "plan"',
  "yolo = false",
  "[plugins]",
  "enabled = []",
  "[permission]",
  `deny = [${IDEATE_GROK_DENY_RULES.map((rule) => `"${rule}"`).join(", ")}]`,
  "",
].join("\n");

export const IDEATE_GROK_REQUIREMENTS = [
  "[ui]",
  "disable_bypass_permissions_mode = true",
  "",
].join("\n");

/**
 * Custom profile extending built-in `read-only`. Built-in `--sandbox read-only`
 * can warn and continue without enforcement; a missing custom profile refuses
 * to start (fail closed).
 */
export const IDEATE_GROK_SANDBOX = [
  `[profiles.${IDEATE_GROK_SANDBOX_PROFILE}]`,
  'extends = "read-only"',
  "restrict_network = true",
  "",
].join("\n");

export const IDEATE_GROK_PROJECT_CONFIG = [
  "[mcp_servers]",
  "[plugins]",
  "enabled = []",
  "[permission]",
  `deny = [${IDEATE_GROK_DENY_RULES.map((rule) => `"${rule}"`).join(", ")}]`,
  "",
].join("\n");

export const IDEATE_KIMI_AGENT = [
  "---",
  "name: councilkit-ideate",
  "description: Restricted discussion agent with no write, shell, or MCP tools",
  "tools: []",
  "disallowedTools:",
  "  - Bash",
  "  - Edit",
  "  - Write",
  "  - Shell",
  "  - WriteFile",
  "  - StrReplaceFile",
  "subagents: []",
  "---",
  "",
  "You are a discussion-only agent. Do not modify files, run commands, or call MCP tools.",
  "",
].join("\n");

export const IDEATE_KIMI_CONFIG = [
  'default_permission_mode = "manual"',
  "default_plan_mode = true",
  "",
  "[tools]",
  'disabled = ["Bash", "Edit", "Write", "Shell", "WriteFile", "StrReplaceFile"]',
  "",
].join("\n");

const KIMI_CONFIG_MAX_BYTES = 256 * 1024;

/**
 * Isolated KIMI_CODE_HOME must not inherit auto/yolo/hooks, but headless
 * `-m` still needs the user's `models` / `providers` catalog. `-p` cannot
 * take `--plan`; `default_plan_mode = true` plus `tools: []` is the
 * supported restriction.
 *
 * `default_model` must stay a top-level key before `[tools]`. Appending it
 * after that table makes TOML treat it as `tools.default_model`, and local
 * kimi 0.41.0 then fails with "no default model configured" even with `-m`.
 */
export function buildIdeateKimiConfig(sourceToml: string): string {
  const { defaultModel, tables } = splitKimiModelCatalog(sourceToml);
  const lines = ['default_permission_mode = "manual"', "default_plan_mode = true"];
  if (defaultModel.length > 0) lines.push(defaultModel);
  lines.push(
    "",
    "[tools]",
    'disabled = ["Bash", "Edit", "Write", "Shell", "WriteFile", "StrReplaceFile"]',
    "",
  );
  if (tables.length > 0) lines.push(tables, "");
  return lines.join("\n");
}

export function splitKimiModelCatalog(sourceToml: string): { defaultModel: string; tables: string } {
  if (sourceToml.length > KIMI_CONFIG_MAX_BYTES) return { defaultModel: "", tables: "" };
  const defaultModels: string[] = [];
  const tables: string[] = [];
  let keepSection = false;
  for (const line of sourceToml.split(/\r?\n/)) {
    if (line.trimStart().startsWith("[")) {
      const header = parseTomlTableHeader(line);
      // Unrecognized or non-catalog headers end the previous section. A
      // trailing-comment `[hooks] # …` must not keep inheriting [models].
      keepSection = header !== null && isKimiModelCatalogTable(header.path);
      if (keepSection && header !== null) tables.push(formatTomlTableHeader(header));
      continue;
    }
    if (keepSection) {
      tables.push(line);
      continue;
    }
    if (/^\s*default_model\s*=/.test(line)) defaultModels.push(line.trim());
  }
  return { defaultModel: defaultModels[0] ?? "", tables: tables.join("\n").trim() };
}

export function extractKimiModelCatalog(sourceToml: string): string {
  const { defaultModel, tables } = splitKimiModelCatalog(sourceToml);
  return [defaultModel, tables].filter((part) => part.length > 0).join("\n\n");
}

/** Strip a TOML `#` comment that is not inside a quoted key. */
function stripTomlInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((inSingle || inDouble) && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

export function parseTomlTableHeader(line: string): { path: string; array: boolean } | null {
  const stripped = stripTomlInlineComment(line.trim());
  const array = stripped.match(/^\[\[([^[\]]+)\]\]$/);
  if (array?.[1] !== undefined) return { path: array[1].trim(), array: true };
  const table = stripped.match(/^\[([^[\]]+)\]$/);
  if (table?.[1] !== undefined) return { path: table[1].trim(), array: false };
  return null;
}

function formatTomlTableHeader(header: { path: string; array: boolean }): string {
  return header.array ? `[[${header.path}]]` : `[${header.path}]`;
}

function isKimiModelCatalogTable(path: string): boolean {
  const first = path.split(".")[0]?.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  return first === "models" || first === "providers";
}

export const IDEATE_EMPTY_MCP = '{"mcpServers":{}}\n';

export const IDEATE_CLAUDE_SETTINGS = `${JSON.stringify(
  {
    permissions: {
      defaultMode: "plan",
      allow: [],
      deny: ["Bash", "Edit", "Write", "mcp__*"],
    },
    hooks: {},
  },
  null,
  2,
)}\n`;

export interface IdeatePolicyFiles {
  marker: string;
  osHome: string;
  kimiAgent: string;
  kimiSkills: string;
  claudeConfig: string;
  claudeMcp: string;
  grokSandbox: string;
  grokProjectConfig: string;
}

/** Non-secret restriction files only. Never copies credentials into the workspace. */
export function prepareIdeateWorkspace(workspace: string): IdeatePolicyFiles {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const marker = join(workspace, IDEATE_POLICY_MARKER);
  const osHome = join(workspace, IDEATE_OS_HOME_DIR);
  const kimiAgent = join(workspace, IDEATE_KIMI_AGENT_FILE);
  const kimiSkills = join(workspace, IDEATE_KIMI_SKILLS_DIR);
  const claudeConfig = join(workspace, IDEATE_CLAUDE_CONFIG_DIR);
  const claudeMcp = join(workspace, IDEATE_CLAUDE_MCP_FILE);
  const grokDir = join(workspace, ".grok");
  const grokSandbox = join(grokDir, "sandbox.toml");
  const grokProjectConfig = join(grokDir, "config.toml");
  const isolatedClaude = join(osHome, ".claude");

  mkdirSync(kimiSkills, { recursive: true, mode: 0o700 });
  mkdirSync(claudeConfig, { recursive: true, mode: 0o700 });
  mkdirSync(grokDir, { recursive: true, mode: 0o700 });
  mkdirSync(isolatedClaude, { recursive: true, mode: 0o700 });

  writeRestrictedFile(marker, "ideate-restricted\n");
  writeRestrictedFile(kimiAgent, IDEATE_KIMI_AGENT);
  writeRestrictedFile(join(workspace, ".mcp.json"), IDEATE_EMPTY_MCP);
  writeRestrictedFile(claudeMcp, IDEATE_EMPTY_MCP);
  writeRestrictedFile(join(claudeConfig, "settings.json"), IDEATE_CLAUDE_SETTINGS);
  writeRestrictedFile(join(isolatedClaude, "settings.json"), IDEATE_CLAUDE_SETTINGS);
  writeRestrictedFile(grokSandbox, IDEATE_GROK_SANDBOX);
  writeRestrictedFile(grokProjectConfig, IDEATE_GROK_PROJECT_CONFIG);
  return {
    marker,
    osHome,
    kimiAgent,
    kimiSkills,
    claudeConfig,
    claudeMcp,
    grokSandbox,
    grokProjectConfig,
  };
}

export interface IdeateAuthHome {
  dir: string;
}

/**
 * Driver-specific isolated auth+config home under os.tmpdir().
 * Kimi/Grok need a private home so user auto/yolo/always-approve is not inherited.
 * Claude/Codex/Cursor keep using their existing auth references (no copy).
 */
export function prepareIdeateAuthHome(
  driverId: string,
  env: NodeJS.ProcessEnv = process.env,
): IdeateAuthHome | null {
  if (driverId === "kimi-stream-json") {
    const dir = mkdtempSync(join(tmpdir(), `${IDEATE_AUTH_TMP_PREFIX}kimi-`));
    chmodSync(dir, 0o700);
    writeRestrictedFile(join(dir, "config.toml"), buildIdeateKimiConfig(readKimiSourceConfig(env)));
    writeRestrictedFile(join(dir, "mcp.json"), IDEATE_EMPTY_MCP);
    copyKimiAuth(dir, env);
    return { dir };
  }
  if (driverId === "grok-stream-json") {
    const dir = mkdtempSync(join(tmpdir(), `${IDEATE_AUTH_TMP_PREFIX}grok-`));
    chmodSync(dir, 0o700);
    writeRestrictedFile(join(dir, "config.toml"), IDEATE_GROK_CONFIG);
    writeRestrictedFile(join(dir, "sandbox.toml"), IDEATE_GROK_SANDBOX);
    writeRestrictedFile(join(dir, "requirements.toml"), IDEATE_GROK_REQUIREMENTS);
    copyGrokAuth(dir, env);
    return { dir };
  }
  return null;
}

/** After a workspace wipe+rebuild, policy files and ephemeral auth refs must
 * still resolve. Physical retries reuse the original argv/envOverlay. */
export function assertIdeateRetryReady(input: {
  cwd: string;
  driverId: string;
  argv: readonly string[];
  envOverlay?: NodeJS.ProcessEnv;
  ephemeralHome?: string;
}): void {
  const marker = join(input.cwd, IDEATE_POLICY_MARKER);
  if (!existsSync(marker)) {
    throw errors.usage("ideate retry workspace is missing the restricted policy marker");
  }
  const overlay = input.envOverlay ?? {};
  assertIdeateIsolatedEnv(overlay, input.driverId, input.cwd);
  if (input.driverId === "kimi-stream-json") {
    requireExistingArgPath(input.argv, "--agent-file", join(input.cwd, IDEATE_KIMI_AGENT_FILE));
    requireExistingArgPath(input.argv, "--skills-dir", join(input.cwd, IDEATE_KIMI_SKILLS_DIR));
  }
  if (input.driverId === "grok-stream-json") {
    const sandbox = join(input.cwd, ".grok", "sandbox.toml");
    if (!existsSync(sandbox)) {
      throw errors.usage("ideate retry workspace is missing the grok sandbox profile");
    }
  }
  if (input.driverId === "claude-stream-json") {
    const mcp = join(input.cwd, IDEATE_CLAUDE_MCP_FILE);
    if (!existsSync(mcp)) {
      throw errors.usage("ideate retry workspace is missing the isolated Claude MCP file");
    }
  }
  if (input.ephemeralHome !== undefined && input.ephemeralHome.length > 0) {
    const home = resolve(input.ephemeralHome);
    if (!existsSync(home)) {
      throw errors.usage("ideate retry lost its ephemeral auth home");
    }
    if (isInsideDir(home, input.cwd)) {
      throw errors.usage("ideate retry auth home must stay outside the retained workspace");
    }
  }
}

function requireExistingArgPath(argv: readonly string[], flag: string, expected: string): void {
  const idx = argv.indexOf(flag);
  const actual = idx >= 0 ? argv[idx + 1] : undefined;
  if (actual !== expected || actual === undefined || !existsSync(actual)) {
    throw errors.usage(`ideate retry lost a valid ${flag} path`);
  }
}

export function disposeIdeateAuthHome(dir: string | null | undefined): void {
  if (dir === null || dir === undefined || dir.trim().length === 0) return;
  const resolved = resolve(dir);
  const tmp = resolve(tmpdir());
  if (resolved !== tmp && !resolved.startsWith(`${tmp}${sep}`)) return;
  if (!basename(resolved).startsWith(IDEATE_AUTH_TMP_PREFIX)) return;
  rmSync(resolved, { recursive: true, force: true });
}

export function ideateEnvOverlay(
  driverId: string,
  workspace: string,
  authHome: string | null,
): NodeJS.ProcessEnv {
  const osHome = join(workspace, IDEATE_OS_HOME_DIR);
  const claudeConfig = join(workspace, IDEATE_CLAUDE_CONFIG_DIR);
  const compatOff = {
    GROK_CLAUDE_SKILLS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CLAUDE_RULES_ENABLED: "false",
    GROK_CLAUDE_AGENTS_ENABLED: "false",
    GROK_CURSOR_SKILLS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CURSOR_RULES_ENABLED: "false",
    GROK_CURSOR_AGENTS_ENABLED: "false",
  };
  if (driverId === "kimi-stream-json") {
    if (authHome === null) {
      throw errors.usage("ideate kimi requires an ephemeral isolated KIMI_CODE_HOME; refusing to spawn");
    }
    return {
      KIMI_CODE_HOME: authHome,
      HOME: osHome,
      CLAUDE_CONFIG_DIR: claudeConfig,
    };
  }
  if (driverId === "grok-stream-json") {
    if (authHome === null) {
      throw errors.usage("ideate grok requires an ephemeral isolated GROK_HOME; refusing to spawn");
    }
    return {
      ...compatOff,
      GROK_HOME: authHome,
      GROK_SANDBOX: IDEATE_GROK_SANDBOX_PROFILE,
      HOME: osHome,
      CLAUDE_CONFIG_DIR: claudeConfig,
    };
  }
  if (driverId === "claude-stream-json") {
    return {
      HOME: osHome,
      CLAUDE_CONFIG_DIR: claudeConfig,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  }
  return {};
}

export function assertNoIdeateBypassFlags(argv: readonly string[], driverId: string): void {
  for (const flag of IDEATE_FORBIDDEN_FLAGS) {
    if (argv.includes(flag)) {
      throw errors.usage(
        `ideate invocation for ${driverId} includes forbidden flag ${flag}; restricted policy refused`,
      );
    }
  }
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "-s" && argv[i + 1] === "workspace-write") {
      throw errors.usage(
        `ideate invocation for ${driverId} requested workspace-write; restricted policy refused`,
      );
    }
    if (argv[i] === "--permission-mode" && argv[i + 1] === "bypassPermissions") {
      throw errors.usage(
        `ideate invocation for ${driverId} requested bypassPermissions; restricted policy refused`,
      );
    }
    if (argv[i] === "--sandbox" && (argv[i + 1] === "danger-full-access" || argv[i + 1] === "off")) {
      throw errors.usage(
        `ideate invocation for ${driverId} requested sandbox ${argv[i + 1]}; restricted policy refused`,
      );
    }
  }
}

function requireFlag(argv: readonly string[], flag: string, driverId: string): void {
  if (!argv.includes(flag)) {
    throw errors.usage(
      `ideate invocation for ${driverId} is missing required restriction ${flag}; refusing to spawn`,
    );
  }
}

function requireFlagValue(
  argv: readonly string[],
  flag: string,
  value: string,
  driverId: string,
): void {
  const idx = argv.indexOf(flag);
  if (idx < 0 || argv[idx + 1] !== value) {
    throw errors.usage(
      `ideate invocation for ${driverId} is missing required restriction ${flag} ${value === "" ? "(empty)" : value}; refusing to spawn`,
    );
  }
}

function requireDenyRules(
  argv: readonly string[],
  rules: readonly string[],
  driverId: string,
): void {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--deny" && argv[i + 1] !== undefined) values.push(argv[i + 1] as string);
  }
  for (const rule of rules) {
    if (!values.includes(rule)) {
      throw errors.usage(
        `ideate invocation for ${driverId} must deny ${rule}; refusing to spawn`,
      );
    }
  }
}

export function assertIdeateIsolatedEnv(
  env: NodeJS.ProcessEnv,
  driverId: string,
  workspace: string,
): void {
  const osHome = join(workspace, IDEATE_OS_HOME_DIR);
  if (driverId === "grok-stream-json") {
    if (env.GROK_SANDBOX !== IDEATE_GROK_SANDBOX_PROFILE) {
      throw errors.usage(
        `ideate env for ${driverId} must set GROK_SANDBOX=${IDEATE_GROK_SANDBOX_PROFILE}; refusing to spawn`,
      );
    }
    if (env.HOME !== osHome) {
      throw errors.usage(
        `ideate env for ${driverId} must isolate HOME away from inherited ~/.claude; refusing to spawn`,
      );
    }
    if (env.GROK_CLAUDE_MCPS_ENABLED !== "false" || env.GROK_CLAUDE_HOOKS_ENABLED !== "false") {
      throw errors.usage(
        `ideate env for ${driverId} must disable inherited Claude MCP/hooks; refusing to spawn`,
      );
    }
    assertEphemeralAuthDir(env.GROK_HOME, workspace, "GROK_HOME");
    return;
  }
  if (driverId === "kimi-stream-json") {
    if (env.HOME !== osHome) {
      throw errors.usage(
        `ideate env for ${driverId} must isolate HOME away from inherited ~/.kimi-code; refusing to spawn`,
      );
    }
    assertEphemeralAuthDir(env.KIMI_CODE_HOME, workspace, "KIMI_CODE_HOME");
    return;
  }
  if (driverId === "claude-stream-json") {
    if (env.CLAUDE_CONFIG_DIR !== join(workspace, IDEATE_CLAUDE_CONFIG_DIR)) {
      throw errors.usage(
        `ideate env for ${driverId} must isolate CLAUDE_CONFIG_DIR; refusing to spawn`,
      );
    }
    if (env.HOME !== osHome) {
      throw errors.usage(
        `ideate env for ${driverId} must isolate HOME away from inherited ~/.claude; refusing to spawn`,
      );
    }
  }
}

function assertEphemeralAuthDir(
  dir: string | undefined,
  workspace: string,
  label: string,
): void {
  if (dir === undefined || dir.trim().length === 0) {
    throw errors.usage(`ideate env must set ephemeral ${label}; refusing to spawn`);
  }
  const resolved = resolve(dir);
  if (isInsideDir(resolved, workspace)) {
    throw errors.usage(`ideate ${label} must not live under the retained workspace; refusing to spawn`);
  }
  const tmp = resolve(tmpdir());
  if (resolved !== tmp && !resolved.startsWith(`${tmp}${sep}`)) {
    throw errors.usage(`ideate ${label} must be under the process temp dir; refusing to spawn`);
  }
  if (!basename(resolved).startsWith(IDEATE_AUTH_TMP_PREFIX)) {
    throw errors.usage(`ideate ${label} must use the ephemeral ${IDEATE_AUTH_TMP_PREFIX} prefix`);
  }
}

function isInsideDir(path: string, root: string): boolean {
  const resolved = resolve(path);
  const parent = resolve(root);
  return resolved === parent || resolved.startsWith(`${parent}${sep}`);
}

/** Positive proof of a restricted policy — not merely the absence of bypass flags. */
export function assertIdeateRestrictedArgv(argv: readonly string[], driverId: string): void {
  assertNoIdeateBypassFlags(argv, driverId);
  switch (driverId) {
    case "grok-stream-json":
      requireFlagValue(argv, "--permission-mode", "plan", driverId);
      requireFlagValue(argv, "--sandbox", IDEATE_GROK_SANDBOX_PROFILE, driverId);
      requireFlagValue(argv, "--tools", IDEATE_GROK_TOOLS, driverId);
      requireFlag(argv, "--disallowed-tools", driverId);
      requireFlag(argv, "--disable-web-search", driverId);
      requireFlag(argv, "--no-subagents", driverId);
      requireDenyRules(argv, IDEATE_GROK_DENY_RULES, driverId);
      return;
    case "kimi-stream-json":
      if (argv.includes("--plan")) {
        throw errors.usage(
          `ideate invocation for ${driverId} cannot combine --prompt with --plan; use --agent-file (tools: []) and isolated default_plan_mode`,
        );
      }
      if (!argv.includes("-p") && !argv.includes("--prompt")) {
        throw errors.usage(
          `ideate invocation for ${driverId} is missing required restriction --prompt; refusing to spawn`,
        );
      }
      requireFlag(argv, "--agent-file", driverId);
      requireFlag(argv, "--skills-dir", driverId);
      return;
    case "claude-stream-json":
      requireFlagValue(argv, "--permission-mode", "plan", driverId);
      requireFlagValue(argv, "--tools", "", driverId);
      requireFlag(argv, "--disallowedTools", driverId);
      requireFlag(argv, "--strict-mcp-config", driverId);
      requireFlag(argv, "--mcp-config", driverId);
      requireFlag(argv, "--safe-mode", driverId);
      return;
    case "codex-app-server":
      requireFlagValue(argv, "-s", "read-only", driverId);
      requireFlag(argv, "--ignore-user-config", driverId);
      return;
    case "cursor-stream-json":
      requireFlagValue(argv, "--mode", "ask", driverId);
      requireFlagValue(argv, "--sandbox", "enabled", driverId);
      return;
    default:
      throw errors.usage(`unsupported driver "${driverId}" for ideate`);
  }
}

function writeRestrictedFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
}

function kimiSourceHome(env: NodeJS.ProcessEnv): string {
  return typeof env.KIMI_CODE_HOME === "string" && env.KIMI_CODE_HOME.trim().length > 0
    ? env.KIMI_CODE_HOME
    : join(env.HOME && env.HOME.trim().length > 0 ? env.HOME : homedir(), ".kimi-code");
}

function readKimiSourceConfig(env: NodeJS.ProcessEnv): string {
  try {
    const raw = readFileSync(join(kimiSourceHome(env), "config.toml"), "utf8");
    return raw.length > KIMI_CONFIG_MAX_BYTES ? "" : raw;
  } catch {
    return "";
  }
}

function copyKimiAuth(destHome: string, env: NodeJS.ProcessEnv): void {
  const srcHome = kimiSourceHome(env);
  for (const name of ["credentials", "oauth", "device_id", "server.token", "region"] as const) {
    copyAuthTree(join(srcHome, name), join(destHome, name));
  }
}

function copyGrokAuth(destHome: string, env: NodeJS.ProcessEnv): void {
  const srcHome =
    typeof env.GROK_HOME === "string" && env.GROK_HOME.trim().length > 0
      ? env.GROK_HOME
      : join(env.HOME && env.HOME.trim().length > 0 ? env.HOME : homedir(), ".grok");
  for (const name of ["auth.json", "credentials.json"] as const) {
    copyAuthTree(join(srcHome, name), join(destHome, name));
  }
}

function copyAuthTree(src: string, dest: string): void {
  let st;
  try {
    st = lstatSync(src);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    try {
      copyFileSync(src, dest);
      chmodSync(dest, 0o600);
    } catch {
      // leave dest missing; spawn will fail closed on auth
    }
    return;
  }
  if (!st.isDirectory()) return;
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  let entries: string[] = [];
  try {
    entries = readdirSync(src);
  } catch {
    return;
  }
  for (const name of entries) {
    copyAuthTree(join(src, name), join(dest, name));
  }
}
