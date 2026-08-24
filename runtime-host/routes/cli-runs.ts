/**
 * Session-authenticated read of the CLI run library, plus POST create-review
 * and POST actions that spawn the same-checkout `councilkit` CLI
 * (review / fix / re-review). The Host never writes agents/councils and never
 * runs review agents itself.
 */
import { randomUUID } from "node:crypto";
import { type Stats, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AttemptLiveEvent,
  CLI_RUN_ATTEMPT_ID_RE,
  parseAttemptLiveEventLine,
} from "@shared/runtime/attempt-live-events";
import { resolveCliRunsRoot, resolveCouncilkitHome } from "@shared/runtime/cli-home";
import { CLI_RUN_STATUS_FILE } from "@shared/runtime/cli-run-progress";
import { isCliRunId, listCliRuns, readCliRun } from "@shared/runtime/cli-runs-index";
import { makeError } from "@shared/runtime/errors";
import { parseApplyPrUrl, projectKeyFromPr } from "@shared/runtime/pr-url";
import {
  type CliRunActionResponse,
  type CliRunAttemptLiveResponse,
  type CliRunDetailResponse,
  type CliRunStartReviewRequest,
  type CliRunStartReviewResponse,
  type CliRunsListResponse,
  cliRunActionRequestSchema,
  cliRunActionResponseSchema,
  cliRunAttemptLiveResponseSchema,
  cliRunDetailResponseSchema,
  cliRunStartReviewRequestSchema,
  cliRunStartReviewResponseSchema,
  cliRunsListResponseSchema,
} from "@shared/runtime/schemas";
import { type CliRunLauncher, defaultCliRunLauncher, isPidAlive } from "../cli-launcher";
import { type HostServices, type Route, httpError } from "../server";

const PIPELINE_PID_FILE = "pipeline.pid";

