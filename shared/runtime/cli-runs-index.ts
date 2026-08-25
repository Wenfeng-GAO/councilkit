/**
 * Read-only index of CLI runs under COUNCILKIT_HOME/runs.
 *
 * Used by `councilkit runs list|open` and by the Host GET /api/v1/cli-runs
 * surface so the browser can open the same report.md the CLI wrote.
 *
 * Safety: never follow symlinks; runId is a closed token; a single corrupt
 * directory is skipped on list (detail of a bad id is not-found).
 */
import { type Stats, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveCliRunsRoot } from "./cli-home";
import {
  CLI_RUN_FINDINGS_FILE,
  CLI_RUN_LANDINGS_FILE,
  CLI_RUN_PLAN_LOCK_FILE,
  type FindingsFile,
  type LandingRecord,
  type LedgerFinding,
  type PlanLockFile,
  parseFindingsFile,
  parseLandingsText,
  parsePlanLockFile,
} from "./cli-ledger";
import {
  CLI_RUN_STATUS_FILE,
  type CliRunLiveStatus,
  type CliRunPipeline,
  type CliRunProgress,
  liveStateFromRecords,
  mapSquadObserveStatus,
  mergeLiveProgress,
  parseLiveStateJson,
} from "./cli-run-progress";
import { CANONICAL_ORIGIN } from "./contracts";
import type { CliRunHandoffDto } from "./schemas";

export type { CliRunAttemptProgress, CliRunPipeline, CliRunProgress } from "./cli-run-progress";
export { CLI_RUN_STATUS_FILE, liveStateFromRecords } from "./cli-run-progress";

export const CLI_RUN_PLAN_FILE = "plan.md";
export { CLI_RUN_FINDINGS_FILE, CLI_RUN_LANDINGS_FILE, CLI_RUN_PLAN_LOCK_FILE };

export const CLI_RUN_ID_RE =
  /^ck-(?:run|review|squad)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_CLI_REPORT_BYTES = 2 * 1024 * 1024;

export type CliRunKind = "review" | "discuss" | "squad" | "unknown";
export type CliRunStatus = CliRunLiveStatus;

export interface CliRunSummary {
  runId: string;
  kind: CliRunKind;
  status: CliRunStatus;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  hasReport: boolean;
  hasPlan: boolean;
  hasFindings: boolean;
  hasPlanLock: boolean;
  reportUrl: string;
  progress: CliRunProgress | null;
  pipeline: CliRunPipeline | null;
  handoff: CliRunHandoffDto | null;
}

export interface CliRunDetail extends CliRunSummary {
  markdown: string;
  truncated: boolean;
  planMarkdown: string;
  planTruncated: boolean;
  findings: LedgerFinding[];
  planLock: PlanLockFile | null;
  landings: LandingRecord[];
}

export function isCliRunId(runId: string): boolean {
  return CLI_RUN_ID_RE.test(runId);
}

export function cliReportUrl(runId: string): string {
  return `${CANONICAL_ORIGIN}/reports/${runId}`;
}

export function listCliRuns(env: NodeJS.ProcessEnv = process.env): CliRunSummary[] {
  const root = resolveCliRunsRoot(env);
  const rootStat = safeLstat(root);
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }

  const runs: CliRunSummary[] = [];
  for (const name of names) {
    if (!isCliRunId(name)) continue;
    const summary = inspectRunDir(root, name);
    if (summary !== null) runs.push(summary);
  }
  runs.sort((a, b) => {
    const ta = a.startedAt ?? "";
    const tb = b.startedAt ?? "";
    if (ta === tb) return a.runId < b.runId ? 1 : -1;
    return ta < tb ? 1 : -1;
  });
  return runs;
}

export function readCliRun(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): CliRunDetail | null {
  if (!isCliRunId(runId)) return null;
  const root = resolveCliRunsRoot(env);
  const rootStat = safeLstat(root);
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const summary = inspectRunDir(root, runId);
  if (summary === null) return null;
  const reportPath = join(root, runId, "report.md");
  const reportStat = safeLstat(reportPath);
  const report =
    reportStat?.isFile() && !reportStat.isSymbolicLink()
      ? readCapped(reportPath, MAX_CLI_REPORT_BYTES)
      : { text: "", truncated: false };
  const planPath = join(root, runId, CLI_RUN_PLAN_FILE);
  const planStat = safeLstat(planPath);
  const plan =
    planStat?.isFile() && !planStat.isSymbolicLink()
      ? readCapped(planPath, MAX_CLI_REPORT_BYTES)
      : { text: "", truncated: false };
  const findings = readFindings(join(root, runId, CLI_RUN_FINDINGS_FILE));
  const planLock = readPlanLock(join(root, runId, CLI_RUN_PLAN_LOCK_FILE));
  const landings = readLandings(join(root, runId, CLI_RUN_LANDINGS_FILE));
  return {
    ...summary,
    markdown: report.text,
    truncated: report.truncated,
    planMarkdown: plan.text,
    planTruncated: plan.truncated,
    findings: findings?.findings ?? [],
    planLock,
    landings,
  };
}

