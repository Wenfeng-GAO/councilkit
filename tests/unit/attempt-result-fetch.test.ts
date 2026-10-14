import { AttemptResultError, fetchAttemptResult } from "@/lib/attempt-result";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

const PAYLOAD = {
  runId: "run/id",
  attemptId: "attempt id",
  executionRef: "attempt id#1.0",
  executionStatus: "success",
  availability: "available",
  markdown: "# done\n",
  truncated: false,
  failure: null,
  reusedFrom: { runId: "run/id", executionRef: "attempt id#0.0" },
} as const;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchAttemptResult", () => {
  it("GETs the encoded attempt result and returns the parsed payload", async () => {
    const signal = new AbortController().signal;
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return jsonResponse({ ok: true, data: PAYLOAD }, 200);
    }) as typeof fetch;

    await expect(
      fetchAttemptResult({
        runId: "run/id",
        attemptId: "attempt id",
        signal,
        fetchFn,
      }),
    ).resolves.toEqual(PAYLOAD);
    expect(seenUrl).toBe("/api/v1/cli-runs/run%2Fid/attempts/attempt%20id/result");
    expect(seenInit).toEqual({
      method: "GET",
      credentials: "same-origin",
      signal,
    });
  });

  it("throws AttemptResultError from an error envelope", async () => {
    const fetchFn = (async () =>
      jsonResponse(
        { ok: false, error: { code: "NOT_FOUND", message: "missing attempt" } },
        404,
      )) as typeof fetch;

    await expect(
      fetchAttemptResult({ runId: "run-1", attemptId: "attempt-1", fetchFn }),
    ).rejects.toMatchObject({
      name: "AttemptResultError",
      status: 404,
      code: "NOT_FOUND",
      message: "missing attempt",
    });
  });

  it("fills UNKNOWN and HTTP status when the envelope omits error", async () => {
    const fetchFn = (async () => jsonResponse({ ok: false }, 200)) as typeof fetch;
    const error = await fetchAttemptResult({
      runId: "run-1",
      attemptId: "attempt-1",
      fetchFn,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AttemptResultError);
    expect(error).toMatchObject({ status: 200, code: "UNKNOWN", message: "HTTP 200" });
  });

  it("rejects a success envelope whose data fails the result schema", async () => {
    const fetchFn = (async () =>
      jsonResponse({ ok: true, data: { runId: "only" } }, 200)) as typeof fetch;
    const error = await fetchAttemptResult({
      runId: "run-1",
      attemptId: "attempt-1",
      fetchFn,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues.map((issue) => issue.path[0])).toEqual([
      "attemptId",
      "executionRef",
      "executionStatus",
      "availability",
      "markdown",
      "truncated",
      "failure",
      "reusedFrom",
    ]);
  });
});
