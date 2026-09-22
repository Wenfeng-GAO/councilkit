/** CouncilKit repair role defaults. Not a general runtime platform. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCouncilkitHome } from "./cli-home";

export const CURSOR_REPAIR_MODEL =
  "grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]";

/** Display name measured from Cursor for the exact 500K id. Receipt-only. */
export const CURSOR_REPAIR_MODEL_DISPLAY = "Grok 4.7 500K Extra High";

export const GROK_REPAIR_MODEL = "grok-4.6";

export const CURSOR_REPAIR_PROFILE = "councilkit-repair-cursor";

export const REPAIR_ROLE_SWAP_LIMIT =
  "角色配置只在下一次新建 Squad 任务 init 时写入 runtime contract。已冻结的 native session 保持原来的 runtime/model，不能跨模型 resume。repair roles 不修改修复链、历史或已用预算，也不会把预算清零。不支持在同一次执行里原地换模型。额度耗尽后先 repair stop 停掉当前 writer，再修改席位；下一次同链任务会导入 history。不要用新的 repair chain，否则已用预算会从 0 重新计算。";

export type SquadOrchestratorRuntime = "cursor" | "grokb" | "grok";

export type RepairSeat =
  | "orchestrator"
  | "planner_a"
  | "planner_b"
  | "coder"
  | "reviewer"
  | "verifier";

export type RepairRoleRuntime = "cursor" | "codex" | "grokb" | "grok";

export interface RepairRoleBinding {
  runtime: RepairRoleRuntime;
  model: string;
  mode?: "main-session";
  sandbox?: "read-only" | "workspace-write";
  permission_mode?: "unrestricted-local";
}

export interface RepairRoleOverride {
  runtime?: string;
  model?: string;
}

export interface SquadBridgeFile {
  executable?: string;
  skillDir?: string;
  grokb?: string;
  cursor?: string;
  orchestratorRuntime?: string;
  model?: string;
  roles?: Partial<Record<RepairSeat, RepairRoleOverride>>;
}

const REPAIR_SEATS: readonly RepairSeat[] = [
  "orchestrator",
  "planner_a",
  "planner_b",
  "coder",
  "reviewer",
  "verifier",
];

const BUILDER_SEATS: readonly RepairSeat[] = ["orchestrator", "planner_a", "coder"];

const INDEPENDENT_SEATS: readonly RepairSeat[] = ["planner_b", "reviewer", "verifier"];

const UNPINNED_MODELS = new Set(["auto", "default", "configured", "current"]);

const BUILDER_MISMATCH =
  "连续 Builder（planner_a 与 coder）必须和 Orchestrator 使用同一 runtime/model，并续接同一 native session。独立 Builder 必须是显式 fresh session；当前控制器不实现该模式，已拒绝，避免把另一次会话伪装成连续 Builder。请同时保持这三席一致，或只改 orchestrator（planner_a 与 coder 会跟着走）。";

const DISPLAY_KEY = "grok 4.7 500k extra high";
const PARAM_KEY = "grok-4.7-context-500k-reasoning-effort-xhigh-fast-false";

export function cursorRepairModelPin(
  configured: string | undefined,
): { ok: true; model: string } | { ok: false; reason: string } {
  return canonicalizeRepairModel(configured);
}

/** Empty means the Cursor default. Any other explicit id is kept as itself. */
export function canonicalizeRepairModel(
  configured: string | undefined,
): { ok: true; model: string } | { ok: false; reason: string } {
  if (configured === undefined || configured.trim().length === 0) {
    return { ok: true, model: CURSOR_REPAIR_MODEL };
  }
  const trimmed = configured.trim();
  if (UNPINNED_MODELS.has(trimmed.toLowerCase())) {
    return {
      ok: false,
      reason: `拒绝未钉死的模型「${trimmed}」。不会自动改用其他模型，也不会把它当成 ${CURSOR_REPAIR_MODEL}。`,
    };
  }
  const collapsed = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (trimmed === CURSOR_REPAIR_MODEL || collapsed === DISPLAY_KEY) {
    return { ok: true, model: CURSOR_REPAIR_MODEL };
  }
  if (/grok-4\.7/i.test(trimmed) && /500\s*k/i.test(trimmed)) {
    return {
      ok: false,
      reason: `500K Extra High 必须精确为 ${CURSOR_REPAIR_MODEL}，已拒绝「${trimmed}」。`,
    };
  }
  if (trimmed === "grok-4.7-xhigh" || collapsed === "grok 4.7 extra high") {
    return { ok: true, model: "grok-4.7-xhigh" };
  }
  return { ok: true, model: trimmed };
}

