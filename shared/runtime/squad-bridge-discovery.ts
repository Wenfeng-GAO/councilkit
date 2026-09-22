import { constants, accessSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { userCliBinDirs, vendorDriverBinDirs, vendorHome } from "./driver-bins";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "./squad-bridge-contract";
import {
  type SquadBridgeFile,
  type SquadOrchestratorRuntime,
  readSquadBridgeFile,
  resolveRepairRoles,
  runtimeOfExecutable,
} from "./squad-repair-runtime";

const REQUIRED_MARKERS = [
  "init",
  "intake",
  "status",
  "resume",
  "adapter",
  "check-remote",
  "push-remote",
] as const;

const SKILL_LAYOUT_NAMES = ["hengzhuo-engineering-squad"] as const;

export interface SquadBridgeOrchestratorProbe {
  requestedRuntime: SquadOrchestratorRuntime;
  actualRuntime: string | null;
  model: string | null;
  nativeSession: string | null;
  executable: string | null;
}

export interface SquadBridgeProbe {
  available: boolean;
  version: string | null;
  toolVersion: string | null;
  reason: string | null;
  executable: string | null;
  skillDir: string | null;
  capabilities: string[];
  historyContract: string | null;
  orchestrator: SquadBridgeOrchestratorProbe | null;
}

export function discoverSquadBridge(env: NodeJS.ProcessEnv = process.env): SquadBridgeProbe {
  return probeSquadBridge(env);
}

export function probeSquadBridge(env: NodeJS.ProcessEnv = process.env): SquadBridgeProbe {
  const home = vendorHome(env);
  const loaded = readSquadBridgeFile(env);
  if (loaded.reason) return unavailable(loaded.reason);
  const config = loaded.file;
  const explicitExe = firstPath([env.COUNCILKIT_SQUADCTL, env.SQUADCTL, config.executable]);
  if (explicitExe) {
    if (!isExecutableFile(explicitExe)) {
      return unavailable(
        "COUNCILKIT_SQUADCTL / SQUADCTL / squad-bridge.json 的 executable 无效或不可执行，已停止继续扫描。",
      );
    }
  }
  const explicitSkill = firstPath([env.COUNCILKIT_SQUAD_SKILL, config.skillDir]);
  if (explicitSkill && !isSkillDir(explicitSkill)) {
    return unavailable(
      "COUNCILKIT_SQUAD_SKILL / squad-bridge.json 的 skillDir 不是已安装的 hengzhuo-engineering-squad 目录。",
    );
  }
  const explicitGrokb = firstPath([env.COUNCILKIT_GROKB, config.grokb]);
  if (explicitGrokb && !isExecutableFile(explicitGrokb)) {
    return unavailable("COUNCILKIT_GROKB 指向的文件不可执行，已停止继续扫描。");
  }
  const explicitCursor = firstPath([env.COUNCILKIT_CURSOR, config.cursor]);
  if (explicitCursor && !isExecutableFile(explicitCursor)) {
    return unavailable("COUNCILKIT_CURSOR 指向的文件不可执行，已停止继续扫描。");
  }
  const located = locateSquadctl(env, home, config, explicitExe);
  const executable = located.executable;
  const skillDir = resolveSkillDir(
    env,
    home,
    config,
    executable ?? located.unexecutable,
    explicitSkill,
  );
  if (executable === null && located.unexecutable) {
    return unavailable("发现到的 squadctl 文件存在但不可执行。");
  }
  if (executable === null) {
    return unavailable(
      "PATH 与配置中都没有可用的 squadctl。把已安装 skill 的 scripts/squadctl 加入 PATH，或设置 COUNCILKIT_SQUADCTL / COUNCILKIT_SQUAD_SKILL。",
    );
  }
  if (skillDir === null) {
    return unavailable(
      "找到了 squadctl 可执行文件，但缺少 skill 的说明书（SKILL.md + references/squadctl.md），无法核验 init/intake/status/resume/adapter/integrate。请设置 COUNCILKIT_SQUAD_SKILL 指向安装目录。",
    );
  }
  const doc = readCapabilityDoc(skillDir);
  const missing = missingMarkers(doc);
  if (missing.length > 0) {
    return unavailable(`已安装的 squadctl skill 未声明 ${missing.join("、")}，不能当作 Squad 桥。`);
  }
  const orchestrator = selectOrchestrator(env, home, config, explicitCursor, explicitGrokb);
  if (!orchestrator.ok) return unavailable(orchestrator.reason);
  return {
    available: true,
    version: SQUAD_BRIDGE_CONTRACT_VERSION,
    toolVersion: null,
    reason: null,
    executable,
    skillDir,
    capabilities: [...REQUIRED_MARKERS],
    historyContract: null,
    orchestrator: {
      requestedRuntime: orchestrator.runtime,
      actualRuntime: null,
      model: orchestrator.model,
      nativeSession: null,
      executable: orchestrator.executable,
    },
  };
}

export function findOrchestratorExecutable(
  env: NodeJS.ProcessEnv,
  runtime: SquadOrchestratorRuntime,
): string | null {
  const home = vendorHome(env);
  const config = readSquadBridgeFile(env).file;
  if (runtime === "cursor") {
    const explicit = firstPath([env.COUNCILKIT_CURSOR, config.cursor]);
    if (explicit) return isExecutableFile(explicit) ? explicit : null;
    return (
      findOnPath("cursor-agent", env) ?? findInDirs("cursor-agent", wellKnownBinDirs(home, env))
    );
  }
  const explicit = firstPath([env.COUNCILKIT_GROKB, config.grokb]);
  if (explicit) return isExecutableFile(explicit) ? explicit : null;
  const grokb = findOnPath("grokb", env) ?? findInDirs("grokb", wellKnownBinDirs(home, env));
  const grok = findOnPath("grok", env) ?? findInDirs("grok", wellKnownBinDirs(home, env));
  if (runtime === "grok") return grok ?? grokb;
  return grokb ?? grok;
}

function unavailable(reason: string): SquadBridgeProbe {
  return {
    available: false,
    version: null,
    toolVersion: null,
    reason,
    executable: null,
    skillDir: null,
    capabilities: [],
    historyContract: null,
    orchestrator: null,
  };
}

function resolveSkillDir(
  env: NodeJS.ProcessEnv,
  home: string,
  config: BridgeConfig,
  executable: string | null,
  explicitSkill: string | null,
): string | null {
  if (explicitSkill) return isSkillDir(explicitSkill) ? explicitSkill : null;
  for (const skillDir of namedSkillDirs(env, home, config.skillDir)) {
    if (isSkillDir(skillDir)) return skillDir;
  }
  if (executable) {
    const fromExe = dirname(dirname(executable));
    if (isSkillDir(fromExe) && namedSkill(fromExe)) return fromExe;
  }
  return null;
}

function selectOrchestrator(
  env: NodeJS.ProcessEnv,
  home: string,
  config: BridgeConfig,
  explicitCursor: string | null,
  explicitGrokb: string | null,
):
  | { ok: true; runtime: SquadOrchestratorRuntime; executable: string; model: string }
  | { ok: false; reason: string } {
  const configured = configuredRuntime(env, config);
  if (configured === "invalid") {
    return {
      ok: false,
      reason:
        "COUNCILKIT_ORCHESTRATOR_RUNTIME / squad-bridge.json orchestratorRuntime 只能是 cursor、grokb 或 grok。",
    };
  }
  const runtime: SquadOrchestratorRuntime =
    configured ?? (explicitCursor ? "cursor" : explicitGrokb ? "grokb" : "cursor");
  const executable =
    runtime === "cursor"
      ? (explicitCursor ??
        findOnPath("cursor-agent", env) ??
        findInDirs("cursor-agent", wellKnownBinDirs(home, env)))
      : findOrchestratorExecutable(env, runtime);
  if (!executable) {
    return {
      ok: false,
      reason:
        runtime === "cursor"
          ? "独立 Orchestrator 需要 cursor-agent，当前未找到。已拒绝回退到 grokb、grok、Codex 或 auto。请安装 cursor-agent，或设置 COUNCILKIT_CURSOR。若要回滚到 Grok，把 orchestratorRuntime 设为 grokb。"
          : "已选择 Grok Orchestrator，但未找到 grokb 或 grok。不会改用 Cursor。",
    };
  }
  const resolved = resolveRepairRoles({
    orchestratorRuntime: runtime,
    cursorModel: env.COUNCILKIT_CURSOR_MODEL ?? config.model,
    roles: config.roles,
  });
  if (!resolved.ok) return resolved;
  const found = runtimeOfExecutable(executable);
  const requestedRuntime: SquadOrchestratorRuntime =
    runtime === "cursor" ? "cursor" : found === "grok" ? "grok" : "grokb";
  return { ok: true, runtime: requestedRuntime, executable, model: resolved.orchestratorModel };
}

function configuredRuntime(
  env: NodeJS.ProcessEnv,
  config: BridgeConfig,
): SquadOrchestratorRuntime | "invalid" | null {
  const raw = (env.COUNCILKIT_ORCHESTRATOR_RUNTIME ?? config.orchestratorRuntime)?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "cursor" || raw === "grokb" || raw === "grok") return raw;
  return "invalid";
}

