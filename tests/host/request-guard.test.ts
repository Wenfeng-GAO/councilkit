import { type OutgoingHttpHeaders, request } from "node:http";
import { InstallationError, type InstallationRegistry } from "@host/installations/registry";
import { installationRoutes } from "@host/routes/installations";
import type { HostServices, Route } from "@host/server";
import { CANONICAL_HOST_HEADER, CANONICAL_ORIGIN, CANONICAL_PORT } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import type { InstallationDto } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "./helpers";

/**
 * Full loopback authorization matrix against a real test host. Probe handlers
 * throw on entry, so any non-5xx answer proves the guard rejected the request
 * before the handler (and any side effect) ran.
 */

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

interface RawRequestOptions {
  path: string;
  method?: string;
  headers?: Record<string, string> | [string, string][];
  body?: string;
  chunked?: boolean;
  /** Set false to omit the Host header entirely. */
  setHost?: boolean;
}

/** Raw HTTP client that can send arbitrary Host/Origin headers (fetch cannot). */
function rawRequest(options: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: CANONICAL_PORT,
        path: options.path,
        method: options.method ?? "GET",
        // Node's runtime accepts [name, value] tuples (needed for duplicate
        // Host headers); @types/node only declares the flat string[] form.
        headers: options.headers as OutgoingHttpHeaders,
        setHost: options.setHost ?? true,
      },
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
    if (options.chunked) {
      req.setHeader("Transfer-Encoding", "chunked");
      req.write("chunk-one;");
      req.write("chunk-two");
    } else if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

const TRUSTED_DTO: InstallationDto = {
  installationId: "codex-0123456789ab",
  driverId: "codex-app-server",
  state: "trusted",
  executablePath: "/opt/homebrew/bin/codex",
  fingerprint: `sha256:${"a".repeat(64)}`,
  components: [],
  detail: null,
};

const DISCOVERED_DTO: InstallationDto = {
  ...TRUSTED_DTO,
  installationId: "cld-fedcba987654",
  driverId: "claude-stream-json",
  state: "discovered",
  executablePath: "/opt/homebrew/bin/cld",
  fingerprint: null,
};

function fakeRegistry(
  dtos: InstallationDto[] = [TRUSTED_DTO, DISCOVERED_DTO],
): InstallationRegistry {
  const find = (id: string) => dtos.find((dto) => dto.installationId === id);
  return {
    refresh: () => [...dtos],
    list: () => [...dtos],
    get: find,
    revalidate: (id) => {
      const dto = find(id);
      if (!dto) {
        throw new InstallationError(
          makeError("INSTALLATION_NOT_FOUND", "discovery", `Unknown installation "${id}".`),
        );
      }
      return dto;
    },
    assertExecutable: () => {
      throw new InstallationError(
        makeError("INSTALLATION_UNTRUSTED", "discovery", "not exercised here."),
      );
    },
  };
}

function probeRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/v1/probe-session",
      auth: "session",
      handler: () => {
        throw new Error("session probe handler must not run");
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/probe-mutation",
      auth: "mutation",
      handler: () => {
        throw new Error("mutation probe handler must not run");
      },
    },
  ];
}

async function startHost(): Promise<TestHost> {
  const standIn = { installationRegistry: fakeRegistry() } as unknown as HostServices;
  host = await createTestHost({ routes: [...probeRoutes(), ...installationRoutes(standIn)] });
  return host;
}

function cookieOf(target: TestHost): string {
  return target.session.sessionCookieValue().split(";")[0] as string;
}

function readinessBody(installationId: string): string {
  return JSON.stringify({
    profile: {
      driverId: "codex-app-server",
      installationId,
      credentialMode: "installation-managed",
      options: {},
    },
    modelId: "gpt-5-codex",
  });
}

