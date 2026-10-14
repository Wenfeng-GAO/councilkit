import { RuntimeClientError } from "@/runtime/client";
import {
  exportRepairEvidence,
  fetchRepairEventDetail,
  fetchRepairEvidence,
  fetchRepairObservation,
} from "@/runtime/repair-observation-client";
import { afterEach, describe, expect, it, vi } from "vitest";

const OPERATION = {
  eventId: "evt/1",
  sourceId: "src-1",
  sourceGeneration: "gen-1",
  executionRef: "ref-1",
  round: 2,
  roleKey: "fixer",
  operationId: "op-1",
  revision: 0,
  occurredAt: null,
  receivedAt: "2026-07-19T00:00:00.000Z",
  kind: "progress" as const,
  status: "started" as const,
  summary: "working",
  detailRef: null,
  truncated: false,
};

const OBSERVATION = {
  schemaVersion: 1 as const,
  runId: "run/1",
  round: 2,
  currentRound: 2,
  snapshotVersion: "snap-1",
  serverTime: "2026-07-19T00:00:00.000Z",
  observedAt: "2026-07-19T00:00:01.000Z",
  availability: "available" as const,
  reasons: [],
  sourceWatermarks: [],
  task: {
    phase: "fix",
    businessResult: null,
    candidateSha: null,
    baseSha: null,
    lastActivityAt: null,
    lastActivityTimeSource: "unknown" as const,
    process: { state: "unknown" as const, checkedAt: null },
    resumeEligible: null,
  },
  roles: [],
  upserts: [],
  nextCursor: "",
  earlierCursor: null,
  hasMore: false,
  reset: false,
  observationDone: true,
};

const DETAIL = {
  schemaVersion: 1 as const,
  eventId: "evt/1",
  operation: OPERATION,
  body: "detail body",
  truncated: false,
  nextCursor: null,
  availability: "partial" as const,
  reasons: ["clipped"],
};

const EVIDENCE = {
  schemaVersion: 1 as const,
  runId: "run/1",
  round: 2,
  candidateSha: "abc",
  baseSha: null,
  verifiedAt: null,
  assertionVersion: null,
  gateConsistent: true,
  exportableAsApproved: false,
  items: [
    {
      assertionId: "A-1",
      label: "builds",
      status: "passed" as const,
      candidateSha: "abc",
      assertionVersion: null,
      source: null,
      detail: null,
    },
  ],
  availability: "available" as const,
  reasons: [],
};

interface RecordedCall {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  signal: AbortSignal | null;
}