function inspectRunDir(root: string, runId: string): CliRunSummary | null {
  const dir = join(root, runId);
  if (resolve(dir) !== resolve(root, runId)) return null;
  const dirStat = safeLstat(dir);
  if (dirStat === null || !dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;

  const reportPath = join(dir, "report.md");
  const reportStat = safeLstat(reportPath);
  const hasReport = Boolean(reportStat?.isFile() && !reportStat.isSymbolicLink());

  const transcriptPath = join(dir, "transcript.jsonl");
  const transcriptStat = safeLstat(transcriptPath);
  const transcriptText =
    transcriptStat?.isFile() && !transcriptStat.isSymbolicLink()
      ? readCapped(transcriptPath, 256 * 1024).text
      : "";
  const parsed = parseTranscriptMeta(transcriptText, runId);
  const live = readLiveState(join(dir, CLI_RUN_STATUS_FILE));
  const derived = mergeLiveProgress(
    live?.progress ?? null,
    liveStateFromRecords(parseTranscriptRecords(transcriptText), live?.progress.updatedAt ?? null)
      ?.progress ?? null,
  );
  const planPath = join(dir, CLI_RUN_PLAN_FILE);
  const planStat = safeLstat(planPath);
  const hasPlan = Boolean(planStat?.isFile() && !planStat.isSymbolicLink());
  const findingsPath = join(dir, CLI_RUN_FINDINGS_FILE);
  const findingsStat = safeLstat(findingsPath);
  const hasFindings = Boolean(findingsStat?.isFile() && !findingsStat.isSymbolicLink());
  const lockPath = join(dir, CLI_RUN_PLAN_LOCK_FILE);
  const lockStat = safeLstat(lockPath);
  const hasPlanLock = Boolean(lockStat?.isFile() && !lockStat.isSymbolicLink());

  const status = mapSquadObserveStatus({
    kind: parsed.kind,
    status: live?.status ?? parsed.status,
    progress: derived,
  });
  return {
    runId,
    kind: parsed.kind,
    status,
    title: parsed.title,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
    hasReport,
    hasPlan,
    hasFindings,
    hasPlanLock,
    reportUrl: cliReportUrl(runId),
    progress: derived,
    pipeline: live?.pipeline ?? null,
    handoff: live?.handoff ?? null,
  };
}

function readFindings(path: string): FindingsFile | null {
  const stat = safeLstat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  return parseFindingsFile(readCapped(path, 512 * 1024).text);
}

function readPlanLock(path: string): PlanLockFile | null {
  const stat = safeLstat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  return parsePlanLockFile(readCapped(path, 256 * 1024).text);
}

function readLandings(path: string): LandingRecord[] {
  const stat = safeLstat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return [];
  return parseLandingsText(readCapped(path, 256 * 1024).text);
}

function readLiveState(path: string): ReturnType<typeof parseLiveStateJson> {
  const stat = safeLstat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  const { text } = readCapped(path, 64 * 1024);
  return parseLiveStateJson(text);
}

function parseTranscriptRecords(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip a corrupt JSONL line
    }
  }
  return records;
}

export function parseTranscriptMeta(
  text: string,
  runId: string,
): {
  kind: CliRunKind;
  status: CliRunStatus;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
} {
  let kind: CliRunKind = runId.startsWith("ck-review-")
    ? "review"
    : runId.startsWith("ck-run-")
      ? "discuss"
      : runId.startsWith("ck-squad-")
        ? "squad"
        : "unknown";
  let status: CliRunStatus = "unknown";
  let title = runId;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec === null || typeof rec !== "object") continue;
    const row = rec as Record<string, unknown>;
    const recKind = typeof row.kind === "string" ? row.kind : "";
    if (recKind === "review.started") {
      kind = "review";
      startedAt = stringOrNull(row.startedAt) ?? startedAt;
      title = titleFromReviewTask(row.task) ?? title;
    } else if (recKind === "squad.started") {
      kind = "squad";
      startedAt = stringOrNull(row.startedAt) ?? startedAt;
      title = titleFromSquadTask(row.task) ?? title;
    } else if (recKind === "run.started") {
      kind = "discuss";
      startedAt = stringOrNull(row.startedAt) ?? startedAt;
      const council = row.council;
      if (council !== null && typeof council === "object") {
        const topic = stringOrNull((council as Record<string, unknown>).topic);
        if (topic) title = topic;
      }
    } else if (
      recKind === "review.finished" ||
      recKind === "run.finished" ||
      recKind === "squad.finished"
    ) {
      const st = stringOrNull(row.status);
      if (
        st === "completed" ||
        st === "failed" ||
        st === "interrupted" ||
        st === "awaiting_orchestrator" ||
        st === "closed"
      ) {
        status = st;
      }
      endedAt = stringOrNull(row.endedAt) ?? endedAt;
    }
  }
  if (status === "unknown" && startedAt !== null && endedAt === null) status = "running";
  return { kind, status, title, startedAt, endedAt };
}

function titleFromReviewTask(task: unknown): string | null {
  if (task === null || typeof task !== "object") return null;
  const t = task as Record<string, unknown>;
  return stringOrNull(t.pr) ?? stringOrNull(t.task) ?? stringOrNull(t.councilTopic);
}

function titleFromSquadTask(task: unknown): string | null {
  if (task === null || typeof task !== "object") return null;
  const t = task as Record<string, unknown>;
  return stringOrNull(t.taskId) ?? stringOrNull(t.task) ?? stringOrNull(t.slug);
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function readCapped(path: string, maxBytes: number): { text: string; truncated: boolean } {
  try {
    const buf = readFileSync(path);
    if (buf.byteLength <= maxBytes) return { text: buf.toString("utf8"), truncated: false };
    return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
  } catch {
    return { text: "", truncated: false };
  }
}