describe("Host header boundary", () => {
  it("rejects wrong/localhost/IPv6/wrong-port/DNS-rebinding Host values pre-handler", async () => {
    const target = await startHost();
    for (const badHost of [
      "example.com:43127",
      "localhost:43127",
      "[::1]:43127",
      "127.0.0.1:9999",
      "127.0.0.1.evil.example",
    ]) {
      const res = await rawRequest({
        path: "/api/v1/probe-session",
        headers: { Host: badHost, Cookie: cookieOf(target) },
      });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe("HOST_HEADER_MISMATCH");
    }
  });

  it("rejects a request without a Host header before routing", async () => {
    await startHost();
    const res = await rawRequest({ path: "/api/v1/probe-session", setHost: false });
    // Node's HTTP parser answers HTTP/1.1 without Host with 400 before any of
    // our code runs — the handler is unreachable either way.
    expect(res.status).toBe(400);
  });

  it("documents duplicate Host headers: Node keeps the first value, the guard checks it", async () => {
    const target = await startHost();
    const evilFirst = await rawRequest({
      path: "/api/v1/probe-session",
      headers: [
        ["Host", "evil.example"],
        ["Host", CANONICAL_HOST_HEADER],
      ],
    });
    expect(evilFirst.status).toBe(403);
    expect(evilFirst.body.error?.code).toBe("HOST_HEADER_MISMATCH");

    // Canonical first + evil duplicate: Node drops the duplicate before
    // routing, so the guard sees (and accepts) only the first value. Browsers
    // cannot send this shape; raw-socket local processes are out of scope.
    const canonicalFirst = await rawRequest({
      path: "/api/v1/probe-session",
      headers: [
        ["Host", CANONICAL_HOST_HEADER],
        ["Host", "evil.example"],
        ["Cookie", cookieOf(target)],
      ],
    });
    expect(canonicalFirst.status).toBe(500); // guard passed; probe handler threw
  });

  it("checks the Host header before the session capability", async () => {
    await startHost();
    const res = await rawRequest({
      path: "/api/v1/probe-session",
      headers: { Host: "evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("HOST_HEADER_MISMATCH");
  });
});

describe("session capability", () => {
  it("requires the session cookie for reads", async () => {
    const target = await startHost();
    const noCookie = await rawRequest({
      path: "/api/v1/installations",
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(noCookie.status).toBe(401);
    expect(noCookie.body.error?.code).toBe("UNAUTHENTICATED");

    const wrongCookie = await rawRequest({
      path: "/api/v1/installations",
      headers: { Host: CANONICAL_HOST_HEADER, Cookie: "councilkit_session=wrong-token" },
    });
    expect(wrongCookie.status).toBe(401);

    const ok = await rawRequest({
      path: "/api/v1/installations",
      headers: { Host: CANONICAL_HOST_HEADER, Cookie: cookieOf(target) },
    });
    expect(ok.status).toBe(200);
    const data = ok.body.data as { installations: InstallationDto[] };
    expect(data.installations).toHaveLength(2);
  });

  it("rejects session-less probes before the handler runs", async () => {
    await startHost();
    const res = await rawRequest({
      path: "/api/v1/probe-session",
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("UNAUTHENTICATED");
  });
});

describe("Origin/CSRF boundary on mutations", () => {
  it("rejects missing, null and wrong Origin before any side effect", async () => {
    const target = await startHost();
    const base = {
      Host: CANONICAL_HOST_HEADER,
      Cookie: cookieOf(target),
      "x-councilkit-csrf": target.session.csrfToken,
      "Content-Type": "application/json",
    };
    const cases: Record<string, string>[] = [
      base, // no Origin at all
      { ...base, Origin: "null" },
      { ...base, Origin: "https://evil.example" },
      { ...base, Origin: "http://127.0.0.1:9999" },
    ];
    for (const headers of cases) {
      const res = await rawRequest({
        path: "/api/v1/probe-mutation",
        method: "POST",
        headers,
        body: "{}",
      });
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe("ORIGIN_MISMATCH");
    }
  });

  it("rejects cross-site simple requests (form, text/plain, chunked) pre-side-effect", async () => {
    const target = await startHost();
    const base = {
      Host: CANONICAL_HOST_HEADER,
      Cookie: cookieOf(target),
      Origin: "https://evil.example",
      "x-councilkit-csrf": target.session.csrfToken,
    };
    const form = await rawRequest({
      path: "/api/v1/probe-mutation",
      method: "POST",
      headers: { ...base, "Content-Type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    expect(form.status).toBe(403);
    expect(form.body.error?.code).toBe("ORIGIN_MISMATCH");

    const text = await rawRequest({
      path: "/api/v1/probe-mutation",
      method: "POST",
      headers: { ...base, "Content-Type": "text/plain" },
      body: "plain body",
    });
    expect(text.status).toBe(403);

    const chunked = await rawRequest({
      path: "/api/v1/probe-mutation",
      method: "POST",
      headers: base,
      chunked: true,
    });
    expect(chunked.status).toBe(403);
  });

  it("requires the CSRF capability for mutations", async () => {
    const target = await startHost();
    const base = {
      Host: CANONICAL_HOST_HEADER,
      Cookie: cookieOf(target),
      Origin: CANONICAL_ORIGIN,
      "Content-Type": "application/json",
    };
    const body = readinessBody(TRUSTED_DTO.installationId);

    const missing = await rawRequest({
      path: "/api/v1/profiles/readiness",
      method: "POST",
      headers: base,
      body,
    });
    expect(missing.status).toBe(403);
    expect(missing.body.error?.code).toBe("CSRF_MISMATCH");

    const wrong = await rawRequest({
      path: "/api/v1/profiles/readiness",
      method: "POST",
      headers: { ...base, "x-councilkit-csrf": "wrong-token" },
      body,
    });
    expect(wrong.status).toBe(403);

    const ok = await rawRequest({
      path: "/api/v1/profiles/readiness",
      method: "POST",
      headers: { ...base, "x-councilkit-csrf": target.session.csrfToken },
      body,
    });
    expect(ok.status).toBe(200);
  });

  it("lets a fully authorized mutation reach the handler", async () => {
    const target = await startHost();
    const res = await rawRequest({
      path: "/api/v1/probe-mutation",
      method: "POST",
      headers: {
        Host: CANONICAL_HOST_HEADER,
        Cookie: cookieOf(target),
        Origin: CANONICAL_ORIGIN,
        "x-councilkit-csrf": target.session.csrfToken,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(500); // guard passed; probe handler threw
  });
});

describe("installation + readiness routes", () => {
  it("serves the installation inventory with a session", async () => {
    const target = await startHost();
    const res = await fetch(`${target.baseUrl}/api/v1/installations`, {
      headers: authedHeaders(target),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { installations: InstallationDto[] } };
    const ids = body.data.installations.map((dto) => dto.installationId);
    expect(ids).toEqual([TRUSTED_DTO.installationId, DISCOVERED_DTO.installationId]);
  });

  it("revalidates with session auth only (no promotion, 404 for unknown ids)", async () => {
    const target = await startHost();
    const res = await fetch(
      `${target.baseUrl}/api/v1/installations/${TRUSTED_DTO.installationId}/revalidate`,
      { method: "POST", headers: { Host: CANONICAL_HOST_HEADER, Cookie: cookieOf(target) } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: InstallationDto };
    expect(body.data.installationId).toBe(TRUSTED_DTO.installationId);
    expect(body.data.state).toBe("trusted");

    const missing = await fetch(
      `${target.baseUrl}/api/v1/installations/codex-ffffffffffff/revalidate`,
      { method: "POST", headers: { Host: CANONICAL_HOST_HEADER, Cookie: cookieOf(target) } },
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "INSTALLATION_NOT_FOUND",
    );
  });

  it("caps profile readiness at the static result and never fabricates a binding", async () => {
    const target = await startHost();
    const res = await fetch(`${target.baseUrl}/api/v1/profiles/readiness`, {
      method: "POST",
      headers: authedHeaders(target),
      body: readinessBody(TRUSTED_DTO.installationId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { readiness: { state: string; detail: string | null }; binding: unknown };
    };
    expect(body.data.binding).toBeNull();
    // Static part is ready, but U2 must never report final readiness.
    expect(body.data.readiness.state).toBe("runtime_unavailable");
    expect(body.data.readiness.detail).toBe("dynamic driver handshake required (U3)");
  });

  it("reports invalid_binding / runtime_unavailable through the readiness route", async () => {
    const target = await startHost();
    const unknown = await fetch(`${target.baseUrl}/api/v1/profiles/readiness`, {
      method: "POST",
      headers: authedHeaders(target),
      body: readinessBody("codex-aaaaaaaaaaa0"),
    });
    expect(unknown.status).toBe(200);
    expect(
      ((await unknown.json()) as { data: { readiness: { state: string } } }).data.readiness.state,
    ).toBe("invalid_binding");

    const untrusted = await fetch(`${target.baseUrl}/api/v1/profiles/readiness`, {
      method: "POST",
      headers: authedHeaders(target),
      body: JSON.stringify({
        profile: {
          driverId: "claude-stream-json",
          installationId: DISCOVERED_DTO.installationId,
          credentialMode: "installation-managed",
          options: { route: "moonshot" },
        },
        modelId: "glm-5.2",
      }),
    });
    expect(untrusted.status).toBe(200);
    expect(
      ((await untrusted.json()) as { data: { readiness: { state: string } } }).data.readiness.state,
    ).toBe("runtime_unavailable");
  });

  it("rejects executable/argv/env/token injection with 400 BAD_REQUEST", async () => {
    const target = await startHost();
    const profile = {
      driverId: "codex-app-server",
      installationId: TRUSTED_DTO.installationId,
      credentialMode: "installation-managed",
      options: {},
    };
    const injections: unknown[] = [
      { profile: { ...profile, executable: "/tmp/evil" }, modelId: "m" },
      { profile: { ...profile, argv: ["-c", "id"] }, modelId: "m" },
      { profile: { ...profile, shell: "bash" }, modelId: "m" },
      { profile: { ...profile, env: { A: "b" } }, modelId: "m" },
      { profile: { ...profile, token: "x" }, modelId: "m" },
      { profile, modelId: "m", executable: "/tmp/evil" },
    ];
    for (const payload of injections) {
      const res = await fetch(`${target.baseUrl}/api/v1/profiles/readiness`, {
        method: "POST",
        headers: authedHeaders(target),
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    }
  });
});

describe("CORS surface", () => {
  it("never emits Access-Control-Allow-* headers, on success or rejection", async () => {
    const target = await startHost();
    const names = [
      "access-control-allow-origin",
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-allow-credentials",
    ];
    const ok = await fetch(`${target.baseUrl}/api/v1/installations`, {
      headers: authedHeaders(target),
    });
    expect(ok.status).toBe(200);
    for (const name of names) expect(ok.headers.get(name)).toBeNull();

    const denied = await rawRequest({
      path: "/api/v1/installations",
      headers: { Host: CANONICAL_HOST_HEADER, Origin: "https://evil.example" },
    });
    expect(denied.status).toBe(401);
    for (const name of names) expect(denied.headers[name]).toBeUndefined();
  });

  it("answers OPTIONS preflights with 405 and no CORS allow headers", async () => {
    const target = await startHost();
    const res = await fetch(`${target.baseUrl}/api/v1/installations`, {
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
});

describe("session lifecycle", () => {
  it("invalidates the old cookie and CSRF capability after a Host restart", async () => {
    const first = await startHost();
    const oldCookie = cookieOf(first);
    const oldCsrf = first.session.csrfToken;
    await first.cleanup();
    const second = await startHost(); // new random capabilities, same port

    const read = await rawRequest({
      path: "/api/v1/installations",
      headers: { Host: CANONICAL_HOST_HEADER, Cookie: oldCookie },
    });
    expect(read.status).toBe(401);

    const mutation = await rawRequest({
      path: "/api/v1/profiles/readiness",
      method: "POST",
      headers: {
        Host: CANONICAL_HOST_HEADER,
        Cookie: oldCookie,
        Origin: CANONICAL_ORIGIN,
        "x-councilkit-csrf": oldCsrf,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(mutation.status).toBe(401); // session check runs before CSRF

    const newCookieOldCsrf = await rawRequest({
      path: "/api/v1/profiles/readiness",
      method: "POST",
      headers: {
        Host: CANONICAL_HOST_HEADER,
        Cookie: cookieOf(second),
        Origin: CANONICAL_ORIGIN,
        "x-councilkit-csrf": oldCsrf,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(newCookieOldCsrf.status).toBe(403);
    expect(newCookieOldCsrf.body.error?.code).toBe("CSRF_MISMATCH");
  });
});

describe("public health", () => {
  it("returns no paths, accounts, models or fingerprints", async () => {
    const target = await startHost();
    const res = await fetch(`${target.baseUrl}/api/v1/health`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("executablePath");
    expect(raw).not.toContain("fingerprint");
    expect(raw).not.toContain("account");
    expect(raw).not.toContain("model");
    expect(raw).not.toContain("/opt/");
    expect(raw).not.toContain("/usr/");
  });
});
