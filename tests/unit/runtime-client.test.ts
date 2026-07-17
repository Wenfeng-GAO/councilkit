import { RuntimeClient, RuntimeClientError } from "@/runtime/client";
import { CREDENTIAL_MODE, CSRF_HEADER_NAME } from "@shared/runtime/contracts";
import type { ExecutionProfileDto } from "@shared/runtime/schemas";
import { describe, expect, it, vi } from "vitest";

/**
 * RuntimeClient Installations/Profile-readiness methods (U6): URL/method/
 * header/body shape plus envelope→data / envelope→RuntimeClientError mapping,
 * against a stubbed fetch (injected via RuntimeClientConfig.fetchFn).
 */

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(...responses: Response[]) {
  const calls: RecordedCall[] = [];
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const response = responses.length > 1 ? responses.shift() : responses[0];
    return Promise.resolve(response as Response);
  });
  return { fetchFn: fetchFn as typeof fetch, calls };
}

function okResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INSTALLATION = {
  installationId: "inst-1",
  driverId: "codex-app-server",
  state: "trusted",
  executablePath: "/usr/local/bin/codex",
  fingerprint: "fp-1",
  components: [],
  detail: null,
};

const PROFILE: ExecutionProfileDto = {
  driverId: "codex-app-server",
  installationId: "inst-1",
  credentialMode: CREDENTIAL_MODE,
  options: {},
};

function makeClient(fetchFn: typeof fetch): RuntimeClient {
  return new RuntimeClient({ baseUrl: "", csrfToken: "csrf-token", fetchFn });
}

describe("RuntimeClient installations / profile readiness (U6)", () => {
  it("listInstallations: GET session call, parses the installations envelope data", async () => {
    const { fetchFn, calls } = stubFetch(okResponse({ installations: [INSTALLATION] }));
    const client = makeClient(fetchFn);

    const result = await client.listInstallations();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/installations");
    expect(calls[0]?.method).toBe("GET");
    // Session kind: no CSRF mutation header, no JSON content type.
    expect(calls[0]?.headers[CSRF_HEADER_NAME]).toBeUndefined();
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
    expect(result.installations).toHaveLength(1);
    expect(result.installations[0]?.installationId).toBe("inst-1");
    expect(result.installations[0]?.state).toBe("trusted");
  });

  it("revalidateInstallation: POST with SESSION auth (revalidation is read-only work)", async () => {
    const { fetchFn, calls } = stubFetch(okResponse({ ...INSTALLATION, state: "trusted" }));
    const client = makeClient(fetchFn);

    const result = await client.revalidateInstallation("inst-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/installations/inst-1/revalidate");
    expect(calls[0]?.method).toBe("POST");
    // The Host route is auth:"session": the CSRF header must NOT be sent.
    expect(calls[0]?.headers[CSRF_HEADER_NAME]).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
    expect(result.installationId).toBe("inst-1");
  });

  it("profileReadiness: POST mutation with CSRF header and { profile, modelId } body", async () => {
    const { fetchFn, calls } = stubFetch(
      okResponse({ readiness: { state: "ready", detail: null }, binding: null }),
    );
    const client = makeClient(fetchFn);

    const result = await client.profileReadiness(PROFILE, "gpt-5-codex");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/profiles/readiness");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers[CSRF_HEADER_NAME]).toBe("csrf-token");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ profile: PROFILE, modelId: "gpt-5-codex" });
    expect(result.readiness.state).toBe("ready");
    expect(result.binding).toBeNull();
  });

  it("maps an error envelope to RuntimeClientError (status/code/message)", async () => {
    const { fetchFn } = stubFetch(errorResponse(404, "INSTALLATION_NOT_FOUND", "unknown install"));
    const client = makeClient(fetchFn);

    const failure = await client.revalidateInstallation("inst-9").catch((error) => error);
    expect(failure).toBeInstanceOf(RuntimeClientError);
    expect((failure as RuntimeClientError).status).toBe(404);
    expect((failure as RuntimeClientError).code).toBe("INSTALLATION_NOT_FOUND");
    expect((failure as RuntimeClientError).message).toBe("unknown install");
  });

  it("rejects response data that fails the shared schema", async () => {
    const { fetchFn } = stubFetch(okResponse({ installations: [{ bogus: true }] }));
    const client = makeClient(fetchFn);

    await expect(client.listInstallations()).rejects.toThrow();
  });

  it("modelCatalog: GET session call with driverId + installationId query params", async () => {
    const { fetchFn, calls } = stubFetch(okResponse({ catalog: ["gpt-5.6-sol"] }));
    const client = makeClient(fetchFn);

    const result = await client.modelCatalog("codex-app-server", "inst-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "/api/v1/models/catalog?driverId=codex-app-server&installationId=inst-1",
    );
    expect(calls[0]?.method).toBe("GET");
    // Session kind: no CSRF mutation header, no JSON content type.
    expect(calls[0]?.headers[CSRF_HEADER_NAME]).toBeUndefined();
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
    expect(result.catalog).toEqual(["gpt-5.6-sol"]);
  });
});
