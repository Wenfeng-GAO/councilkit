/**
 * Read-only index of CLI runs under COUNCILKIT_HOME/runs.
 *
 * Used by `councilkit runs list|open` and by the Host GET /api/v1/cli-runs
 * surface so the browser can open the same report.md the CLI wrote.
 *
 * Safety: never follow symlinks; runId is a closed token; a single corrupt
 * directory is skipped on list (detail of a bad id is not-found).
 */
import { createHash } from "node:crypto";
import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
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
  CLI_RUN_PIPELINE_PID_FILE,
  CLI_RUN_STATUS_FILE,
  type CliRunLiveStatus,
  type CliRunPipeline,
  type CliRunProgress,
  liveStateFromRecords,
  mapSquadObserveStatus,
  mergeLiveProgress,
  parseLiveStateJson,
  reconcileRunningStatus,
} from "./cli-run-progress";
import { CANONICAL_ORIGIN } from "./contracts";
import {
  FINDING_GROUPS_FILE,
  type FindingGroupsFile,
  findingGroupsFileSchema,
  validateFindingGroups,
} from "./finding-groups";
import { type ReviewEvidence, summarizeReviewEvidence } from "./review-case";
import {
  ASSESSMENT_DIAGNOSTICS_FILE,
  assessmentDiagnosticsFileSchema,
} from "./reviewer-assessment";
import {
  type CliRunDocumentDto,
  type CliRunHandoffDto,
  type IdeateIntegrityDto,
  ideateIntegritySchema,
} from "./schemas";

export type { CliRunAttemptProgress, CliRunPipeline, CliRunProgress } from "./cli-run-progress";
export { CLI_RUN_STATUS_FILE, liveStateFromRecords } from "./cli-run-progress";

export const CLI_RUN_PLAN_FILE = "plan.md";
export { CLI_RUN_FINDINGS_FILE, CLI_RUN_LANDINGS_FILE, CLI_RUN_PLAN_LOCK_FILE };

const SQUAD_DOCUMENT_SPECS = [
  { file: "brief.md", id: "brief", title: "简报" },
  { file: "request.md", id: "request", title: "需求" },
  { file: "plan.md", id: "plan", title: "方案" },
  { file: "decisions.md", id: "decisions", title: "裁决" },
  { file: "reviews.md", id: "reviews", title: "评审" },
  { file: "final.md", id: "final", title: "收工摘要" },
] as const;

export const CLI_RUN_ID_RE =
  /^ck-(?:run|review|squad|ideate|repair)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_CLI_REPORT_BYTES = 2 * 1024 * 1024;

export type CliRunKind = "review" | "discuss" | "squad" | "ideate" | "repair" | "unknown";
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
  reviewEvidence?: ReviewEvidence | null;
  ideateIntegrity?: IdeateIntegrityDto | null;
  businessResult?: "approved" | "needs_attention" | "stopped" | null;
  reasonCode?: string | null;
  sourceRunId?: string | null;
  lastError?: string | null;
  outerUsed?: number;
  outerMax?: number;
  resumeEligible?: boolean;
}

export interface CliRunDetail extends CliRunSummary {
  markdown: string;
  truncated: boolean;
  planMarkdown: string;
  planTruncated: boolean;
  findings: LedgerFinding[];
  planLock: PlanLockFile | null;
  landings: LandingRecord[];
  documents: CliRunDocumentDto[];
  findingGroups: FindingGroupsFile | null;
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
  const findingsPath = join(root, runId, CLI_RUN_FINDINGS_FILE);
  const findingsText = readFindingsText(findingsPath);
  const findings = findingsText ? parseFindingsFile(findingsText) : null;
  const planLock = readPlanLock(join(root, runId, CLI_RUN_PLAN_LOCK_FILE));
  const landings = readLandings(join(root, runId, CLI_RUN_LANDINGS_FILE));
  const documents = summary.kind === "squad" ? readSquadDocuments(join(root, runId)) : [];
  const groupsRead = readOptionalFindingGroups(
    join(root, runId, FINDING_GROUPS_FILE),
    findings,
    findingsText,
  );
  return {
    ...summary,
    markdown: report.text,
    truncated: report.truncated,
    planMarkdown: plan.text,
    planTruncated: plan.truncated,
    findings: findings?.findings ?? [],
    planLock,
    landings,
    documents,
    findingGroups: groupsRead.groups,
    reviewEvidence:
      summary.reviewEvidence && groupsRead.invalid
        ? { ...summary.reviewEvidence, evidenceComplete: false }
        : summary.reviewEvidence,
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
  const tailText = readCapped(transcriptPath, 64 * 1024, true).text;
  const parsed = parseTranscriptMeta(`${transcriptText}\n${tailText}`, runId);
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

  const rawStatus = live?.status ?? parsed.status;
  const reconciled =
    live?.status === "running"
      ? reconcileRunningStatus({
          status: live.status,
          kind: parsed.kind,
          updatedAt: live.progress?.updatedAt ?? derived?.updatedAt ?? null,
          pid: readPipelinePid(dir),
        })
      : rawStatus;
  const status = mapSquadObserveStatus({
    kind: parsed.kind,
    status: reconciled,
    progress: derived,
  });
  const pipeline =
    reconciled === "failed" &&
    rawStatus === "running" &&
    live?.pipeline &&
    live.pipeline.phase !== "done"
      ? { ...live.pipeline, phase: "done" as const }
      : (live?.pipeline ?? null);
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
    pipeline,
    handoff: live?.handoff ?? null,
    reviewEvidence:
      parsed.kind === "review" ? readReviewEvidence(dir, runId, transcriptText) : null,
    ideateIntegrity: parsed.kind === "ideate" ? parsed.ideateIntegrity : null,
    ...readRepairProjection(dir, parsed.kind),
  };
}

