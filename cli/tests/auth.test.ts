/**
 * Auth unit tests (plan-a §10 AC1, auth bucket). Covers cookie/meta extraction
 * (attribute order, single/double quotes, multiple Set-Cookie), session vs
 * mutation header construction, and the single bounded 401/403 re-extraction.
 * The Host is mocked with a real `node:http` server.
 */
import { type Server, createServer } from "node:http";
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "@shared/runtime/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthClient,
  extractCsrfToken,
  extractSessionCookie,
  mutationHeaders,
  sessionHeaders,
} from "../src/host/auth";
import { HostClient } from "../src/host/client";

function startHost(
  handler: (
    req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> },
    res: {
      setHeader: (n: string, v: string | string[]) => void;
      writeHead: (status: number, headers?: Record<string, string>) => void;
      end: (data?: string) => void;
    },
  ) => void,
): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    handler({ method: req.method, url: req.url, headers }, res as never);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("cli auth parsing (pure)", () => {
  it("extracts the cookie pair from getSetCookie", () => {
    const h = new Headers();
    h.append("set-cookie", `${SESSION_COOKIE_NAME}=abc; Path=/; HttpOnly`);
    h.append("set-cookie", "other=zzz; Path=/");
    expect(extractSessionCookie(h)).toBe(`${SESSION_COOKIE_NAME}=abc`);
  });

  it("extracts csrf tolerating attribute order and quotes", () => {
    const doubleFirst = `<html><head><meta content="tk-123" name="councilkit-csrf"></head>`;
    expect(extractCsrfToken(doubleFirst)).toBe("tk-123");
    const nameFirst = `<meta name='councilkit-csrf' content='tk-456'>`;
    expect(extractCsrfToken(nameFirst)).toBe("tk-456");
  });

  it("refuses an ambiguous (multiple) csrf meta", () => {
    const html = `<meta name="councilkit-csrf" content="a"><meta name="councilkit-csrf" content="b">`;
    expect(extractCsrfToken(html)).toBe("");
  });

  it("builds session vs mutation headers distinctly", () => {
    const auth = { cookie: `${SESSION_COOKIE_NAME}=x`, csrfToken: "tkn" };
    const session = sessionHeaders(auth);
    expect(session.Cookie).toBe(`${SESSION_COOKIE_NAME}=x`);
    expect(session[CSRF_HEADER_NAME]).toBeUndefined();
    const mutation = mutationHeaders(auth);
    expect(mutation.Cookie).toBe(`${SESSION_COOKIE_NAME}=x`);
    expect(mutation.Origin).toMatch(/127\.0\.0\.1/);
    expect(mutation[CSRF_HEADER_NAME]).toBe("tkn");
    expect(mutation["Content-Type"]).toBe("application/json");
  });
});

