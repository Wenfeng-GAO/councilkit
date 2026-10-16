/**
 * HostClient surface: credential cache, one auth retry, and every delegated
 * Host call against a loopback server on port 0.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { RuntimeClientError } from "@/runtime/client";
import { CANONICAL_ORIGIN, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "@shared/runtime/contracts";
import type {
  ContextSnapshot,
  CreateScopeRequest,
  ExecutionProfileDto,
} from "@shared/runtime/schemas";
import { describe, expect, it, vi } from "vitest";
import { HostClient } from "../src/host/client";

const PROFILE: ExecutionProfileDto = {
  driverId: "kimi-stream-json",
  installationId: "inst-1",
  credentialMode: "installation-managed",
  options: {},
};

const SNAPSHOT: ContextSnapshot = {
  digestVersion: 1,
  roomContext: { contextRevision: 0, contextDigest: "d", items: [] },
  participant: { participantId: "p-1", participantSnapshotDigest: "d" },
  instruction: { kind: "message", instructionDigest: "d", text: "reply" },
};

const SCOPE_REQUEST: CreateScopeRequest = {
  scopeRequestId: "scope-req-1",
  participants: [{ participantId: "p-1", profile: PROFILE, modelId: "kimi-k2" }],
};

const HEALTH = {
  apiVersion: "v1" as const,
  hostInstanceId: "host-1",
  node: { version: "v22.14.0", major: 22 },
  drivers: [{ driverId: "kimi-stream-json" as const, capability: "ready" as const }],
};

const DIAGNOSTICS = {
  generatedAt: "2026-07-22T00:00:00.000Z",
  health: HEALTH,
  config: {
    mode: "development" as const,
    port: 43127,
    node: { version: "v22.14.0", major: 22 },
    startedAt: "2026-07-22T00:00:00.000Z",
    uptimeMs: 15,
  },
  installations: [],
  scopes: {
    activeScopes: 1,
    liveDriverProcesses: 0,
    runningExecutions: 2,
    eventConnections: 3,
  },
  logs: {
    recent: [{ at: "2026-07-22T00:00:00.000Z", level: "warn" as const, event: "slow-handshake" }],
    diagnostics: [
      {
        diagnosticId: "d-1",
        at: "2026-07-22T00:00:00.000Z",
        kind: "probe",
        message: "checked",
      },
    ],
  },
};

const INSTALLATIONS = {
  installations: [
    {
      installationId: "inst-1",
      driverId: "kimi-stream-json" as const,
      state: "trusted" as const,
      executablePath: null,
      fingerprint: null,
      components: [],
      detail: null,
    },
  ],
};

const CATALOG = { catalog: ["kimi-k2", "kimi-k1"], cachedAt: "2026-07-22T00:00:01.000Z" };

const READINESS_MISS = {
  readiness: { state: "model_unavailable" as const, detail: "missing model" },
  binding: null,
  cachedAt: "2026-07-22T00:00:02.000Z",
  retryAfterMs: 2000,
};

const READINESS_HIT = {
  readiness: { state: "ready" as const, detail: null },
  binding: {
    bindingDigest: "bd",
    driverId: "kimi-stream-json" as const,
    installationId: "inst-1",
    installationFingerprint: "fp",
    capabilityDigest: "cd",
    requestedModel: "kimi-k2",
    canonicalModelId: "kimi-k2",
    modelAliases: ["k"],
  },
  cachedAt: "2026-07-22T00:00:03.000Z",
};

const SCOPE = {
  scopeId: "scope-1",
  state: "active" as const,
  hostInstanceId: "host-1",
  leaseEpoch: 1,
  participants: [
    {
      participantId: "p-1",
      runtime: "ready" as const,
      binding: null,
      readiness: null,
    },
  ],
};

const CREATED = {
  scopeId: "scope-1",
  controllerId: "ctrl",
  leaseEpoch: 1,
  scope: { ...SCOPE, state: "creating" as const },
};

const EXECUTION = {
  executionId: "exec-12345678",
  participantId: "p-1",
  state: "running" as const,
  lastSeq: 0,
};

const EXECUTION_STATUS = { ...EXECUTION, state: "completed" as const, lastSeq: 4 };

const ACK = {
  executionId: "exec-12345678",
  ackState: "acknowledged" as const,
  disposition: "committed" as const,
};

const CLOSED = { scopeId: "scope-1", state: "closed" as const };

interface Hit {
  method: string;
  url: string;
  body: string;
  cookie: string | undefined;
  origin: string | undefined;
  csrf: string | undefined;
  contentType: string | undefined;
}

function ok(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

function fail(status: number, code: string, message: string): { status: number; body: string } {
  return {
    status,
    body: JSON.stringify({
      ok: false,
      error: { code, message, retryable: false, phase: "security" },
    }),
  };
}

function start(
  onRequest: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      onRequest(req, Buffer.concat(chunks).toString("utf8"), res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function document(res: ServerResponse, nth: number): void {
  res.setHeader("set-cookie", `${SESSION_COOKIE_NAME}=v${nth}; Path=/; HttpOnly`);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<meta name="councilkit-csrf" content="tok-${nth}">`);
}

function hitOf(req: IncomingMessage, body: string): Hit {
  return {
    method: req.method ?? "",
    url: req.url ?? "",
    body,
    cookie: req.headers.cookie,
    origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
    csrf:
      typeof req.headers[CSRF_HEADER_NAME] === "string" ? req.headers[CSRF_HEADER_NAME] : undefined,
    contentType:
      typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
  };
}

describe("HostClient credential cache and auth retry", () => {
  it("uses the canonical origin when baseUrl is omitted", async () => {
    let seen = "";
    const fetchFn = async (input: string | URL | Request) => {
      seen = String(input);
      return new Response(`<meta name="councilkit-csrf" content="c">`, {
        status: 200,
        headers: { "set-cookie": `${SESSION_COOKIE_NAME}=v; Path=/` },
      });
    };
    const host = new HostClient({ fetchFn: fetchFn as typeof fetch });
    const auth = await host.authSnapshot();
    expect(seen).toBe(`${CANONICAL_ORIGIN}/`);
    expect(auth).toEqual({ cookie: `${SESSION_COOKIE_NAME}=v`, csrfToken: "c" });
  });

  it("reuses the cached client and rotates credentials on refreshAuth", async () => {
    let docs = 0;
    const hits: Hit[] = [];
    const started = await start((req, body, res) => {
      if (req.url === "/" && req.method === "GET") {
        docs += 1;
        document(res, docs);
        return;
      }
      hits.push(hitOf(req, body));
      if (req.url === "/api/v1/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(ok(HEALTH));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(fail(404, "NOT_FOUND", "x").body);
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      const first = await host.health();
      const second = await host.health();
      expect(first).toEqual(HEALTH);
      expect(second).toEqual(HEALTH);
      expect(docs).toBe(1);
      expect(hits.map((hit) => hit.cookie)).toEqual([
        `${SESSION_COOKIE_NAME}=v1`,
        `${SESSION_COOKIE_NAME}=v1`,
      ]);
      const refreshed = await host.refreshAuth();
      expect(refreshed).toEqual({ cookie: `${SESSION_COOKIE_NAME}=v2`, csrfToken: "tok-2" });
      const third = await host.health();
      expect(third).toEqual(HEALTH);
      expect(docs).toBe(2);
      expect(hits[2]?.cookie).toBe(`${SESSION_COOKIE_NAME}=v2`);
      expect(hits[0]?.origin).toBe(CANONICAL_ORIGIN);
      expect(hits[0]?.csrf).toBeUndefined();
      expect(hits[0]?.contentType).toBeUndefined();
    } finally {
      await started.close();
    }
  });

  it.each([
    { status: 401, code: "UNAUTHENTICATED", retries: true },
    { status: 403, code: "FORBIDDEN", retries: true },
    { status: 403, code: "AUTH_REQUIRED", retries: false },
    { status: 400, code: "CSRF_MISMATCH", retries: true },
    { status: 409, code: "STALE_CONTROLLER", retries: true },
    { status: 400, code: "NOT_A_REAL_CODE", retries: false },
    { status: 500, code: "INTERNAL", retries: false },
    { status: 200, code: "UNAUTHENTICATED", retries: true },
  ])("health status $status code $code retries=$retries", async ({ status, code, retries }) => {
    let docs = 0;
    let healths = 0;
    const started = await start((req, _body, res) => {
      if (req.url === "/" && req.method === "GET") {
        docs += 1;
        document(res, docs);
        return;
      }
      if (req.url === "/api/v1/health") {
        healths += 1;
        if (healths === 1) {
          const failed = fail(status, code, "first");
          const httpStatus = status === 200 ? 200 : failed.status;
          res.writeHead(httpStatus, { "Content-Type": "application/json" });
          res.end(
            status === 200
              ? JSON.stringify({
                  ok: false,
                  error: { code, message: "first", retryable: false, phase: "security" },
                })
              : failed.body,
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(ok(HEALTH));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      if (retries) {
        const health = await host.health();
        expect(health).toEqual(HEALTH);
        expect(healths).toBe(2);
        expect(docs).toBe(2);
      } else {
        let caught: unknown;
        try {
          await host.health();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(RuntimeClientError);
        const error = caught as RuntimeClientError;
        expect(error.status).toBe(status);
        expect(error.code).toBe(code);
        expect(error.message).toBe("first");
        expect(healths).toBe(1);
        expect(docs).toBe(1);
      }
    } finally {
      await started.close();
    }
  });

  it("returns the second auth error after exactly one retry", async () => {
    let docs = 0;
    let healths = 0;
    const started = await start((req, _body, res) => {
      if (req.url === "/" && req.method === "GET") {
        docs += 1;
        document(res, docs);
        return;
      }
      if (req.url === "/api/v1/health") {
        healths += 1;
        const failed = fail(401, "UNAUTHENTICATED", healths === 1 ? "first" : "second");
        res.writeHead(failed.status, { "Content-Type": "application/json" });
        res.end(failed.body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      let caught: unknown;
      try {
        await host.health();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RuntimeClientError);
      const error = caught as RuntimeClientError;
      expect(error.status).toBe(401);
      expect(error.code).toBe("UNAUTHENTICATED");
      expect(error.message).toBe("second");
      expect(healths).toBe(2);
      expect(docs).toBe(2);
    } finally {
      await started.close();
    }
  });

  it("does not retry a non-auth failure and keeps the cached client", async () => {
    let docs = 0;
    let healths = 0;
    const started = await start((req, _body, res) => {
      if (req.url === "/" && req.method === "GET") {
        docs += 1;
        document(res, docs);
        return;
      }
      if (req.url === "/api/v1/health") {
        healths += 1;
        if (healths === 2) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("not-json");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(ok(HEALTH));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      expect(await host.health()).toEqual(HEALTH);
      await expect(host.health()).rejects.toThrow(SyntaxError);
      expect(await host.health()).toEqual(HEALTH);
      expect(healths).toBe(3);
      expect(docs).toBe(1);
    } finally {
      await started.close();
    }
  });

  it("propagates a document failure during the auth refresh and does not replay", async () => {
    let docs = 0;
    let posts = 0;
    const started = await start((req, _body, res) => {
      if (req.url === "/" && req.method === "GET") {
        docs += 1;
        if (docs === 2) {
          res.writeHead(503, { "Content-Type": "text/html" });
          res.end("down");
          return;
        }
        document(res, docs);
        return;
      }
      if (req.url === "/api/v1/scopes/scope-1/close" && req.method === "POST") {
        posts += 1;
        const failed = fail(401, "UNAUTHENTICATED", "stale");
        res.writeHead(failed.status, { "Content-Type": "application/json" });
        res.end(failed.body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      await host.authSnapshot();
      await expect(
        host.closeScope("scope-1", { controllerId: "ctrl", leaseEpoch: 1 }),
      ).rejects.toThrow("document GET / -> HTTP 503");
      expect(docs).toBe(2);
      expect(posts).toBe(1);
    } finally {
      await started.close();
    }
  });

  it("does not cold-rebuild when the caller signal is already aborted after a 403", async () => {
    let docs = 0;
    const fetchFn = async () => {
      docs += 1;
      return new Response(`<meta name="councilkit-csrf" content="tok-${docs}">`, {
        status: 200,
        headers: { "set-cookie": `${SESSION_COOKIE_NAME}=v${docs}; Path=/` },
      });
    };
    const cleanup = new AbortController();
    const fetchMock = vi.fn(async () => {
      cleanup.abort("cleanup-deadline");
      return new Response(fail(403, "FORBIDDEN", "stale").body, {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const host = new HostClient({
        baseUrl: "http://127.0.0.1:9",
        fetchFn: fetchFn as typeof fetch,
      });
      await host.authSnapshot();
      let caught: unknown;
      try {
        await host.createScope(SCOPE_REQUEST, { signal: cleanup.signal });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error;
      expect(error.name).toBe("AbortError");
      expect(error.message).toBe("aborted before auth cold-rebuild");
      expect(docs).toBe(1);
      expect(fetchMock.mock.calls.length).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("aborts the cold-rebuild document GET when the caller signal fires during refresh", async () => {
    let docs = 0;
    let posts = 0;
    let arm: () => void = () => {};
    const started = await start((req, _body, res) => {
      if (req.url === "/" && req.method === "GET") {
        docs += 1;
        if (docs >= 2) {
          arm();
          return;
        }
        document(res, docs);
        return;
      }
      if (req.url === "/api/v1/scopes/scope-1/close" && req.method === "POST") {
        posts += 1;
        const failed = fail(401, "UNAUTHENTICATED", "stale");
        res.writeHead(failed.status, { "Content-Type": "application/json" });
        res.end(failed.body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      const cleanup = new AbortController();
      arm = () => cleanup.abort();
      let caught: unknown;
      try {
        await host.closeScope(
          "scope-1",
          { controllerId: "ctrl", leaseEpoch: 1 },
          { signal: cleanup.signal },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error;
      expect(error.name).toBe("AbortError");
      expect(error.message).toBe("This operation was aborted");
      expect(docs).toBe(2);
      expect(posts).toBe(1);
    } finally {
      await started.close();
    }
  });
});

describe("HostClient delegated calls", () => {
  it("round-trips every wrapped method and exposes the SSE fetch input", async () => {
    const hits: Hit[] = [];
    let docs = 0;
    const started = await start((req, body, res) => {
      const url = req.url ?? "";
      if (url === "/" && req.method === "GET") {
        docs += 1;
        document(res, docs);
        return;
      }
      hits.push(hitOf(req, body));
      const send = (data: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(ok(data));
      };
      if (url === "/api/v1/diagnostics" && req.method === "GET") {
        send(DIAGNOSTICS);
        return;
      }
      if (url === "/api/v1/installations" && req.method === "GET") {
        send(INSTALLATIONS);
        return;
      }
      if (url.startsWith("/api/v1/models/catalog") && req.method === "GET") {
        send(CATALOG);
        return;
      }
      if (url === "/api/v1/profiles/readiness" && req.method === "POST") {
        send(READINESS_MISS);
        return;
      }
      if (url === "/api/v1/profiles/readiness?refresh=1" && req.method === "POST") {
        send(READINESS_HIT);
        return;
      }
      if (url === "/api/v1/scopes" && req.method === "POST") {
        send(CREATED);
        return;
      }
      if (url === "/api/v1/scopes/scope-1" && req.method === "GET") {
        send(SCOPE);
        return;
      }
      if (url === "/api/v1/scopes/scope-1/activate" && req.method === "POST") {
        send(SCOPE);
        return;
      }
      if (url === "/api/v1/scopes/scope-1/executions" && req.method === "POST") {
        send({ execution: EXECUTION });
        return;
      }
      if (url === "/api/v1/scopes/scope-1/executions/exec-12345678" && req.method === "GET") {
        send(EXECUTION_STATUS);
        return;
      }
      if (url === "/api/v1/scopes/scope-1/executions/exec-12345678/ack" && req.method === "POST") {
        send(ACK);
        return;
      }
      if (
        url === "/api/v1/scopes/scope-1/executions/exec-12345678/cancel" &&
        req.method === "POST"
      ) {
        send({ executionId: "exec-12345678", state: "interrupted" });
        return;
      }
      if (url === "/api/v1/scopes/scope-1/close" && req.method === "POST") {
        send(CLOSED);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(fail(404, "NOT_FOUND", url).body);
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      expect(await host.diagnostics()).toEqual(DIAGNOSTICS);
      expect(await host.listInstallations()).toEqual(INSTALLATIONS);
      expect(await host.modelCatalog("kimi-stream-json", "inst-1")).toEqual(CATALOG);
      expect(
        await host.modelCatalog("claude-stream-json", "inst-1", { route: "cfuse", refresh: true }),
      ).toEqual(CATALOG);
      expect(await host.profileReadiness(PROFILE, "kimi-k2")).toEqual(READINESS_MISS);
      expect(await host.profileReadiness(PROFILE, "kimi-k2", { refresh: true })).toEqual(
        READINESS_HIT,
      );
      expect(await host.createScope(SCOPE_REQUEST)).toEqual(CREATED);
      expect(await host.getScopeStatus("scope-1")).toEqual(SCOPE);
      expect(await host.activateScope("scope-1", { controllerId: "ctrl", leaseEpoch: 1 })).toEqual(
        SCOPE,
      );
      const executeBody = {
        controllerId: "ctrl",
        leaseEpoch: 1,
        executionId: "exec-12345678",
        participantId: "p-1",
        snapshot: SNAPSHOT,
      };
      expect(await host.execute("scope-1", executeBody)).toEqual({ execution: EXECUTION });
      expect(await host.getExecution("scope-1", "exec-12345678")).toEqual(EXECUTION_STATUS);
      const ackBody = {
        controllerId: "ctrl",
        leaseEpoch: 1,
        finalSeq: 4,
        disposition: "committed" as const,
      };
      expect(await host.ack("scope-1", "exec-12345678", ackBody)).toEqual(ACK);
      const cancelled = await host.cancelExecution("scope-1", "exec-12345678", {
        controllerId: "ctrl",
        leaseEpoch: 1,
      });
      expect(cancelled).toBeUndefined();
      expect(await host.closeScope("scope-1", { controllerId: "ctrl", leaseEpoch: 1 })).toEqual(
        CLOSED,
      );

      expect(hits.map((item) => `${item.method} ${item.url}`)).toEqual([
        "GET /api/v1/diagnostics",
        "GET /api/v1/installations",
        "GET /api/v1/models/catalog?driverId=kimi-stream-json&installationId=inst-1",
        "GET /api/v1/models/catalog?driverId=claude-stream-json&installationId=inst-1&route=cfuse&refresh=1",
        "POST /api/v1/profiles/readiness",
        "POST /api/v1/profiles/readiness?refresh=1",
        "POST /api/v1/scopes",
        "GET /api/v1/scopes/scope-1",
        "POST /api/v1/scopes/scope-1/activate",
        "POST /api/v1/scopes/scope-1/executions",
        "GET /api/v1/scopes/scope-1/executions/exec-12345678",
        "POST /api/v1/scopes/scope-1/executions/exec-12345678/ack",
        "POST /api/v1/scopes/scope-1/executions/exec-12345678/cancel",
        "POST /api/v1/scopes/scope-1/close",
      ]);
      expect(JSON.parse(hits[4]?.body ?? "")).toEqual({ profile: PROFILE, modelId: "kimi-k2" });
      expect(JSON.parse(hits[6]?.body ?? "")).toEqual(SCOPE_REQUEST);
      expect(JSON.parse(hits[9]?.body ?? "")).toEqual(executeBody);
      expect(JSON.parse(hits[11]?.body ?? "")).toEqual(ackBody);
      const mutation = hits[8];
      expect(mutation?.cookie).toBe(`${SESSION_COOKIE_NAME}=v1`);
      expect(mutation?.origin).toBe(CANONICAL_ORIGIN);
      expect(mutation?.csrf).toBe("tok-1");
      expect(mutation?.contentType).toBe("application/json");
      expect(docs).toBe(1);

      const raw = await host.rawClient();
      const stream = raw.eventStreamFetch({
        scopeId: "scope-1",
        executionId: "exec-12345678",
        afterSeq: 4,
      });
      expect(stream.url).toBe(
        `${started.baseUrl}/api/v1/scopes/scope-1/executions/exec-12345678/events?afterSeq=4`,
      );
      expect(stream.headers.Cookie).toBe(`${SESSION_COOKIE_NAME}=v1`);
      expect(stream.headers.Origin).toBe(CANONICAL_ORIGIN);
      expect(stream.headers.Accept).toBe("text/event-stream");
      expect(stream.headers[CSRF_HEADER_NAME]).toBeUndefined();

      const streamed = await host.refreshAuthForStream();
      expect(streamed).toEqual({
        cookie: `${SESSION_COOKIE_NAME}=v2`,
        csrfToken: "tok-2",
        origin: CANONICAL_ORIGIN,
      });
      expect(docs).toBe(2);
      const rawAfter = await host.rawClient();
      const streamAfter = rawAfter.eventStreamFetch({
        scopeId: "scope-1",
        executionId: "exec-12345678",
        afterSeq: 0,
      });
      expect(streamAfter.headers.Cookie).toBe(`${SESSION_COOKIE_NAME}=v2`);
      expect(docs).toBe(2);
    } finally {
      await started.close();
    }
  });

  it("threads a caller signal into refreshAuthForStream and the first client build", async () => {
    let docs = 0;
    let sawSignal = false;
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit) => {
      docs += 1;
      const callerSignal = init?.signal;
      sawSignal = callerSignal != null && callerSignal.aborted === false;
      return new Response(`<meta name="councilkit-csrf" content="tok-${docs}">`, {
        status: 200,
        headers: { "set-cookie": `${SESSION_COOKIE_NAME}=v${docs}; Path=/` },
      });
    };
    const host = new HostClient({
      baseUrl: "http://127.0.0.1:9",
      fetchFn: fetchFn as typeof fetch,
    });
    const signal = new AbortController().signal;
    const auth = await host.refreshAuthForStream(signal);
    expect(sawSignal).toBe(true);
    expect(auth).toEqual({
      cookie: `${SESSION_COOKIE_NAME}=v1`,
      csrfToken: "tok-1",
      origin: CANONICAL_ORIGIN,
    });
    const again = await host.refreshAuthForStream();
    expect(again.cookie).toBe(`${SESSION_COOKIE_NAME}=v2`);
    expect(docs).toBe(2);
  });
});
