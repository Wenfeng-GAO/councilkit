import { mkdirSync } from "node:fs";
import { resolveCouncilkitHome } from "@shared/runtime/cli-home";
import {
  type RepairSeat,
  REPAIR_ROLE_SWAP_LIMIT,
  applyRepairRoleUpdates,
  readSquadBridgeFile,
  readSquadBridgeObject,
  resolveRepairRoles,
  writeSquadBridgeFile,
} from "@shared/runtime/squad-repair-runtime";
import { errors } from "../errors";
import type { OutputSink } from "../output";
import { parseFlags } from "./parse";

const SEAT_FLAGS: Array<{ flag: string; seat: RepairSeat }> = [
  { flag: "orchestrator", seat: "orchestrator" },
  { flag: "planner-b", seat: "planner_b" },
  { flag: "reviewer", seat: "reviewer" },
  { flag: "verifier", seat: "verifier" },
];

export async function runRepairRoles(argv: string[], out: OutputSink): Promise<void> {
  const action = argv[0];
  if (action === "show") return showRepairRoles(out);
  if (action === "set") return setRepairRoles(argv.slice(1), out);
  if (action === "reset") return resetRepairRoles(out);
  throw errors.usage(
    action === undefined
      ? "repair roles requires show, set, or reset"
      : `unknown repair roles action "${action}" (show|set|reset)`,
  );
}

async function showRepairRoles(out: OutputSink): Promise<void> {
  const loaded = readSquadBridgeFile(process.env);
  if (loaded.reason) throw errors.usage(loaded.reason);
  const resolved = resolveRepairRoles({
    orchestratorRuntime: loaded.file.orchestratorRuntime,
    cursorModel: process.env.COUNCILKIT_CURSOR_MODEL ?? loaded.file.model,
    roles: loaded.file.roles,
  });
  if (!resolved.ok) throw errors.usage(resolved.reason);
  await out.finish(
    {
      path: `${resolveCouncilkitHome(process.env)}/squad-bridge.json`,
      orchestratorRuntime: resolved.orchestratorRuntime,
      orchestratorModel: resolved.orchestratorModel,
      roles: resolved.roles,
      limit: REPAIR_ROLE_SWAP_LIMIT,
    },
    (data) => {
      const row = data as {
        roles: Record<string, { runtime: string; model: string }>;
        limit: string;
      };
      const lines = Object.entries(row.roles).map(
        ([seat, role]) => `${seat}: ${role.runtime}:${role.model}`,
      );
      return `${lines.join("\n")}\n\n${row.limit}\n`;
    },
  );
}

async function setRepairRoles(argv: string[], out: OutputSink): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        orchestrator: { type: "string" },
        "planner-b": { type: "string" },
        reviewer: { type: "string" },
        verifier: { type: "string" },
      },
      allowPositionals: 0,
    },
    argv,
  );
  const updates: Partial<Record<RepairSeat, { runtime: string; model: string }>> = {};
  for (const { flag, seat } of SEAT_FLAGS) {
    const raw = values[flag];
    if (typeof raw !== "string") continue;
    updates[seat] = parseSeatSpec(seat, raw);
  }
  if (Object.keys(updates).length === 0) {
    throw errors.usage(
      "repair roles set 需要至少一个席位，例如 --reviewer codex:gpt-5.6-sol 或 --reviewer cursor:composer-2.5",
    );
  }
  mkdirSync(resolveCouncilkitHome(process.env), { recursive: true, mode: 0o700 });
  const current = readSquadBridgeObject(process.env);
  const applied = applyRepairRoleUpdates(current, updates);
  if (!applied.ok) throw errors.usage(applied.reason);
  const path = writeSquadBridgeFile(process.env, applied.file);
  await out.finish(
    {
      path,
      roles: applied.resolved.roles,
      limit: REPAIR_ROLE_SWAP_LIMIT,
    },
    () => `已写入 ${path}\n${REPAIR_ROLE_SWAP_LIMIT}\n`,
  );
}

async function resetRepairRoles(out: OutputSink): Promise<void> {
  mkdirSync(resolveCouncilkitHome(process.env), { recursive: true, mode: 0o700 });
  const current = readSquadBridgeObject(process.env);
  delete current.roles;
  delete current.model;
  const path = writeSquadBridgeFile(process.env, current);
  const loaded = readSquadBridgeFile(process.env);
  const resolved = resolveRepairRoles({
    orchestratorRuntime: loaded.file.orchestratorRuntime,
    roles: loaded.file.roles,
  });
  if (!resolved.ok) throw errors.usage(resolved.reason);
  await out.finish({ path, roles: resolved.roles, limit: REPAIR_ROLE_SWAP_LIMIT }, () => {
    return `已清除席位覆盖 ${path}\n${REPAIR_ROLE_SWAP_LIMIT}\n`;
  });
}

function parseSeatSpec(seat: RepairSeat, spec: string): { runtime: string; model: string } {
  const index = spec.indexOf(":");
  if (index <= 0 || index === spec.length - 1) {
    throw errors.usage(`${seat} 的格式是 runtime:model，例如 cursor:composer-2.5 或 codex:gpt-5.6-sol`);
  }
  return { runtime: spec.slice(0, index).trim(), model: spec.slice(index + 1).trim() };
}