describe("cli auth against a mock host", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const started = await startHost((req, res) => {
      if (req.url === "/" && req.method === "GET") {
        (res as unknown as { setHeader: (n: string, v: string) => void }).setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE_NAME}=s3ssion-value; Path=/; HttpOnly`,
        );
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><head><meta name="councilkit-csrf" content="tok-1"></head><body></body></html>`,
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "NOT_FOUND", message: "x", retryable: false, phase: "bootstrap" },
        }),
      );
    });
    baseUrl = started.baseUrl;
    close = started.close;
  });

  afterEach(async () => {
    await close();
  });

  it("extracts cookie and csrf via GET /", async () => {
    const auth = new AuthClient(baseUrl);
    const got = await auth.get();
    expect(got.cookie).toBe(`${SESSION_COOKIE_NAME}=s3ssion-value`);
    expect(got.csrfToken).toBe("tok-1");
  });

  it("refresh discards the old jar and re-extracts", async () => {
    const auth = new AuthClient(baseUrl);
    await auth.get();
    auth.invalidate();
    const got = await auth.refresh();
    expect(got.csrfToken).toBe("tok-1");
  });

  it("re-extracts auth exactly once on a 401 then replays", async () => {
    let healthCalls = 0;
    const started = await startHost((req, res) => {
      if (req.url === "/" && req.method === "GET") {
        (res as unknown as { setHeader: (n: string, v: string) => void }).setHeader(
          "set-cookie",
          `${SESSION_COOKIE_NAME}=v; Path=/`,
        );
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<meta name="councilkit-csrf" content="c">`);
        return;
      }
      if (req.url === "/api/v1/health") {
        healthCalls += 1;
        if (healthCalls === 1) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: {
                code: "UNAUTHENTICATED",
                message: "stale",
                retryable: false,
                phase: "security",
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              apiVersion: "v1",
              hostInstanceId: "h",
              node: { version: "v22", major: 22 },
              drivers: [],
            },
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "NOT_FOUND", message: "x", retryable: false, phase: "bootstrap" },
        }),
      );
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      const health = await host.health();
      expect(health.apiVersion).toBe("v1");
      expect(healthCalls).toBe(2);
    } finally {
      await started.close();
    }
  });
});

describe("cli auth signal-bound extraction (G3)", () => {
  it("aborts an in-flight auth extraction by the caller's signal before its own 8s timeout", async () => {
    // A fetchFn that honors the passed signal and never settles on its own;
    // only an abort can break the wait. G3 combines the caller's signal with
    // the auth controller so the extraction cannot independently wait ~8s.
    const fetchFn = async (_input: string, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (signal?.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          },
          { once: true },
        );
      });
    };
    const auth = new AuthClient("http://127.0.0.1", { fetchFn: fetchFn as typeof fetch });
    const cleanup = new AbortController();
    const timer = setTimeout(() => cleanup.abort("cleanup-deadline"), 50);
    const start = Date.now();
    await expect(auth.get({ signal: cleanup.signal })).rejects.toThrow();
    const elapsed = Date.now() - start;
    clearTimeout(timer);
    // Converged under the ~50ms caller signal — not the ~8s auth timeout.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("does not start a cold-rebuild auth extraction when the caller signal already aborted", async () => {
    let docCalls = 0;
    let closeCalls = 0;
    let abortTrigger: () => void = () => {};
    const started = await startHost((req, res) => {
      if (req.url === "/" && req.method === "GET") {
        docCalls += 1;
        (res as unknown as { setHeader: (n: string, v: string) => void }).setHeader(
          "set-cookie",
          `${SESSION_COOKIE_NAME}=v; Path=/`,
        );
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<meta name="councilkit-csrf" content="c">`);
        return;
      }
      if (
        req.url?.startsWith("/api/v1/scopes/") &&
        req.method === "POST" &&
        req.url.endsWith("/close")
      ) {
        closeCalls += 1;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: "UNAUTHENTICATED",
              message: "stale",
              retryable: false,
              phase: "security",
            },
          }),
        );
        // Abort the caller signal right after returning 401, so the cold-rebuild
        // is attempted only if withAuthRetry fails to re-check the signal.
        abortTrigger();
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "NOT_FOUND", message: "x", retryable: false, phase: "bootstrap" },
        }),
      );
    });
    try {
      const host = new HostClient({ baseUrl: started.baseUrl });
      await host.authSnapshot(); // populate the auth cache (one GET /)
      const cleanup = new AbortController();
      abortTrigger = () => cleanup.abort("cleanup-deadline");
      await expect(
        host.closeScope(
          "scope-1",
          { controllerId: "ctrl", leaseEpoch: 1 },
          { signal: cleanup.signal },
        ),
      ).rejects.toThrow();
      // The cold-rebuild GET / never happened: the shared signal was already
      // aborted when the 401 returned, so no independent ~8s auth wait.
      expect(docCalls).toBe(1);
      expect(closeCalls).toBe(1);
    } finally {
      await started.close();
    }
  });
});
