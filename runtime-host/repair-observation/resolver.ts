/**
 * Resolve trusted observation sources from a validated parent repair run.
 * Never scans sibling tasks, candidate .squad, or arbitrary query paths.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { resolveCliRunsRoot, resolveCouncilkitHome } from "@shared/runtime/cli-home";
import { isCliRunId } from "@shared/runtime/cli-runs-index";

export type TrustedSourceKind = "orchestrator_log" | "adapter_meta" | "child_review_live" | "evidence";

export type TrustedSource = {
  sourceId: string;
  kind: TrustedSourceKind;
  path: string;
  round: number;
  roleKey: string;
  executionRef: string;
  planned: boolean;
};

export type RepairStateLite = {
  sourceRunId: string;
  latestReviewId?: string | null;
  businessResult: "approved" | "needs_attention" | "stopped" | null;
  reasonCode: string | null;
  candidateSha?: string | null;
  frozenBaseSha?: string | null;
  goalSummary?: string | null;
  resumeEligible?: boolean | null;
  protocolVersion?: "v1" | "v2" | null;
  outerUsed?: number;
  outerMax?: number;
  budget?: {
    sourceFixUsed?: number;
    sourceFixMax?: number;
    tokenUsed?: number | null;
  };
  cycles?: Array<{
    n: number;
    phase: string;
    childReviewId?: string | null;
    squadTaskId?: string | null;
    squadTaskDir?: string | null;
  }>;
  executions?: Array<{
    executionId: string;
    kind: string;
    state: string;
    pids: number[];
    startedAtMs: number | null;
    endedAtMs: number | null;
  }>;
};

export type ResolveResult = {
  state: RepairStateLite | null;
  sources: TrustedSource[];
  reasons: string[];
  availability: "available" | "partial" | "unavailable";
  currentRound: number;
};

function safeLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Path must resolve under an allowed root as a regular file (no symlink escape). */
export function assertTrustedPath(
  candidate: string,
  allowedRoots: string[],
): { ok: true; path: string } | { ok: false; reason: string } {
  if (candidate.includes("\0")) return { ok: false, reason: "nul in path" };
  // Reject traversal segments before normalization so sibling tasks cannot be
  // smuggled via `task/../sibling`.
  const segments = candidate.split(/[/\\]/);
  if (segments.some((seg) => seg === "..")) {
    return { ok: false, reason: "path traversal rejected" };
  }
  if (!isAbsolute(candidate) && candidate.includes("..")) {
    return { ok: false, reason: "path traversal rejected" };
  }
  const resolved = resolve(candidate);
  const rootOk = allowedRoots.some((root) => {
    const r = resolve(root);
    return resolved === r || resolved.startsWith(r + sep);
  });
  if (!rootOk) return { ok: false, reason: "path outside trusted roots" };
  const st = safeLstat(resolved);
  if (st === null) return { ok: false, reason: "path missing" };
  if (st.isSymbolicLink()) return { ok: false, reason: "symlink rejected" };
  if (!st.isFile() && !st.isDirectory()) return { ok: false, reason: "not a regular path" };
  // Reject if any parent segment is a symlink escaping the root.
  let cursor = resolved;
  while (cursor !== dirnameSafe(cursor)) {
    const link = safeLstat(cursor);
    if (link?.isSymbolicLink()) return { ok: false, reason: "symlink parent rejected" };
    const parent = dirnameSafe(cursor);
    if (parent === cursor) break;
    cursor = parent;
    const stillInside = allowedRoots.some((root) => {
      const r = resolve(root);
      return cursor === r || cursor.startsWith(r + sep) || r.startsWith(cursor + sep);
    });
    if (!stillInside) break;
  }
  return { ok: true, path: resolved };
}

function dirnameSafe(path: string): string {
  const idx = path.lastIndexOf(sep);
  if (idx <= 0) return path;
  return path.slice(0, idx) || sep;
}