export function cliRunsRoutes(services?: HostServices): Route[] {
  const launcher = resolveLauncher(services);
  return [
    {
      method: "GET",
      pattern: "/api/v1/cli-runs",
      auth: "session",
      responseSchema: cliRunsListResponseSchema,
      handler: (): CliRunsListResponse => ({ runs: listCliRuns(process.env) }),
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs",
      auth: "mutation",
      bodySchema: cliRunStartReviewRequestSchema,
      responseSchema: cliRunStartReviewResponseSchema,
      handler: async (ctx): Promise<CliRunStartReviewResponse> => {
        const body = ctx.body as CliRunStartReviewRequest;
        if (body.repo?.startsWith("-")) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "repo must be a filesystem path, not a flag.", {
              retryable: false,
            }),
          );
        }
        if (parseApplyPrUrl(body.pr) === null) {
          throw httpError(
            400,
            makeError(
              "BAD_REQUEST",
              "discovery",
              "PR URL must be a GitHub or AntCode pull request.",
              {
                retryable: false,
              },
            ),
          );
        }
        if (!hasPrJuryCouncil()) {
          throw httpError(
            400,
            makeError(
              "BAD_REQUEST",
              "discovery",
              "default pr-jury is missing; run `councilkit init`",
              { retryable: false },
            ),
          );
        }
        const runId = `ck-review-${randomUUID()}`;
        const logPath = join(tmpdir(), `councilkit-host-review-${runId}.log`);
        let started: { pid: number };
        try {
          started = await Promise.resolve(
            launcher.start({
              action: "review",
              runId,
              pr: body.pr,
              repo: body.repo,
              logPath,
            }),
          );
        } catch (error) {
          throw mapReviewSpawnError(error, body.pr);
        }
        if (!isPidAlive(started.pid)) {
          throw mapReviewSpawnError(
            new Error("councilkit review exited before handshake completed"),
            body.pr,
          );
        }
        writeRunningStub(runId);
        return { runId, started: true };
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId",
      auth: "session",
      responseSchema: cliRunDetailResponseSchema,
      handler: (ctx): CliRunDetailResponse => {
        const runId = ctx.params.runId ?? "";
        if (!isCliRunId(runId)) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid CLI run id.", { retryable: false }),
          );
        }
        const detail = readCliRun(runId, process.env);
        if (detail === null) {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI run not found.", { retryable: false }),
          );
        }
        return detail;
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId/attempts/:attemptId/live",
      auth: "session",
      responseSchema: cliRunAttemptLiveResponseSchema,
      handler: (ctx): CliRunAttemptLiveResponse => {
        const runId = ctx.params.runId ?? "";
        if (!isCliRunId(runId)) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid CLI run id.", { retryable: false }),
          );
        }
        const attemptId = ctx.params.attemptId ?? "";
        if (!CLI_RUN_ATTEMPT_ID_RE.test(attemptId)) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid attempt id.", { retryable: false }),
          );
        }
        const afterSeq = parseAfterSeq(ctx.query.get("afterSeq"));
        const detail = readCliRun(runId, process.env);
        if (detail === null) {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI run not found.", { retryable: false }),
          );
        }
        const all = readLiveSidecar(runId, attemptId);
        const events = all.filter((event) => event.seq > afterSeq);
        const nextSeq = all.length === 0 ? afterSeq : Math.max(...all.map((event) => event.seq));
        return {
          events,
          nextSeq,
          done: detail.status !== "running",
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs/:runId/actions",
      auth: "mutation",
      bodySchema: cliRunActionRequestSchema,
      responseSchema: cliRunActionResponseSchema,
      handler: async (ctx): Promise<CliRunActionResponse> => {
        const runId = ctx.params.runId ?? "";
        if (!isCliRunId(runId) || !runId.startsWith("ck-review-")) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid CLI review run id.", {
              retryable: false,
            }),
          );
        }
        const detail = readCliRun(runId, process.env);
        if (detail === null) {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI run not found.", { retryable: false }),
          );
        }
        if (detail.status === "running") {
          throw httpError(
            409,
            makeError("EXECUTION_CONFLICT", "dispatch", "This run is already in progress.", {
              retryable: true,
            }),
          );
        }
        const body = ctx.body as { action: "fix" | "re-review" };
        const home = resolveCouncilkitHome(process.env);
        const runDir = join(home, "runs", runId);
        const pidPath = join(runDir, PIPELINE_PID_FILE);
        const existing = readPid(pidPath);
        if (existing !== null && isPidAlive(existing)) {
          throw httpError(
            409,
            makeError("EXECUTION_CONFLICT", "dispatch", "A fix pipeline is already running.", {
              retryable: true,
            }),
          );
        }
        const logPath = join(runDir, "pipeline.log");
        writeStartingStatus(runDir, body.action);
        let started: { pid: number };
        try {
          started = await Promise.resolve(launcher.start({ action: body.action, runId, logPath }));
        } catch (error) {
          throw httpError(
            500,
            makeError(
              "DRIVER_SPAWN_FAILED",
              "dispatch",
              error instanceof Error ? error.message : "failed to spawn councilkit",
              { retryable: false },
            ),
          );
        }
        try {
          writeFileSync(pidPath, `${String(started.pid)}\n`, { encoding: "utf8", mode: 0o600 });
        } catch {
          // best-effort lock; the child is already running
        }
        return { action: body.action, runId, started: true };
      },
    },
  ];
}

function hasPrJuryCouncil(): boolean {
  try {
    const home = resolveCouncilkitHome(process.env);
    const raw = readFileSync(join(home, "councils.json"), "utf8");
    const parsed = JSON.parse(raw) as { councils?: Array<{ id?: unknown; name?: unknown }> };
    if (!Array.isArray(parsed.councils)) return false;
    return parsed.councils.some(
      (council) => council.name === "pr-jury" || council.id === "pr-jury",
    );
  } catch {
    return false;
  }
}