/** True when the receipt is the requested model, not a different model wearing its name. */
export function repairModelReceiptMatches(requested: string, observed: string): boolean {
  const canon = canonicalizeRepairModel(requested);
  const requestedModel = canon.ok ? canon.model : requested.trim();
  const value = observed.trim();
  if (requestedModel.length === 0 || value.length === 0) return false;
  if (requestedModel === CURSOR_REPAIR_MODEL) return cursor500kReceipt(value);
  if (value === requestedModel) return true;
  const collapsed = value.toLowerCase().replace(/\s+/g, " ");
  if (collapsed === requestedModel.toLowerCase().replace(/\s+/g, " ")) return true;
  if (modelKey(value) === modelKey(requestedModel)) return true;
  if (requestedModel === "grok-4.7-xhigh" && collapsed === "grok 4.7 extra high") return true;
  return false;
}

/** True only for the exact 500K id, its display name, or that id's charset key. */
export function cursorRepairModelReceiptMatches(observed: string): boolean {
  return repairModelReceiptMatches(CURSOR_REPAIR_MODEL, observed);
}

function cursor500kReceipt(value: string): boolean {
  if (value === CURSOR_REPAIR_MODEL) return true;
  if (value.toLowerCase().replace(/\s+/g, " ") === DISPLAY_KEY) return true;
  return modelKey(value) === PARAM_KEY;
}

function modelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._:/+@-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function runtimeOfExecutable(executable: string): SquadOrchestratorRuntime | null {
  const base = executable.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base.includes("cursor-agent")) return "cursor";
  if (base.includes("grokb")) return "grokb";
  if (base === "grok" || base.startsWith("grok.") || base.startsWith("grok-")) return "grok";
  return null;
}

export function executableServesRuntime(
  executable: string,
  runtime: SquadOrchestratorRuntime,
): boolean {
  const found = runtimeOfExecutable(executable);
  if (found === null) return false;
  if (runtime === "cursor") return found === "cursor";
  return found === "grokb" || found === "grok";
}

export function cursorRepairRoles(
  model: string = CURSOR_REPAIR_MODEL,
): Record<RepairSeat, RepairRoleBinding> {
  return {
    orchestrator: { runtime: "cursor", model, mode: "main-session" },
    planner_a: { runtime: "cursor", model, mode: "main-session", sandbox: "read-only" },
    planner_b: { runtime: "cursor", model, sandbox: "read-only" },
    coder: {
      runtime: "cursor",
      model,
      mode: "main-session",
      permission_mode: "unrestricted-local",
    },
    reviewer: { runtime: "cursor", model, sandbox: "read-only" },
    verifier: { runtime: "cursor", model, sandbox: "workspace-write" },
  };
}

export interface ResolvedRepairRoles {
  roles: Record<RepairSeat, RepairRoleBinding>;
  emitContract: boolean;
  orchestratorRuntime: SquadOrchestratorRuntime;
  orchestratorModel: string;
  hasRoleOverrides: boolean;
}