function readRepairProjection(
  dir: string,
  kind: CliRunKind,
): Pick<
  CliRunSummary,
  | "businessResult"
  | "reasonCode"
  | "sourceRunId"
  | "lastError"
  | "outerUsed"
  | "outerMax"
  | "resumeEligible"
> {
  if (kind !== "repair") return {};
  try {
    const rec = JSON.parse(readCapped(join(dir, "repair.json"), 64 * 1024).text) as Record<
      string,
      unknown
    >;
    const business =
      rec.businessResult === "approved" ||
      rec.businessResult === "needs_attention" ||
      rec.businessResult === "stopped"
        ? rec.businessResult
        : null;
    const outerUsed = typeof rec.outerUsed === "number" ? rec.outerUsed : 0;
    const outerMax = typeof rec.outerMax === "number" ? rec.outerMax : 10;
    const grantId = typeof rec.grantId === "string" ? rec.grantId : null;
    return {
      businessResult: business,
      reasonCode: typeof rec.reasonCode === "string" ? rec.reasonCode : null,
      sourceRunId: typeof rec.sourceRunId === "string" ? rec.sourceRunId : null,
      lastError: typeof rec.lastError === "string" ? rec.lastError : null,
      outerUsed,
      outerMax,
      resumeEligible:
        business === "needs_attention" &&
        outerUsed < outerMax &&
        (Boolean(grantId) || outerUsed === 0),
    };
  } catch {
    return {
      businessResult: null,
      reasonCode: null,
      sourceRunId: null,
      lastError: null,
      resumeEligible: false,
    };
  }
}