function namedSkill(path: string): boolean {
  return SKILL_LAYOUT_NAMES.some((name) => path.endsWith(name) || path.endsWith(`${name}/`));
}

function namedSkillDirs(env: NodeJS.ProcessEnv, home: string, configSkillDir?: string): string[] {
  const roots: string[] = [];
  const addRoot = (value: string | undefined): void => {
    if (!value || value.trim().length === 0) return;
    const resolved = resolvePath(value);
    if (isSkillDir(resolved) && namedSkill(resolved) && !roots.includes(resolved)) {
      roots.push(resolved);
    }
    for (const name of SKILL_LAYOUT_NAMES) {
      const candidate = join(resolved, "skills", name);
      if (isSkillDir(candidate) && !roots.includes(candidate)) roots.push(candidate);
      const direct = join(resolved, name);
      if (isSkillDir(direct) && !roots.includes(direct)) roots.push(direct);
    }
  };
  addRoot(env.COUNCILKIT_SQUAD_SKILL);
  addRoot(configSkillDir);
  addRoot(env.CODEX_HOME);
  addRoot(join(home, ".codex"));
  addRoot(env.CLAUDE_CONFIG_DIR);
  addRoot(join(home, ".claude"));
  addRoot(join(home, ".agents"));
  return roots;
}

function wellKnownBinDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  return [
    ...userCliBinDirs(home),
    ...vendorDriverBinDirs(home),
    join(home, ".codex", "bin"),
    ...(env.PATH ?? "")
      .split(delimiter)
      .filter((dir) => dir.length > 0)
      .map((dir) => resolvePath(dir)),
  ];
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = resolvePath(join(dir, name));
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function findInDirs(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function readCapabilityDoc(skillDir: string): string {
  const parts: string[] = [];
  for (const rel of ["references/squadctl.md", "SKILL.md", "scripts/squadlib/cli.py"]) {
    try {
      parts.push(readFileSync(join(skillDir, rel), "utf8"));
    } catch {
      // optional
    }
  }
  return parts.join("\n").toLowerCase();
}

function missingMarkers(doc: string): string[] {
  return REQUIRED_MARKERS.filter((marker) => !doc.includes(marker));
}

function isSkillDir(path: string): boolean {
  return isFile(join(path, "SKILL.md")) && isFile(join(path, "references", "squadctl.md"));
}

type BridgeConfig = SquadBridgeFile;

function resolvePath(value: string): string {
  return isAbsolute(value) ? value : resolve(value);
}

function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path);
    if (!info.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function locateSquadctl(
  env: NodeJS.ProcessEnv,
  home: string,
  config: BridgeConfig,
  explicit: string | null,
): { executable: string | null; unexecutable: string | null } {
  if (explicit) {
    return isExecutableFile(explicit)
      ? { executable: explicit, unexecutable: null }
      : { executable: null, unexecutable: isFile(explicit) ? explicit : null };
  }
  const pathHit = findOnPath("squadctl", env);
  if (pathHit) return { executable: pathHit, unexecutable: null };
  for (const dir of wellKnownBinDirs(home, env)) {
    const candidate = join(dir, "squadctl");
    if (isExecutableFile(candidate)) return { executable: candidate, unexecutable: null };
    if (isFile(candidate)) return { executable: null, unexecutable: candidate };
  }
  for (const skillDir of namedSkillDirs(env, home, config.skillDir)) {
    const candidate = join(skillDir, "scripts", "squadctl");
    if (isExecutableFile(candidate)) return { executable: candidate, unexecutable: null };
    if (isFile(candidate)) return { executable: null, unexecutable: candidate };
  }
  return { executable: null, unexecutable: null };
}

function firstPath(values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (!value || value.trim().length === 0) continue;
    return resolvePath(value);
  }
  return null;
}
