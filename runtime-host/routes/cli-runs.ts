/**
 * Session-authenticated read of the CLI run library, plus POST actions that
 * spawn the same-checkout `councilkit` CLI (fix / re-review). The Host never
 * writes agents/councils and never runs review agents itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCouncilkitHome } from "@shared/runtime/cli-home";
import { isCliRunId, listCliRuns, readCliRun } from "@shared/runtime/cli-runs-index";
import { makeError } from "@shared/runtime/errors";
import {
  type CliRunActionResponse,
  type CliRunDetailResponse,
  type CliRunsListResponse,
  cliRunActionRequestSchema,
  cliRunActionResponseSchema,
  cliRunDetailResponseSchema,
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
      method: "POST",
      pattern: "/api/v1/cli-runs/:runId/actions",
      auth: "mutation",
      bodySchema: cliRunActionRequestSchema,
      responseSchema: cliRunActionResponseSchema,
      handler: (ctx): CliRunActionResponse => {
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
          started = launcher.start({ action: body.action, runId, logPath });
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