function readPipelinePid(dir: string): number | null {
  const path = join(dir, CLI_RUN_PIPELINE_PID_FILE);
  const stat = safeLstat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  const raw = readCapped(path, 32).text.trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readFindingsText(path: string): string | null {
  const stat = safeLstat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  const { text, truncated } = readCapped(path, 512 * 1024);
  if (truncated) return text;
  return text;
}

function readFindings(path: string): FindingsFile | null {
  const text = readFindingsText(path);
  return text ? parseFindingsFile(text) : null;
}

function readOptionalFindingGroups(
  path: string,
  findings: FindingsFile | null,
  findingsText: string | null,
): { groups: FindingGroupsFile | null; invalid: boolean } {
  const stat = safeLstat(path);
  if (stat === null) return { groups: null, invalid: false };
  if (!stat.isFile() || stat.isSymbolicLink()) return { groups: null, invalid: true };
  try {
    const parsed = findingGroupsFileSchema.safeParse(JSON.parse(readCapped(path, 256 * 1024).text));
    if (!parsed.success) return { groups: null, invalid: true };
    const groups = parsed.data;
    if (findings && groups.source.runId !== findings.runId) {
      return { groups: null, invalid: true };
    }
    if (findings?.sha && groups.source.sha !== findings.sha.toLowerCase()) {
      return { groups: null, invalid: true };
    }
    if (
      findings?.againstRunId &&
      groups.source.againstRunId &&
      groups.source.againstRunId !== findings.againstRunId
    ) {
      return { groups: null, invalid: true };
    }
    if (findingsText) {
      const actual = createHash("sha256").update(findingsText, "utf8").digest("hex");
      if (actual !== groups.source.findingsSha256) return { groups: null, invalid: true };
    }
    validateFindingGroups(
      groups,
      findings ? new Set(findings.findings.map((row) => row.id)) : undefined,
    );
    return { groups, invalid: false };
  } catch {
    return { groups: null, invalid: true };
  }
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

function readSquadDocuments(dir: string): CliRunDocumentDto[] {
  const documents: CliRunDocumentDto[] = [];
  for (const spec of SQUAD_DOCUMENT_SPECS) {
    const path = join(dir, spec.file);
    const stat = safeLstat(path);
    if (stat === null || !stat.isFile() || stat.isSymbolicLink()) continue;
    const { text, truncated } = readCapped(path, MAX_CLI_REPORT_BYTES);
    if (text.trim().length === 0) continue;
    documents.push({
      id: spec.id,
      title: spec.title,
      markdown: text,
      truncated,
    });
  }
  return documents;
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
  incomplete: boolean | null;
  ideateIntegrity: IdeateIntegrityDto | null;
} {
  let kind: CliRunKind = runId.startsWith("ck-review-")
    ? "review"
    : runId.startsWith("ck-run-")
      ? "discuss"
      : runId.startsWith("ck-squad-")
        ? "squad"
        : runId.startsWith("ck-ideate-")
          ? "ideate"
          : runId.startsWith("ck-repair-")
            ? "repair"
            : "unknown";
  let status: CliRunStatus = "unknown";
  let title = runId;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let incomplete: boolean | null = null;
  let ideateIntegrity: IdeateIntegrityDto | null = null;

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
    if (recKind === "ideate.started") {
      kind = "ideate";
      startedAt = stringOrNull(row.startedAt) ?? startedAt;
      title = stringOrNull(row.idea) ?? title;
    } else if (recKind === "ideate.finished") {
      const st = stringOrNull(row.status);
      if (st === "completed" || st === "failed" || st === "interrupted") status = st;
      endedAt = stringOrNull(row.endedAt) ?? endedAt;
      if (typeof row.incomplete === "boolean") incomplete = row.incomplete;
      const parsedIntegrity = ideateIntegritySchema.safeParse(row.integrity);
      if (parsedIntegrity.success) {
        ideateIntegrity = parsedIntegrity.data;
        incomplete = parsedIntegrity.data.incomplete;
      }
    } else if (recKind === "review.started") {
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
  return { kind, status, title, startedAt, endedAt, incomplete, ideateIntegrity };
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

/** Bound actual IO, including the transcript tail used to establish completion. */
function readCapped(
  path: string,
  maxBytes: number,
  tail = false,
): { text: string; truncated: boolean } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: "", truncated: false };
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const count = readSync(fd, buffer, 0, length, tail ? Math.max(0, stat.size - length) : 0);
    return { text: buffer.subarray(0, count).toString("utf8"), truncated: stat.size > maxBytes };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readReviewEvidence(dir: string, runId: string, head: string): ReviewEvidence {
  const started = parseTranscriptRecords(head).find(
    (record) =>
      record !== null &&
      typeof record === "object" &&
      "kind" in record &&
      record.kind === "review.started",
  ) as { runId?: string; task?: { pr?: string; against?: string } } | undefined;
  const tail = readCapped(join(dir, "transcript.jsonl"), 64 * 1024, true).text.trim();
  let complete = false;
  try {
    const last = JSON.parse(tail.split("\n").at(-1) ?? "") as Record<string, unknown>;
    complete =
      started?.runId === runId &&
      last.kind === "review.finished" &&
      last.status === "completed" &&
      last.incomplete === false &&
      !last.failure;
  } catch {
    /* Missing/corrupt terminal evidence stays incomplete. */
  }
  const coverage = readAssessmentCoverage(join(dir, ASSESSMENT_DIAGNOSTICS_FILE));
  return summarizeReviewEvidence({
    runId,
    complete,
    prUrl: started?.task?.pr ?? null,
    againstRunId: started?.task?.against ?? null,
    ledger: readFindings(join(dir, CLI_RUN_FINDINGS_FILE)),
    evidenceComplete: coverage?.complete,
    uncoveredIds: coverage?.uncoveredIds,
  });
}

function readAssessmentCoverage(
  path: string,
): { complete: boolean; uncoveredIds: string[] } | undefined {
  const stat = safeLstat(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return undefined;
  try {
    const parsed = assessmentDiagnosticsFileSchema.safeParse(
      JSON.parse(readCapped(path, 256 * 1024).text),
    );
    if (!parsed.success) return { complete: false, uncoveredIds: [] };
    const uncovered = [
      ...new Set(
        parsed.data.items
          .filter(
            (item) =>
              (item.status === "missing" || item.status === "semantic_mismatch") && item.findingId,
          )
          .map((item) => item.findingId as string),
      ),
    ];
    return { complete: parsed.data.coverageComplete, uncoveredIds: uncovered };
  } catch {
    return { complete: false, uncoveredIds: [] };
  }
}
