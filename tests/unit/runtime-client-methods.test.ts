import { RuntimeClient, RuntimeClientError } from "@/runtime/client";
import type { ExecutionProfileDto } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Wire format for every RuntimeClient method: URL, method, headers, body,
 * signal, and the parsed data or RuntimeClientError fields.
 */

interface RecordedCall {
  url: string;
  init: RequestInit;
}

const PROFILE: ExecutionProfileDto = {
  driverId: "codex-app-server",
  installationId: "inst-1",
  credentialMode: "installation-managed",
  options: {},
};

const HEALTH = {
  apiVersion: "v1" as const,
  hostInstanceId: "host-1",
  node: { version: "v22.14.0", major: 22 },
  drivers: [{ driverId: "codex-app-server" as const, capability: "ready" as const }],
};

const INSTALLATION = {
  installationId: "inst-1",
  driverId: "codex-app-server" as const,
  state: "trusted" as const,
  executablePath: "/usr/local/bin/codex",
  fingerprint: "fp-1",
  components: [],
  detail: null,
};

const DIAGNOSTICS = {
  generatedAt: "2026-07-19T00:00:00.000Z",
  health: HEALTH,
  config: {
    mode: "development" as const,
    port: 43127,
    node: { version: "v22.14.0", major: 22 },
    startedAt: "2026-07-19T00:00:00.000Z",
    uptimeMs: 15,
  },
  installations: [INSTALLATION],
  scopes: {
    activeScopes: 1,
    liveDriverProcesses: 0,
    runningExecutions: 0,
    eventConnections: 2,
  },
  logs: { recent: [], diagnostics: [] },
};

const RUN_SUMMARY = {
  runId: "run/1",
  kind: "review" as const,
  status: "completed" as const,
  title: "Review",
  startedAt: null,
  endedAt: null,
  hasReport: false,
  reportUrl: "/reports/run-1",
  progress: null,
};

const RUN_DETAIL = {
  ...RUN_SUMMARY,
  markdown: "# report",
  truncated: false,
};

const SCOPE_STATUS = {
  scopeId: "scope-1",
  state: "active" as const,
  hostInstanceId: "host-1",
  leaseEpoch: 2,
  participants: [],
};

const SNAPSHOT = {
  digestVersion: 1 as const,
  roomContext: {
    contextRevision: 0,
    contextDigest: "digest-room",
    items: [],
  },
  participant: {
    participantId: "participant-1",
    participantSnapshotDigest: "digest-participant",
  },
  instruction: {
    kind: "message" as const,
    instructionDigest: "digest-instruction",
    text: "hello",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(data: unknown): Response {
  return jsonResponse({ ok: true, data });
}

function stubFetch(...responses: Response[]) {
  const calls: RecordedCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init: init ?? {},
    });
    const response = responses.shift();
    if (!response) throw new Error(`no stub response left for ${String(input)}`);
    return response;
  };
  return { fetchFn, calls };
}

function clientWith(
  fetchFn: typeof fetch,
  overrides: { baseUrl?: string; headers?: Record<string, string> } = {},
): RuntimeClient {
  return new RuntimeClient({
    baseUrl: overrides.baseUrl ?? "",
    csrfToken: "csrf-token",
    headers: overrides.headers,
    fetchFn,
  });
}

function expectCall(
  call: RecordedCall | undefined,
  expected: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal | null;
  },
): void {
  expect(call?.url).toBe(expected.url);
  expect(call?.init.method).toBe(expected.method);
  expect(call?.init.headers).toEqual(expected.headers);
  expect(call?.init.body).toBe(expected.body);
  expect(call?.init.signal).toBe(expected.signal === undefined ? null : expected.signal);
  expect(call?.init.credentials).toBe("same-origin");
}