function stubFetch(...responses: Array<Response | (() => Response)>) {
  const calls: RecordedCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      credentials: init?.credentials,
      signal: (init?.signal as AbortSignal | null) ?? null,
    });
    const next = responses.shift();
    if (!next) throw new Error("no stub response");
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fetchFn);
  return calls;
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("repair observation client", () => {
  it("requests the current round when round, cursor, and limit are omitted", async () => {
    const calls = stubFetch(envelope(OBSERVATION));

    expect(await fetchRepairObservation({ runId: "run/1" })).toEqual(OBSERVATION);
    expect(calls).toEqual([
      {
        url: "/api/v1/cli-runs/run%2F1/repair/observation?round=current",
        method: "GET",
        credentials: "same-origin",
        signal: null,
      },
    ]);
  });

  it("adds cursor, limit, and the caller signal", async () => {
    const calls = stubFetch(envelope(OBSERVATION));
    const controller = new AbortController();

    expect(
      await fetchRepairObservation({
        runId: "run/1",
        round: 3,
        cursor: "cursor-1",
        limit: 25,
        signal: controller.signal,
      }),
    ).toEqual(OBSERVATION);
    expect(calls).toEqual([
      {
        url: "/api/v1/cli-runs/run%2F1/repair/observation?round=3&cursor=cursor-1&limit=25",
        method: "GET",
        credentials: "same-origin",
        signal: controller.signal,
      },
    ]);
  });

  it("keeps round 0 and drops an empty cursor and a zero limit", async () => {
    const calls = stubFetch(envelope(OBSERVATION));

    await fetchRepairObservation({ runId: "run/1", round: 0, cursor: "", limit: 0 });

    expect(calls[0]?.url).toBe("/api/v1/cli-runs/run%2F1/repair/observation?round=0");
  });

  it("throws the envelope error and the HTTP fallback", async () => {
    stubFetch(
      new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "no run" } }), {
        status: 404,
      }),
    );
    const missing = await fetchRepairObservation({ runId: "run/1" }).catch(
      (caught: unknown) => caught,
    );

    stubFetch(new Response(JSON.stringify({ ok: false }), { status: 500 }));
    const fallback = await fetchRepairObservation({ runId: "run/1" }).catch(
      (caught: unknown) => caught,
    );

    stubFetch(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }));
    const invalid = await fetchRepairObservation({ runId: "run/1" }).catch(
      (caught: unknown) => caught,
    );

    expect(missing).toBeInstanceOf(RuntimeClientError);
    expect((missing as RuntimeClientError).status).toBe(404);
    expect((missing as RuntimeClientError).code).toBe("NOT_FOUND");
    expect((missing as RuntimeClientError).message).toBe("no run");
    expect(fallback).toBeInstanceOf(RuntimeClientError);
    expect((fallback as RuntimeClientError).status).toBe(500);
    expect((fallback as RuntimeClientError).code).toBe("UNKNOWN");
    expect((fallback as RuntimeClientError).message).toBe("HTTP 500");
    expect(invalid).toBeInstanceOf(Error);
    expect((invalid as Error).name).toBe("ZodError");
  });

  it("reads an event with and without a query", async () => {
    const calls = stubFetch(envelope(DETAIL), envelope(DETAIL));
    const controller = new AbortController();

    expect(
      await fetchRepairEventDetail({ runId: "run/1", eventId: "evt/1", signal: controller.signal }),
    ).toEqual(DETAIL);
    expect(
      await fetchRepairEventDetail({
        runId: "run/1",
        eventId: "evt/1",
        round: 0,
        cursor: "cursor-1",
      }),
    ).toEqual(DETAIL);
    expect(calls).toEqual([
      {
        url: "/api/v1/cli-runs/run%2F1/repair/events/evt%2F1",
        method: "GET",
        credentials: "same-origin",
        signal: controller.signal,
      },
      {
        url: "/api/v1/cli-runs/run%2F1/repair/events/evt%2F1?round=0&cursor=cursor-1",
        method: "GET",
        credentials: "same-origin",
        signal: null,
      },
    ]);
  });

  it("reads evidence with and without a round", async () => {
    const calls = stubFetch(envelope(EVIDENCE), envelope(EVIDENCE));

    expect(await fetchRepairEvidence({ runId: "run/1" })).toEqual(EVIDENCE);
    expect(await fetchRepairEvidence({ runId: "run/1", round: "current" })).toEqual(EVIDENCE);
    expect(calls[0]?.url).toBe("/api/v1/cli-runs/run%2F1/repair/evidence");
    expect(calls[1]?.url).toBe("/api/v1/cli-runs/run%2F1/repair/evidence?round=current");
    expect(calls[0]?.signal).toBeNull();
    expect(calls[1]?.credentials).toBe("same-origin");
  });

  it("exports json using the content-disposition filename", async () => {
    const controller = new AbortController();
    const calls = stubFetch(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="run-1 evidence.json"' },
      }),
    );

    const exported = await exportRepairEvidence({
      runId: "run/1",
      round: 4,
      format: "json",
      signal: controller.signal,
    });

    expect(calls).toEqual([
      {
        url: "/api/v1/cli-runs/run%2F1/repair/evidence/export?format=json&round=4",
        method: "GET",
        credentials: "same-origin",
        signal: controller.signal,
      },
    ]);
    expect(exported.filename).toBe("run-1 evidence.json");
    expect(await exported.blob.text()).toBe('{"ok":true}');
  });

  it("falls back to runId-evidence.format when the header has no quoted filename", async () => {
    const calls = stubFetch(
      new Response("# evidence", {
        status: 200,
        headers: { "content-disposition": "attachment; filename=bare.md" },
      }),
    );

    const exported = await exportRepairEvidence({ runId: "run/1", format: "md" });

    expect(calls[0]?.url).toBe("/api/v1/cli-runs/run%2F1/repair/evidence/export?format=md");
    expect(calls[0]?.signal).toBeNull();
    expect(exported.filename).toBe("run/1-evidence.md");
    expect(await exported.blob.text()).toBe("# evidence");
  });

  it("throws UNKNOWN HTTP status when the export is not ok", async () => {
    stubFetch(new Response("nope", { status: 502 }));

    const error = await exportRepairEvidence({ runId: "run/1", format: "json" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).status).toBe(502);
    expect((error as RuntimeClientError).code).toBe("UNKNOWN");
    expect((error as RuntimeClientError).message).toBe("HTTP 502");
    expect((error as RuntimeClientError).name).toBe("RuntimeClientError");
  });
});