function mapReviewSpawnError(error: unknown, pr: string): never {
  const message = error instanceof Error ? error.message : "failed to spawn councilkit";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "HANDSHAKE_TIMEOUT" || message.includes("HANDSHAKE_TIMEOUT")) {
    throw httpError(
      500,
      makeError("HANDSHAKE_TIMEOUT", "dispatch", message.slice(0, 1024), { retryable: true }),
    );
  }
  if (/no local clone/i.test(message)) {
    const project = projectKeyFromPr(pr) ?? "unknown";
    throw httpError(
      400,
      makeError(
        "BAD_REQUEST",
        "discovery",
        `no local clone for ${project}. Run: councilkit review ${pr} --repo <path>`,
        { retryable: false },
      ),
    );
  }
  if (message.includes("pr-jury")) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "default pr-jury is missing; run `councilkit init`", {
        retryable: false,
      }),
    );
  }
  throw httpError(
    500,
    makeError("DRIVER_SPAWN_FAILED", "dispatch", message.slice(0, 1024), { retryable: false }),
  );
}

function writeRunningStub(runId: string): void {
  const statusPath = join(resolveCliRunsRoot(), runId, CLI_RUN_STATUS_FILE);
  if (existsSync(statusPath)) return;
  const now = new Date().toISOString();
  const live = {
    version: 1 as const,
    status: "running" as const,
    progress: { phase: "attempts" as const, attempts: [] as const, updatedAt: now },
    pipeline: null,
  };
  try {
    writeFileSync(statusPath, `${JSON.stringify(live)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // CLI will write status.json as soon as it boots
  }
}

function resolveLauncher(services?: HostServices): CliRunLauncher {
  const extra = services?.cliRunLauncher;
  if (extra && typeof extra === "object" && "start" in extra) {
    return extra as CliRunLauncher;
  }
  return defaultCliRunLauncher();
}

function writeStartingStatus(runDir: string, action: "fix" | "re-review"): void {
  const now = new Date().toISOString();
  const phase = action === "re-review" ? "re-reviewing" : "planning";
  const live = {
    version: 1 as const,
    status: "running" as const,
    progress: { phase, attempts: [] as const, updatedAt: now },
    pipeline: {
      phase,
      round: 0,
      maxRounds: 2,
      planVerdict: null,
      applyStatus: action === "fix" ? "pending" : null,
      followUpRunId: null,
      summary:
        action === "fix"
          ? "正在启动修复：先探测模型（约 1 分钟），请留在此页查看进度。"
          : "正在启动复审：不再改代码，只重新审查当前 PR。",
      updatedAt: now,
    },
  };
  try {
    writeFileSync(join(runDir, "status.json"), `${JSON.stringify(live)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // CLI will write status.json as soon as it boots
  }
}

function readPid(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim().split("\n")[0];
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function parseAfterSeq(raw: string | null): number {
  if (raw === null || raw.length === 0) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "Invalid afterSeq.", { retryable: false }),
    );
  }
  return Number.parseInt(raw, 10);
}

function readLiveSidecar(runId: string, attemptId: string): AttemptLiveEvent[] {
  const root = resolveCliRunsRoot(process.env);
  const liveDir = join(root, runId, "live");
  const filePath = join(liveDir, `${attemptId}.jsonl`);
  if (resolve(filePath) !== resolve(root, runId, "live", `${attemptId}.jsonl`)) return [];
  const dirStat = safeLstat(liveDir);
  if (dirStat === null || !dirStat.isDirectory() || dirStat.isSymbolicLink()) return [];
  const fileStat = safeLstat(filePath);
  if (fileStat === null || !fileStat.isFile() || fileStat.isSymbolicLink()) return [];
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const events: AttemptLiveEvent[] = [];
  const parts = text.split("\n");
  if (text.length > 0 && !text.endsWith("\n") && parts.length > 0) {
    parts.pop();
  }
  for (const line of parts) {
    const parsed = parseAttemptLiveEventLine(line);
    if (parsed !== null) events.push(parsed);
  }
  return events;
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