const MUTATION_HEADERS = {
  "x-councilkit-csrf": "csrf-token",
  "Content-Type": "application/json",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RuntimeClient session and mutation methods", () => {
  it("health uses the default fetch and prefixes baseUrl", async () => {
    const calls: RecordedCall[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        init: init ?? {},
      });
      return ok(HEALTH);
    };
    vi.stubGlobal("fetch", fetchMock);
    const client = new RuntimeClient({ baseUrl: "http://127.0.0.1:9", csrfToken: "csrf-token" });

    const result = await client.health();

    expect(result).toEqual(HEALTH);
    expectCall(calls[0], {
      url: "http://127.0.0.1:9/api/v1/health",
      method: "GET",
      headers: {},
    });
  });

  it("diagnostics returns the sanitized bundle from a session GET", async () => {
    const { fetchFn, calls } = stubFetch(ok(DIAGNOSTICS));
    const client = clientWith(fetchFn, { headers: { "X-Trace": "abc" } });

    expect(await client.diagnostics()).toEqual(DIAGNOSTICS);
    expectCall(calls[0], {
      url: "/api/v1/diagnostics",
      method: "GET",
      headers: { "X-Trace": "abc" },
    });
  });

  it("lists and reads CLI runs, encoding the run id", async () => {
    const { fetchFn, calls } = stubFetch(ok({ runs: [RUN_SUMMARY] }), ok(RUN_DETAIL));
    const client = clientWith(fetchFn);

    const listed = await client.listCliRuns();
    const detail = await client.getCliRun("run/1");

    expect(listed.runs).toEqual([
      {
        ...RUN_SUMMARY,
        hasPlan: false,
        hasFindings: false,
        hasPlanLock: false,
        pipeline: null,
        handoff: null,
        // #272: a run that predates the demo flag parses as a real run.
        demo: false,
      },
    ]);
    expect(detail).toMatchObject({
      ...RUN_DETAIL,
      hasPlan: false,
      hasFindings: false,
      hasPlanLock: false,
      pipeline: null,
      handoff: null,
      planMarkdown: "",
      planTruncated: false,
      findings: [],
      planLock: null,
      landings: [],
      documents: [],
    });
    expectCall(calls[0], { url: "/api/v1/cli-runs", method: "GET", headers: {} });
    expectCall(calls[1], { url: "/api/v1/cli-runs/run%2F1", method: "GET", headers: {} });
  });

  it("posts fix and re-review actions with the mutation header", async () => {
    const { fetchFn, calls } = stubFetch(
      ok({ action: "fix", runId: "run/1", started: true }),
      ok({ action: "re-review", runId: "run/1", started: true }),
    );
    const client = clientWith(fetchFn);

    expect(await client.startCliRunAction("run/1", "fix")).toEqual({
      action: "fix",
      runId: "run/1",
      started: true,
    });
    expect(await client.startCliRunAction("run/1", "re-review")).toEqual({
      action: "re-review",
      runId: "run/1",
      started: true,
    });
    expectCall(calls[0], {
      url: "/api/v1/cli-runs/run%2F1/actions",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ action: "fix" }),
    });
    expectCall(calls[1], {
      url: "/api/v1/cli-runs/run%2F1/actions",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ action: "re-review" }),
    });
  });

  it("starts review, ideate, and repair runs", async () => {
    const started = { runId: "ck-review-abc", started: true as const };
    const { fetchFn, calls } = stubFetch(ok(started), ok(started), ok(started));
    const client = clientWith(fetchFn);
    const review = { pr: "https://github.com/acme/repo/pull/7", requireSpec: true };
    const ideate = { idea: "ship the coverage gate", debateRounds: 1 as const };
    const repair = { from: "ck-review-abc", profile: "default" };

    expect(await client.startCliReview(review)).toEqual(started);
    expect(await client.startCliIdeate(ideate)).toEqual(started);
    expect(await client.startCliRepair(repair)).toEqual(started);
    expectCall(calls[0], {
      url: "/api/v1/cli-runs",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(review),
    });
    expectCall(calls[1], {
      url: "/api/v1/cli-runs/ideate",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(ideate),
    });
    expectCall(calls[2], {
      url: "/api/v1/cli-runs/repair",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(repair),
    });
  });

  it("stops and resumes a repair run", async () => {
    const { fetchFn, calls } = stubFetch(
      ok({ runId: "run/1", stopped: true }),
      ok({ runId: "ck-review-abc", started: true }),
    );
    const client = clientWith(fetchFn);

    expect(await client.stopCliRepair("run/1")).toEqual({ runId: "run/1", stopped: true });
    expect(await client.resumeCliRepair("run/1")).toEqual({
      runId: "ck-review-abc",
      started: true,
    });
    expectCall(calls[0], {
      url: "/api/v1/cli-runs/run%2F1/repair/stop",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: "{}",
    });
    expectCall(calls[1], {
      url: "/api/v1/cli-runs/run%2F1/repair/resume",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: "{}",
    });
  });

  it("lists repair profiles with and without a from query", async () => {
    const payload = {
      profiles: [],
      sourceBranchHint: null,
      baseHint: null,
      hintSource: null,
    };
    const { fetchFn, calls } = stubFetch(ok(payload), ok(payload));
    const client = clientWith(fetchFn);

    expect(await client.listCliRepairProfiles()).toEqual(payload);
    expect(await client.listCliRepairProfiles("from/1")).toEqual(payload);
    expectCall(calls[0], {
      url: "/api/v1/cli-runs/repair/profiles",
      method: "GET",
      headers: {},
    });
    expectCall(calls[1], {
      url: "/api/v1/cli-runs/repair/profiles?from=from%2F1",
      method: "GET",
      headers: {},
    });
  });

  it("reads attempt live events with the default afterSeq of 0", async () => {
    const payload = { events: [], nextSeq: 0, done: true };
    const { fetchFn, calls } = stubFetch(ok(payload));
    const client = clientWith(fetchFn);

    expect(await client.getCliRunAttemptLive("run/1", "attempt/2")).toEqual(payload);
    expectCall(calls[0], {
      url: "/api/v1/cli-runs/run%2F1/attempts/attempt%2F2/live?afterSeq=0",
      method: "GET",
      headers: {},
    });
  });

  it("refreshes installations with a mutation POST and no body", async () => {
    const payload = { installations: [INSTALLATION] };
    const { fetchFn, calls } = stubFetch(ok(payload));
    const client = clientWith(fetchFn);

    expect(await client.refreshInstallations()).toEqual(payload);
    expectCall(calls[0], {
      url: "/api/v1/installations/refresh",
      method: "POST",
      headers: MUTATION_HEADERS,
    });
  });

  it("keeps refresh=false off the readiness URL and returns retryAfterMs", async () => {
    const payload = {
      readiness: { state: "runtime_unavailable" as const, detail: "down" },
      binding: null,
      cachedAt: "2026-07-19T00:00:00.000Z",
      retryAfterMs: 2000,
    };
    const { fetchFn, calls } = stubFetch(ok(payload));
    const client = clientWith(fetchFn);

    expect(await client.profileReadiness(PROFILE, "gpt-5", { refresh: false })).toEqual(payload);
    expectCall(calls[0], {
      url: "/api/v1/profiles/readiness",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ profile: PROFILE, modelId: "gpt-5" }),
    });
  });

  it("adds the claude route and refresh flag to the model catalog query", async () => {
    const payload = { catalog: ["claude-opus"], cachedAt: "2026-07-19T00:00:00.000Z" };
    const { fetchFn, calls } = stubFetch(ok(payload), ok(payload));
    const client = clientWith(fetchFn);

    expect(await client.modelCatalog("claude-stream-json", "inst/1", { route: "cfuse" })).toEqual(
      payload,
    );
    expect(
      await client.modelCatalog("claude-stream-json", "inst/1", {
        route: "moonshot",
        refresh: true,
      }),
    ).toEqual(payload);
    expectCall(calls[0], {
      url: "/api/v1/models/catalog?driverId=claude-stream-json&installationId=inst%2F1&route=cfuse",
      method: "GET",
      headers: {},
    });
    expectCall(calls[1], {
      url: "/api/v1/models/catalog?driverId=claude-stream-json&installationId=inst%2F1&route=moonshot&refresh=1",
      method: "GET",
      headers: {},
    });
  });

  it("creates, reads, activates, and takes over a scope", async () => {
    const created = {
      scopeId: "scope-1",
      controllerId: "ctrl-1",
      leaseEpoch: 1,
      scope: { ...SCOPE_STATUS, leaseEpoch: 1 },
    };
    const taken = { scopeId: "scope-1", controllerId: "ctrl-2", leaseEpoch: 4 };
    const { fetchFn, calls } = stubFetch(
      ok(created),
      ok(SCOPE_STATUS),
      ok(SCOPE_STATUS),
      ok(taken),
    );
    const client = clientWith(fetchFn);
    const signal = new AbortController().signal;
    const createRequest = {
      scopeRequestId: "scope-req-1",
      participants: [{ participantId: "participant-1", profile: PROFILE, modelId: "gpt-5" }],
    };
    const controller = { controllerId: "ctrl-1", leaseEpoch: 3 };

    expect(await client.createScope(createRequest, { signal })).toEqual(created);
    expect(await client.getScopeStatus("scope-1")).toEqual(SCOPE_STATUS);
    expect(await client.activateScope("scope-1", controller)).toEqual(SCOPE_STATUS);
    expect(await client.takeoverScope("scope-1", "ctrl-2")).toEqual(taken);
    expectCall(calls[0], {
      url: "/api/v1/scopes",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(createRequest),
      signal,
    });
    expectCall(calls[1], { url: "/api/v1/scopes/scope-1", method: "GET", headers: {} });
    expectCall(calls[2], {
      url: "/api/v1/scopes/scope-1/activate",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(controller),
    });
    expectCall(calls[3], {
      url: "/api/v1/scopes/scope-1/controller",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ controllerId: "ctrl-2" }),
    });
  });

  it("executes, reads, acks, cancels, and closes", async () => {
    const execution = {
      executionId: "exec-12345678",
      participantId: "participant-1",
      state: "running" as const,
      lastSeq: 0,
    };
    const ack = {
      executionId: "exec-12345678",
      ackState: "acknowledged" as const,
      disposition: "committed" as const,
    };
    const { fetchFn, calls } = stubFetch(
      ok({ execution }),
      ok({ ...execution, state: "completed", lastSeq: 3 }),
      ok(ack),
      ok({ executionId: "exec-12345678", state: "interrupted" }),
      ok({ scopeId: "scope-1", state: "closed" }),
    );
    const client = clientWith(fetchFn);
    const executeRequest = {
      controllerId: "ctrl-1",
      leaseEpoch: 2,
      executionId: "exec-12345678",
      participantId: "participant-1",
      snapshot: SNAPSHOT,
    };
    const ackRequest = {
      controllerId: "ctrl-1",
      leaseEpoch: 2,
      finalSeq: 3,
      disposition: "committed" as const,
    };
    const controller = { controllerId: "ctrl-1", leaseEpoch: 2 };

    expect(await client.execute("scope-1", executeRequest)).toEqual({ execution });
    expect(await client.getExecution("scope-1", "exec-12345678")).toEqual({
      ...execution,
      state: "completed",
      lastSeq: 3,
    });
    expect(await client.ack("scope-1", "exec-12345678", ackRequest)).toEqual(ack);
    expect(await client.cancelExecution("scope-1", "exec-12345678", controller)).toBeUndefined();
    expect(await client.closeScope("scope-1", controller)).toEqual({
      scopeId: "scope-1",
      state: "closed",
    });
    expectCall(calls[0], {
      url: "/api/v1/scopes/scope-1/executions",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(executeRequest),
    });
    expectCall(calls[1], {
      url: "/api/v1/scopes/scope-1/executions/exec-12345678",
      method: "GET",
      headers: {},
    });
    expectCall(calls[2], {
      url: "/api/v1/scopes/scope-1/executions/exec-12345678/ack",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(ackRequest),
    });
    expectCall(calls[3], {
      url: "/api/v1/scopes/scope-1/executions/exec-12345678/cancel",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(controller),
    });
    expectCall(calls[4], {
      url: "/api/v1/scopes/scope-1/close",
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify(controller),
    });
  });

  it("builds the SSE fetch input without a CSRF header", () => {
    const client = new RuntimeClient({
      baseUrl: "http://127.0.0.1:9",
      csrfToken: "csrf-token",
      headers: { Cookie: "session=abc" },
      fetchFn: async () => {
        throw new Error("eventStreamFetch must not call fetch");
      },
    });

    expect(
      client.eventStreamFetch({ scopeId: "scope-1", executionId: "exec-1", afterSeq: 4 }),
    ).toEqual({
      url: "http://127.0.0.1:9/api/v1/scopes/scope-1/executions/exec-1/events?afterSeq=4",
      headers: { Cookie: "session=abc", Accept: "text/event-stream" },
    });
  });
});

describe("RuntimeClient error envelope", () => {
  it("uses UNKNOWN and the HTTP status when the error object is missing", async () => {
    const { fetchFn } = stubFetch(jsonResponse({ ok: false }, 502));
    const client = clientWith(fetchFn);

    const error = await client.health().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).name).toBe("RuntimeClientError");
    expect((error as RuntimeClientError).status).toBe(502);
    expect((error as RuntimeClientError).code).toBe("UNKNOWN");
    expect((error as RuntimeClientError).message).toBe("HTTP 502");
  });

  it("uses the envelope error on an HTTP 200 ok:false body", async () => {
    const { fetchFn } = stubFetch(
      jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "missing run" } }, 200),
    );
    const client = clientWith(fetchFn);

    const error = await client.getCliRun("missing").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).status).toBe(200);
    expect((error as RuntimeClientError).code).toBe("NOT_FOUND");
    expect((error as RuntimeClientError).message).toBe("missing run");
  });

  it("rejects data that misses the health contract", async () => {
    const { fetchFn } = stubFetch(ok({ apiVersion: "v2" }));
    const client = clientWith(fetchFn);

    const error = await client.health().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ZodError");
    expect((error as Error).message).toContain("apiVersion");
  });
});
