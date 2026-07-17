import { createServer, request } from "node:http";
import { checkNodeVersion } from "@host/config";
import { CANONICAL_HOST_HEADER, CANONICAL_PORT } from "@shared/runtime/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "./helpers";

let host: TestHost | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { ok: boolean; error?: { code: string }; data?: unknown };
}

/** Raw HTTP client that can send arbitrary Host/Origin headers (fetch cannot). */
function rawGet(
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<RawResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      { hostname: "127.0.0.1", port: CANONICAL_PORT, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: RawResponse["body"];
          try {
            body = JSON.parse(text) as RawResponse["body"];
          } catch {
            body = { ok: false };
          }
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers as RawResponse["headers"],
            body,
          });
        });
      },
    );
    req.on("error", rejectPromise);
    req.end();
  });
}

describe("Node.js version gate", () => {
  it("accepts Node.js 22", () => {
    const result = checkNodeVersion("v22.17.0");
    expect(result.ok).toBe(true);
    expect(result.major).toBe(22);
  });

  it("rejects Node.js 21 and 23 with a structured unsupported error", () => {
    for (const version of ["v21.7.3", "v23.1.0"]) {
      const result = checkNodeVersion(version);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("UNSUPPORTED_NODE");
      expect(result.error?.phase).toBe("bootstrap");
      expect(result.error?.message).toContain("22");
    }
  });
});

describe("fixed canonical origin", () => {
  it("serves health from the canonical origin with version/capability fields", async () => {
    host = await createTestHost();
    const res = await fetch(`${host.baseUrl}/api/v1/health`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data.apiVersion).toBe("v1");
    expect(body.data.hostInstanceId).toBe("test-host-instance");
    const drivers = body.data.drivers as Array<{ driverId: string; capability: string }>;
    expect(drivers.map((d) => d.driverId).sort()).toEqual([
      "claude-stream-json",
      "codex-app-server",
    ]);
    // Public health leaks no paths/models/fingerprints.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("executablePath");
    expect(raw).not.toContain("fingerprint");
    expect(raw).not.toContain("model");
  });

  it("fails with a structured PORT_IN_USE instead of moving to a random port", async () => {
    host = await createTestHost();
    const blocker = createServer();
    await new Promise<void>((resolvePromise) => blocker.listen(0, "127.0.0.1", resolvePromise));
    try {
      // A second Host on the same fixed port must fail, not relocate.
      const second = await createTestHost().then(
        () => null,
        (error: unknown) => error as { runtimeError?: { code: string } },
      );
      expect(second).toBeTruthy();
      expect((second as { runtimeError?: { code: string } }).runtimeError?.code).toBe(
        "PORT_IN_USE",
      );
    } finally {
      await new Promise((resolvePromise) => blocker.close(resolvePromise));
    }
  });
});

describe("production document/static surface (same origin)", () => {
  it("serves index.html with session cookie, CSP nonce and CSRF capability", async () => {
    host = await createTestHost();
    const res = await fetch(`${host.baseUrl}/`, { headers: { Host: CANONICAL_HOST_HEADER } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("councilkit_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");
    expect(setCookie).not.toContain("Secure");

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const html = await res.text();
    expect(html).toContain(`<meta name="councilkit-csrf" content="${host.session.csrfToken}">`);
    const nonceMatch = csp.match(/script-src 'self' 'nonce-([^']+)'/);
    expect(nonceMatch).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonceMatch?.[1]}"`);
  });

  it("serves static assets and falls back to the document for SPA routes", async () => {
    host = await createTestHost();
    const asset = await fetch(`${host.baseUrl}/assets/index.js`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("console.log");

    const spa = await fetch(`${host.baseUrl}/rooms/some-id`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('<div id="root"></div>');

    const traversal = await fetch(`${host.baseUrl}/../package.json`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    // URL normalization makes this the document fallback, never a file leak.
    expect(traversal.status).toBe(200);
    expect(traversal.headers.get("content-type")).toContain("text/html");
  });

  it("answers health on the same origin as the document", async () => {
    host = await createTestHost();
    const doc = await fetch(`${host.baseUrl}/`, { headers: { Host: CANONICAL_HOST_HEADER } });
    expect(doc.status).toBe(200);
    const health = await fetch(`${host.baseUrl}/api/v1/health`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(health.status).toBe(200);
    expect(new URL(health.url).origin).toBe(new URL(doc.url).origin);
    expect(new URL(health.url).origin).toBe("http://127.0.0.1:43127");
  });
});

describe("baseline request guard", () => {
  it("rejects wrong/localhost/IPv6/wrong-port Host headers", async () => {
    host = await createTestHost();
    // fetch() will not send a forged Host header (forbidden header name), so
    // these DNS-rebinding shapes are sent over a raw HTTP client.
    for (const badHost of [
      "localhost:43127",
      "[::1]:43127",
      "127.0.0.1:9999",
      "127.0.0.1.evil.example",
      "evil.example",
    ]) {
      const res = await rawGet("/api/v1/health", { Host: badHost });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe("HOST_HEADER_MISMATCH");
    }
  });

  it("never emits CORS allow headers and rejects preflights", async () => {
    host = await createTestHost();
    const res = await fetch(`${host.baseUrl}/api/v1/health`, {
      method: "OPTIONS",
      headers: {
        Host: CANONICAL_HOST_HEADER,
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("rejects session-less reads of non-public routes before any side effect", async () => {
    host = await createTestHost({
      routes: [
        {
          method: "GET",
          pattern: "/api/v1/probe",
          auth: "session",
          handler: () => {
            throw new Error("must not run");
          },
        },
      ],
    });
    const res = await fetch(`${host.baseUrl}/api/v1/probe`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");

    const ok = await fetch(`${host.baseUrl}/api/v1/probe`, {
      headers: authedHeaders(host),
    });
    // Handler throws → 500, which proves the guard let the session through.
    expect(ok.status).toBe(500);
  });
});
