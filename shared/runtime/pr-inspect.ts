import { usableRepairBranch } from "./repair-auth";

export type RepairHintSource = "pr" | "review" | "worktree";

export interface RepairBranchHints {
  sourceBranch: string | null;
  base: string | null;
}

export interface ResolvedRepairBranchHints extends RepairBranchHints {
  hintSource: RepairHintSource | null;
}

export function branchesFromGhPrView(json: unknown): RepairBranchHints {
  if (json === null || typeof json !== "object") return emptyHints();
  const row = json as Record<string, unknown>;
  return {
    sourceBranch: usableRepairBranch(typeof row.headRefName === "string" ? row.headRefName : ""),
    base: usableRepairBranch(typeof row.baseRefName === "string" ? row.baseRefName : ""),
  };
}

export function branchesFromAntCodePrShow(json: unknown): RepairBranchHints {
  if (json === null || typeof json !== "object") return emptyHints();
  const row = json as Record<string, unknown>;
  return {
    sourceBranch: usableRepairBranch(
      typeof row.source_branch === "string" ? row.source_branch : "",
    ),
    base: usableRepairBranch(typeof row.target_branch === "string" ? row.target_branch : ""),
  };
}

export function uniqueFeatureWorktreeBranch(porcelain: string): string | null {
  const names = [...new Set(namedWorktreeBranches(porcelain).filter(isFeatureWorktreeBranch))];
  return names.length === 1 ? (names[0] ?? null) : null;
}

export function mergeRepairBranchHints(
  layers: Array<RepairBranchHints & { source: RepairHintSource }>,
): ResolvedRepairBranchHints {
  let sourceBranch: string | null = null;
  let base: string | null = null;
  let sourceOrigin: RepairHintSource | null = null;
  let baseOrigin: RepairHintSource | null = null;
  for (const layer of layers) {
    if (sourceBranch === null && layer.sourceBranch) {
      sourceBranch = layer.sourceBranch;
      sourceOrigin = layer.source;
    }
    if (base === null && layer.base) {
      base = layer.base;
      baseOrigin = layer.source;
    }
  }
  const hintSource =
    sourceOrigin === "pr" || baseOrigin === "pr"
      ? "pr"
      : sourceOrigin === "review" || baseOrigin === "review"
        ? "review"
        : sourceOrigin === "worktree" || baseOrigin === "worktree"
          ? "worktree"
          : null;
  return { sourceBranch, base, hintSource };
}

function namedWorktreeBranches(porcelain: string): string[] {
  const names: string[] = [];
  for (const line of porcelain.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("branch refs/heads/")) continue;
    const name = trimmed.slice("branch refs/heads/".length).trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

function isFeatureWorktreeBranch(name: string): boolean {
  if (usableRepairBranch(name) === null) return false;
  const lower = name.toLowerCase();
  if (lower === "master" || lower === "main" || lower === "develop" || lower === "trunk") {
    return false;
  }
  if (lower.startsWith("sprint_") || lower.startsWith("squad/")) return false;
  return true;
}

function emptyHints(): RepairBranchHints {
  return { sourceBranch: null, base: null };
}