export function readRepairStateLite(runId: string, env: NodeJS.ProcessEnv = process.env): RepairStateLite | null {
  if (!isCliRunId(runId) || !runId.startsWith("ck-repair-")) return null;
  const path = join(resolveCliRunsRoot(env), runId, "repair.json");
  const check = assertTrustedPath(path, [resolveCliRunsRoot(env)]);
  if (!check.ok) return null;
  try {
    const text = readFileSync(check.path, "utf8");
    const parsed = JSON.parse(text) as RepairStateLite;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.sourceRunId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function resolveTrustedSources(
  runId: string,
  round: number | "current",
  env: NodeJS.ProcessEnv = process.env,
): ResolveResult {
  const reasons: string[] = [];
  const state = readRepairStateLite(runId, env);
  if (!state) {
    return {
      state: null,
      sources: [],
      reasons: ["repair state missing"],
      availability: "unavailable",
      currentRound: 1,
    };
  }
  const cycles = state.cycles ?? [];
  const currentRound = cycles.reduce((max, c) => Math.max(max, c.n), cycles.length > 0 ? 1 : 1);
  const targetRound = round === "current" ? currentRound : round;
  const home = resolveCouncilkitHome(env);
  const runsRoot = resolveCliRunsRoot(env);
  const squadTasksRoot = join(home, "squad-tasks");
  const allowedRoots = [runsRoot, squadTasksRoot, join(home, "observation-cache")];
  const sources: TrustedSource[] = [];

  for (const cycle of cycles) {
    if (cycle.n !== targetRound) continue;
    if (cycle.squadTaskDir) {
      const taskCheck = assertTrustedPath(cycle.squadTaskDir, [squadTasksRoot, home]);
      if (!taskCheck.ok) {
        reasons.push(`squadTaskDir rejected: ${taskCheck.reason}`);
      } else {
        const logPath = join(taskCheck.path, "orchestrator.log");
        const logCheck = assertTrustedPath(logPath, allowedRoots);
        if (logCheck.ok) {
          sources.push({
            sourceId: `orch:${cycle.n}:${cycle.squadTaskId ?? "task"}`,
            kind: "orchestrator_log",
            path: logCheck.path,
            round: cycle.n,
            roleKey: "builder",
            executionRef: `squad:${cycle.squadTaskId ?? cycle.n}#1.1`,
            planned: true,
          });
        } else if (existsSync(logPath)) {
          reasons.push(`orchestrator.log unreadable: ${logCheck.reason}`);
        }

        const metaCandidates = ["process-heartbeat.json", "adapter-meta.json", "councilkit-bridge.json"];
        for (const metaName of metaCandidates) {
          const metaPath = join(taskCheck.path, metaName);
          const metaCheck = assertTrustedPath(metaPath, allowedRoots);
          if (!metaCheck.ok) continue;
          sources.push({
            sourceId: `meta:${cycle.n}:${cycle.squadTaskId ?? "task"}:${metaName}`,
            kind: "adapter_meta",
            path: metaCheck.path,
            round: cycle.n,
            roleKey: "builder",
            executionRef: `squad:${cycle.squadTaskId ?? cycle.n}#1.1`,
            planned: true,
          });
          break;
        }

        // Per-role JSONL under the registered task dir only.
        for (const role of ["orchestrator", "planner_a", "planner_b", "coder", "reviewer", "verifier"] as const) {
          const roleFiles = [`${role}.jsonl`, `${role}.session.jsonl`, join("adapter-runs", role, "events.jsonl")];
          for (const rel of roleFiles) {
            const roleLog = join(taskCheck.path, rel);
            const roleCheck = assertTrustedPath(roleLog, allowedRoots);
            if (!roleCheck.ok) continue;
            const grouped = role === "orchestrator" || role === "planner_a" || role === "coder";
            sources.push({
              sourceId: `role:${cycle.n}:${role}:${rel}`,
              kind: "orchestrator_log",
              path: roleCheck.path,
              round: cycle.n,
              roleKey: grouped ? "builder" : role,
              executionRef: grouped
                ? `squad:${cycle.squadTaskId ?? cycle.n}#1.1`
                : `squad:${cycle.squadTaskId ?? cycle.n}:${role}#1.1`,
              planned: true,
            });
          }
        }
      }
    }

    // Current-cycle child review only — never treat sourceRunId as this round's execution.
    if (cycle.childReviewId && isCliRunId(cycle.childReviewId)) {
      sources.push({
        sourceId: `child:${cycle.childReviewId}:group`,
        kind: "child_review_live",
        path: join(runsRoot, cycle.childReviewId, "report.md"),
        round: cycle.n,
        roleKey: "final_review",
        executionRef: `${cycle.childReviewId}#1.1`,
        planned: true,
      });
      const liveDir = join(runsRoot, cycle.childReviewId, "live");
      const liveCheck = assertTrustedPath(liveDir, [runsRoot]);
      if (liveCheck.ok) {
        try {
          for (const name of readdirSync(liveCheck.path)) {
            if (!name.endsWith(".jsonl")) continue;
            const filePath = join(liveCheck.path, name);
            const fileCheck = assertTrustedPath(filePath, [runsRoot]);
            if (!fileCheck.ok) continue;
            const attemptId = name.replace(/\.jsonl$/, "");
            sources.push({
              sourceId: `child:${cycle.childReviewId}:${attemptId}`,
              kind: "child_review_live",
              path: fileCheck.path,
              round: cycle.n,
              roleKey: "final_review",
              executionRef: `${cycle.childReviewId}#${attemptId}`,
              planned: true,
            });
          }
        } catch {
          reasons.push("child review live directory unreadable");
        }
      } else {
        sources.push({
          sourceId: `child:${cycle.childReviewId}:group`,
          kind: "child_review_live",
          path: join(runsRoot, cycle.childReviewId, "live", "missing.jsonl"),
          round: cycle.n,
          roleKey: "final_review",
          executionRef: `${cycle.childReviewId}#1.1`,
          planned: true,
        });
        reasons.push("终验复审来源未挂上");
      }
    }

    if (cycle.squadTaskDir) {
      const acceptancePath = join(cycle.squadTaskDir, "evidence", "acceptance.json");
      const acceptanceCheck = assertTrustedPath(acceptancePath, [squadTasksRoot, home]);
      if (acceptanceCheck.ok) {
        sources.push({
          sourceId: `evidence:${cycle.n}:acceptance`,
          kind: "evidence",
          path: acceptanceCheck.path,
          round: cycle.n,
          roleKey: "final_review",
          executionRef: `evidence:${cycle.n}`,
          planned: true,
        });
      }
    }

    const evidencePath = join(runsRoot, runId, `evidence-round-${cycle.n}.json`);
    const evidenceCheck = assertTrustedPath(evidencePath, [runsRoot]);
    if (evidenceCheck.ok) {
      sources.push({
        sourceId: `evidence:${cycle.n}`,
        kind: "evidence",
        path: evidenceCheck.path,
        round: cycle.n,
        roleKey: "final_review",
        executionRef: `evidence:${cycle.n}`,
        planned: true,
      });
    }
  }

  const latestReviewId = state.latestReviewId;
  if (
    latestReviewId &&
    isCliRunId(latestReviewId) &&
    latestReviewId !== state.sourceRunId &&
    !sources.some((source) => source.roleKey === "final_review")
  ) {
    sources.push({
      sourceId: `child:${latestReviewId}:latest`,
      kind: "child_review_live",
      path: join(runsRoot, latestReviewId, "report.md"),
      round: currentRound,
      roleKey: "final_review",
      executionRef: `${latestReviewId}#1.1`,
      planned: true,
    });
  }

  // Explicitly never register sourceRunId live as current execution source.
  if (state.sourceRunId) {
    const sourceLive = join(runsRoot, state.sourceRunId, "live");
    if (existsSync(sourceLive)) {
      // Documented non-inclusion: baseline only.
      void relative(runsRoot, normalize(sourceLive));
    }
  }

  let availability: ResolveResult["availability"] = "available";
  if (sources.length === 0) {
    availability = reasons.length > 0 ? "partial" : "partial";
    if (!cycles.some((c) => c.n === targetRound && c.squadTaskDir)) {
      reasons.push(state.businessResult ? "仅有最终报告" : "等待首条记录");
    }
  } else if (reasons.length > 0) {
    availability = "partial";
  }

  return { state, sources, reasons, availability, currentRound };
}