export function resolveRepairRoles(input: {
  orchestratorRuntime?: string | null;
  cursorModel?: string | null;
  roles?: unknown;
}): { ok: true } & ResolvedRepairRoles | { ok: false; reason: string } {
  const runtimeRaw = input.orchestratorRuntime?.trim().toLowerCase() ?? "";
  let orchestratorRuntime: SquadOrchestratorRuntime = "cursor";
  if (runtimeRaw === "cursor" || runtimeRaw === "grokb" || runtimeRaw === "grok") {
    orchestratorRuntime = runtimeRaw;
  } else if (runtimeRaw.length > 0) {
    return {
      ok: false,
      reason: "orchestratorRuntime 只能是 cursor、grokb 或 grok。不会自动改用其他 runtime。",
    };
  }
  const cursorModelExplicit =
    typeof input.cursorModel === "string" && input.cursorModel.trim().length > 0;
  const cursorDefault = canonicalizeRepairModel(cursorModelExplicit ? input.cursorModel?.trim() : undefined);
  if (!cursorDefault.ok) return cursorDefault;
  const overrides = parseRoleOverrides(input.roles);
  if (!overrides.ok) return overrides;
  const hasRoleOverrides = Object.keys(overrides.roles).length > 0;
  const roles = cursorRepairRoles(cursorDefault.model);
  if (orchestratorRuntime !== "cursor") {
    for (const seat of BUILDER_SEATS) {
      roles[seat] = decorateSeat(seat, orchestratorRuntime, GROK_REPAIR_MODEL);
    }
  }
  for (const seat of REPAIR_SEATS) {
    const override = overrides.roles[seat];
    if (!override) continue;
    const parsed = parseSeatOverride(seat, override, cursorDefault.model);
    if (!parsed.ok) return parsed;
    roles[seat] = parsed.role;
  }
  if (!overrides.roles.planner_a) {
    roles.planner_a = decorateSeat("planner_a", roles.orchestrator.runtime, roles.orchestrator.model);
  }
  if (!overrides.roles.coder) {
    roles.coder = decorateSeat("coder", roles.orchestrator.runtime, roles.orchestrator.model);
  }
  for (const seat of ["planner_a", "coder"] as const) {
    if (
      roles[seat].runtime !== roles.orchestrator.runtime ||
      roles[seat].model !== roles.orchestrator.model ||
      roles[seat].mode !== "main-session"
    ) {
      return { ok: false, reason: BUILDER_MISMATCH };
    }
  }
  if (roles.orchestrator.mode !== "main-session") {
    return { ok: false, reason: "Orchestrator 必须使用 main-session。" };
  }
  if (roles.orchestrator.runtime !== "cursor" && roles.orchestrator.runtime !== "grokb" && roles.orchestrator.runtime !== "grok") {
    return { ok: false, reason: "Orchestrator 只支持 cursor、grokb 或 grok。独立 Codex 席不能冒充 Orchestrator。" };
  }
  for (const seat of INDEPENDENT_SEATS) {
    if (roles[seat].mode === "main-session") {
      return { ok: false, reason: `${seat} 不能使用 main-session，否则会伪装成连续 Builder。` };
    }
    if (roles[seat].runtime !== "cursor" && roles[seat].runtime !== "codex") {
      return {
        ok: false,
        reason: `${seat} 只支持 cursor 或 codex。已拒绝 ${roles[seat].runtime}，不会自动换成其他模型。`,
      };
    }
  }
  const family = roles.orchestrator.runtime === "cursor" ? "cursor" : roles.orchestrator.runtime;
  if (family !== orchestratorRuntime && !(orchestratorRuntime !== "cursor" && family !== "cursor")) {
    return {
      ok: false,
      reason: "orchestrator 席位 runtime 与 orchestratorRuntime 不一致，已拒绝自动替换。",
    };
  }
  return {
    ok: true,
    roles,
    emitContract: orchestratorRuntime === "cursor" || hasRoleOverrides || cursorModelExplicit,
    orchestratorRuntime: roles.orchestrator.runtime === "grok" ? "grok" : roles.orchestrator.runtime === "grokb" ? "grokb" : "cursor",
    orchestratorModel: roles.orchestrator.model,
    hasRoleOverrides,
  };
}

