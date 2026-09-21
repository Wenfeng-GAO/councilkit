import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export const SQUAD_HISTORY_BRIDGE_CONTRACT = "squad-history-bridge.v1";

export const HISTORY_BRIDGE_UPGRADE_MESSAGE =
  "squadctl 未提供 squad-history-bridge.v1（history capabilities 的 export/verified_origin_mapping/persisted_origins）。请升级 hengzhuo-engineering-squad 后再跑跨 outer-cycle 自动修复。";

export interface SquadHistoryCapabilities {
  schema_version: 1;
  contract: typeof SQUAD_HISTORY_BRIDGE_CONTRACT;
  export: true;
  verified_origin_mapping: true;
  persisted_origins: true;
}

export interface SquadHistoryOrigin {
  task_id: string;
  task_dir: string;
  journal_hash: string;
  package_hash: string;
}

export interface SquadHistoryEnvelope {
  schema_version: 1;
  contract: typeof SQUAD_HISTORY_BRIDGE_CONTRACT;
  complete: true;
  history: {
    schema_version: 1;
    kind: "squad-repair-history";
    project_id: string;
    repair_chain_id: string;
    source_hash: string;
    entries: Array<{
      task_id: string;
      ancestor_task_ids: string[];
      journal_hash: string;
      package_hash: string;
      package_raw_hash?: string;
      logical_rounds: unknown[];
    }>;
  };
  origins: SquadHistoryOrigin[];
}

export interface AllowedHistoryOrigin {
  journalTaskId: string;
  taskDir: string;
}

export function parseHistoryCapabilities(raw: unknown): SquadHistoryCapabilities | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.schema_version !== 1) return null;
  if (row.contract !== SQUAD_HISTORY_BRIDGE_CONTRACT) return null;
  if (row.export !== true) return null;
  if (row.verified_origin_mapping !== true) return null;
  if (row.persisted_origins !== true) return null;
  return {
    schema_version: 1,
    contract: SQUAD_HISTORY_BRIDGE_CONTRACT,
    export: true,
    verified_origin_mapping: true,
    persisted_origins: true,
  };
}

export function parseHistoryEnvelope(raw: unknown): SquadHistoryEnvelope | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.schema_version !== 1) return null;
  if (row.contract !== SQUAD_HISTORY_BRIDGE_CONTRACT) return null;
  if (row.complete !== true) return null;
  const history = row.history;
  if (history === null || typeof history !== "object" || Array.isArray(history)) return null;
  const hist = history as Record<string, unknown>;
  if (hist.schema_version !== 1 || hist.kind !== "squad-repair-history") return null;
  if (typeof hist.project_id !== "string" || hist.project_id.length === 0) return null;
  if (typeof hist.repair_chain_id !== "string" || hist.repair_chain_id.length === 0) return null;
  if (typeof hist.source_hash !== "string" || !/^[a-f0-9]{64}$/.test(hist.source_hash)) return null;
  if (!Array.isArray(hist.entries)) return null;
  const entries: SquadHistoryEnvelope["history"]["entries"] = [];
  for (const item of hist.entries) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.task_id !== "string" || entry.task_id.length === 0) return null;
    if (!Array.isArray(entry.ancestor_task_ids)) return null;
    if (typeof entry.journal_hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.journal_hash)) {
      return null;
    }
    if (typeof entry.package_hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.package_hash)) {
      return null;
    }
    if (!Array.isArray(entry.logical_rounds)) return null;
    entries.push({
      task_id: entry.task_id,
      ancestor_task_ids: entry.ancestor_task_ids.filter(
        (id): id is string => typeof id === "string",
      ),
      journal_hash: entry.journal_hash,
      package_hash: entry.package_hash,
      package_raw_hash:
        typeof entry.package_raw_hash === "string" ? entry.package_raw_hash : undefined,
      logical_rounds: entry.logical_rounds,
    });
  }
  if (!Array.isArray(row.origins) || row.origins.length === 0) return null;
  const origins: SquadHistoryOrigin[] = [];
  for (const item of row.origins) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const origin = item as Record<string, unknown>;
    if (typeof origin.task_id !== "string" || origin.task_id.length === 0) return null;
    if (typeof origin.task_dir !== "string" || !origin.task_dir.startsWith("/")) return null;
    if (typeof origin.journal_hash !== "string" || !/^[a-f0-9]{64}$/.test(origin.journal_hash)) {
      return null;
    }
    if (typeof origin.package_hash !== "string" || !/^[a-f0-9]{64}$/.test(origin.package_hash)) {
      return null;
    }
    origins.push({
      task_id: origin.task_id,
      task_dir: origin.task_dir,
      journal_hash: origin.journal_hash,
      package_hash: origin.package_hash,
    });
  }
  return {
    schema_version: 1,
    contract: SQUAD_HISTORY_BRIDGE_CONTRACT,
    complete: true,
    history: {
      schema_version: 1,
      kind: "squad-repair-history",
      project_id: hist.project_id,
      repair_chain_id: hist.repair_chain_id,
      source_hash: hist.source_hash,
      entries,
    },
    origins,
  };
}

export function historyEnvelopeHash(envelope: SquadHistoryEnvelope): string {
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

export function canonicalOwnedDir(path: string, ownedRoot: string): string | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return null;
    const real = realpathSync(path);
    const root = realpathSync(ownedRoot);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return real;
  } catch {
    return null;
  }
}

export function assertHistoryOriginsOwned(
  envelope: SquadHistoryEnvelope,
  allowed: AllowedHistoryOrigin[],
  ownedRoot: string,
  expected: { projectId: string; repairChainId: string },
): { ok: true } | { ok: false; reason: string } {
  if (envelope.history.project_id !== expected.projectId) {
    return { ok: false, reason: "exported history project_id does not match the frozen repo" };
  }
  if (envelope.history.repair_chain_id !== expected.repairChainId) {
    return { ok: false, reason: "exported history repair_chain_id does not match the parent run" };
  }
  const allowedById = new Map(
    allowed.map((row) => [row.journalTaskId, canonicalOwnedDir(row.taskDir, ownedRoot)]),
  );
  for (const origin of envelope.origins) {
    const allowedDir = allowedById.get(origin.task_id);
    const actual = canonicalOwnedDir(origin.task_dir, ownedRoot);
    if (!allowedDir || !actual) {
      return {
        ok: false,
        reason: `history origin ${origin.task_id} is outside the parent task set`,
      };
    }
    if (resolve(allowedDir) !== resolve(actual)) {
      return {
        ok: false,
        reason: `history origin ${origin.task_id} directory does not match the frozen task`,
      };
    }
  }
  return { ok: true };
}
