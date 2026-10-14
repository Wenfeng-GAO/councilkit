import { readOkData } from "@/runtime/host-envelope";
import {
  type CliRunAttemptResultResponse,
  cliRunAttemptResultResponseSchema,
} from "@shared/runtime/schemas";

/**
 * Durable per-attempt result. This route stays off RuntimeClient.
 * The JSON envelope is readOkData from the host envelope module.
 */

export class AttemptResultError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttemptResultError";
  }
}

export interface FetchAttemptResultInput {
  runId: string;
  attemptId: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

export async function fetchAttemptResult({
  runId,
  attemptId,
  signal,
  fetchFn = fetch,
}: FetchAttemptResultInput): Promise<CliRunAttemptResultResponse> {
  const path = `/api/v1/cli-runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(
    attemptId,
  )}/result`;
  const response = await fetchFn(path, {
    method: "GET",
    credentials: "same-origin",
    signal: signal ?? null,
  });
  return readOkData(response, cliRunAttemptResultResponseSchema, {
    fallbackMessage: (status) => `HTTP ${status}`,
    ErrorClass: AttemptResultError,
  });
}
