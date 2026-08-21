/**
 * Session-authenticated read of the CLI run library.
 * The Host never writes agents/councils; it only serves report.md + metadata
 * from COUNCILKIT_HOME/runs.
 */
import { type Stats, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AttemptLiveEvent,
  CLI_RUN_ATTEMPT_ID_RE,
  parseAttemptLiveEventLine,
} from "@shared/runtime/attempt-live-events";
import { resolveCliRunsRoot } from "@shared/runtime/cli-home";
import { isCliRunId, listCliRuns, readCliRun } from "@shared/runtime/cli-runs-index";
import { makeError } from "@shared/runtime/errors";
import {
  type CliRunAttemptLiveResponse,
  type CliRunDetailResponse,
  type CliRunsListResponse,
  cliRunAttemptLiveResponseSchema,
  cliRunDetailResponseSchema,
  cliRunsListResponseSchema,
} from "@shared/runtime/schemas";
import { type Route, httpError } from "../server";

export function cliRunsRoutes(): Route[] {
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
  ];
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