export function readSquadBridgeFile(env: NodeJS.ProcessEnv = process.env): {
  file: SquadBridgeFile;
  reason: string | null;
} {
  try {
    const raw = readFileSync(join(resolveCouncilkitHome(env), "squad-bridge.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { file: {}, reason: "squad-bridge.json 必须是对象。" };
    }
    const row = parsed as Record<string, unknown>;
    const roles = parseRoleOverrides(row.roles);
    if (!roles.ok) return { file: {}, reason: roles.reason };
    return {
      file: {
        executable: typeof row.executable === "string" ? row.executable : undefined,
        skillDir: typeof row.skillDir === "string" ? row.skillDir : undefined,
        grokb: typeof row.grokb === "string" ? row.grokb : undefined,
        cursor: typeof row.cursor === "string" ? row.cursor : undefined,
        orchestratorRuntime:
          typeof row.orchestratorRuntime === "string" ? row.orchestratorRuntime : undefined,
        model: typeof row.model === "string" ? row.model : undefined,
        roles: roles.roles,
      },
      reason: null,
    };
  } catch {
    return { file: {}, reason: null };
  }
}

export function writeSquadBridgeFile(
  env: NodeJS.ProcessEnv,
  file: Record<string, unknown>,
): string {
  const path = join(resolveCouncilkitHome(env), "squad-bridge.json");
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export function readSquadBridgeObject(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  try {
    const raw = readFileSync(join(resolveCouncilkitHome(env), "squad-bridge.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // missing config uses defaults
  }
  return {};
}

export function applyRepairRoleUpdates(
  current: Record<string, unknown>,
  updates: Partial<Record<RepairSeat, RepairRoleOverride>>,
  orchestratorRuntime?: string | null,
): { ok: true; file: Record<string, unknown>; resolved: ResolvedRepairRoles } | { ok: false; reason: string } {
  const roles = { ...(squadBridgeFileFromRow(current).roles ?? {}) };
  const builderUpdate = updates.orchestrator ?? updates.planner_a ?? updates.coder;
  if (builderUpdate) {
    for (const seat of ["orchestrator", "planner_a", "coder"] as const) {
      const chosen = updates[seat];
      if (
        chosen &&
        builderUpdate.runtime &&
        chosen.runtime &&
        (chosen.runtime !== builderUpdate.runtime || chosen.model !== builderUpdate.model)
      ) {
        return { ok: false, reason: BUILDER_MISMATCH };
      }
    }
    roles.orchestrator = builderUpdate;
    roles.planner_a = builderUpdate;
    roles.coder = builderUpdate;
  }
  for (const seat of INDEPENDENT_SEATS) {
    const chosen = updates[seat];
    if (chosen) roles[seat] = chosen;
  }
  const file: Record<string, unknown> = { ...current, roles };
  const resolved = resolveRepairRoles({
    orchestratorRuntime: orchestratorRuntime ?? (typeof file.orchestratorRuntime === "string" ? file.orchestratorRuntime : undefined),
    cursorModel: typeof file.model === "string" ? file.model : undefined,
    roles,
  });
  if (!resolved.ok) return resolved;
  return { ok: true, file, resolved };
}

export function buildRepairContract(input: {
  contractId: string;
  createdAt: string;
  roles: Record<RepairSeat, RepairRoleBinding>;
}): {
  schema_version: 1;
  contract_id: string;
  profile: string;
  planning: { requested: "simple"; resolved: "simple"; reason: string };
  roles: Record<RepairSeat, RepairRoleBinding>;
  version: 1;
  created_at: string;
} {
  return {
    schema_version: 1,
    contract_id: input.contractId,
    profile: CURSOR_REPAIR_PROFILE,
    planning: {
      requested: "simple",
      resolved: "simple",
      reason:
        "CouncilKit repair stays on simple planning. Reviewer and Verifier stay independent of the Builder session.",
    },
    roles: input.roles,
    version: 1,
    created_at: input.createdAt,
  };
}

export function buildCursorRepairContract(input: {
  contractId: string;
  createdAt: string;
  model?: string;
}): ReturnType<typeof buildRepairContract> {
  const model = input.model ?? CURSOR_REPAIR_MODEL;
  return buildRepairContract({
    contractId: input.contractId,
    createdAt: input.createdAt,
    roles: cursorRepairRoles(model),
  });
}

function decorateSeat(seat: RepairSeat, runtime: RepairRoleRuntime, model: string): RepairRoleBinding {
  if (seat === "orchestrator") return { runtime, model, mode: "main-session" };
  if (seat === "planner_a") {
    return { runtime, model, mode: "main-session", sandbox: "read-only" };
  }
  if (seat === "coder") {
    return { runtime, model, mode: "main-session", permission_mode: "unrestricted-local" };
  }
  if (seat === "verifier") return { runtime, model, sandbox: "workspace-write" };
  return { runtime, model, sandbox: "read-only" };
}

function parseSeatOverride(
  seat: RepairSeat,
  override: RepairRoleOverride,
  cursorDefault: string,
): { ok: true; role: RepairRoleBinding } | { ok: false; reason: string } {
  const runtimeRaw = override.runtime?.trim().toLowerCase() ?? "";
  const builder = seat === "orchestrator" || seat === "planner_a" || seat === "coder";
  let runtime: RepairRoleRuntime = "cursor";
  if (runtimeRaw.length === 0) {
    runtime = "cursor";
  } else if (runtimeRaw === "cursor" || runtimeRaw === "codex" || runtimeRaw === "grokb" || runtimeRaw === "grok") {
    runtime = runtimeRaw;
  } else {
    return { ok: false, reason: `${seat} 不支持 runtime「${runtimeRaw}」。不会自动换成其他 runtime。` };
  }
  if (!builder && runtime !== "cursor" && runtime !== "codex") {
    return {
      ok: false,
      reason: `${seat} 只支持 cursor 或 codex。已拒绝 ${runtime}，不会自动换成其他模型。`,
    };
  }
  if (builder && runtime === "codex") return { ok: false, reason: BUILDER_MISMATCH };
  const modelRaw = override.model?.trim() ?? "";
  if (modelRaw.length === 0) {
    if (runtime === "codex") {
      return { ok: false, reason: `${seat} 使用 codex 时必须写明 model。不会替它挑选模型。` };
    }
    return {
      ok: true,
      role: decorateSeat(seat, runtime, runtime === "cursor" ? cursorDefault : GROK_REPAIR_MODEL),
    };
  }
  if (UNPINNED_MODELS.has(modelRaw.toLowerCase())) {
    return { ok: false, reason: `${seat} 拒绝未钉死的模型「${modelRaw}」。` };
  }
  if (runtime === "cursor") {
    const canon = canonicalizeRepairModel(modelRaw);
    if (!canon.ok) return canon;
    return { ok: true, role: decorateSeat(seat, runtime, canon.model) };
  }
  return { ok: true, role: decorateSeat(seat, runtime, modelRaw) };
}

function parseRoleOverrides(
  value: unknown,
): { ok: true; roles: Partial<Record<RepairSeat, RepairRoleOverride>> } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, roles: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "squad-bridge.json roles 必须是对象。" };
  }
  const roles: Partial<Record<RepairSeat, RepairRoleOverride>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!REPAIR_SEATS.includes(key as RepairSeat)) {
      return { ok: false, reason: `未知修复席位「${key}」。` };
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: `席位 ${key} 必须是 { runtime, model }。` };
    }
    const row = raw as Record<string, unknown>;
    const runtime = typeof row.runtime === "string" ? row.runtime : undefined;
    const model = typeof row.model === "string" ? row.model : undefined;
    if (!runtime && !model) return { ok: false, reason: `席位 ${key} 缺少 runtime 或 model。` };
    roles[key as RepairSeat] = { runtime, model };
  }
  return { ok: true, roles };
}

function squadBridgeFileFromRow(row: Record<string, unknown>): SquadBridgeFile {
  const roles = parseRoleOverrides(row.roles);
  return {
    executable: typeof row.executable === "string" ? row.executable : undefined,
    skillDir: typeof row.skillDir === "string" ? row.skillDir : undefined,
    grokb: typeof row.grokb === "string" ? row.grokb : undefined,
    cursor: typeof row.cursor === "string" ? row.cursor : undefined,
    orchestratorRuntime:
      typeof row.orchestratorRuntime === "string" ? row.orchestratorRuntime : undefined,
    model: typeof row.model === "string" ? row.model : undefined,
    roles: roles.ok ? roles.roles : undefined,
  };
}

export function cursorOrchestratorArgv(input: {
  workspace: string;
  model: string;
  resumeSession: string | null;
}): string[] {
  const argv = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--force",
    "--trust",
    "--workspace",
    input.workspace,
    "--model",
    input.model,
  ];
  if (input.resumeSession) {
    const at = argv.indexOf("--workspace");
    argv.splice(at, 0, "--resume", input.resumeSession);
  }
  return argv;
}
