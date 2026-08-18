/**
 * Session-authenticated read of the CLI run library.
 * The Host never writes agents/councils; it only serves report.md + metadata
 * from COUNCILKIT_HOME/runs.
 */
import { isCliRunId, listCliRuns, readCliRun } from "@shared/runtime/cli-runs-index";
import { makeError } from "@shared/runtime/errors";
import {
  type CliRunDetailResponse,
  type CliRunsListResponse,
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
  ];
}
