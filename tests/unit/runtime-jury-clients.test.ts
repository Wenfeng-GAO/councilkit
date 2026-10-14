import { RuntimeClientError } from "@/runtime/client";
import { readProductJury } from "@/runtime/product-jury-client";
import { readOrSaveReviewJury } from "@/runtime/review-jury-client";
import type { ReviewJuryUpdate } from "@shared/runtime/review-jury";
import { afterEach, describe, expect, it, vi } from "vitest";

const CSRF_SELECTOR = 'meta[name="councilkit-csrf"]';

const JURY = {
  revision: "rev-1",
  councilId: "product-jury",
  reporterAgentId: "seat-a",
  seats: [
    {
      agentId: "seat-a",
      modelId: "gpt-6-astra",
      driverSelection: { driverId: "codex-app-server" as const, options: {} },
    },
  ],
  agents: [
    {
      agentId: "seat-a",
      name: "Seat A",
      modelId: "gpt-6-astra",
      driverSelection: { driverId: "codex-app-server" as const, options: {} },
      enabled: true,
      color: "#112233",
    },
  ],
  codexModels: ["gpt-6-astra"],
};

const UPDATE: ReviewJuryUpdate = {
  revision: "rev-2",
  reporterAgentId: "seat-a",
  seats: [
    {
      agentId: "seat-a",
      modelId: "gpt-6-astra",
      driverSelection: { driverId: "codex-app-server", options: {} },
    },
  ],
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(...responses: Response[]) {
  const calls: RecordedCall[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === "string" ? init.body : undefined,
      credentials: init?.credentials,
    });
    const response = responses.shift();
    if (!response) throw new Error("no stub response");
    return response;
  });
  vi.stubGlobal("fetch", fetchFn);
  return { calls, fetchFn };
}

function stubCsrf(token: string | null): void {
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      selector === CSRF_SELECTOR && token !== null ? { getAttribute: () => token } : null,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readProductJury", () => {
  it("GETs the product jury and returns the parsed council", async () => {
    const { calls } = stubFetch(jsonResponse({ ok: true, data: JURY }));

    expect(await readProductJury()).toEqual(JURY);
    expect(calls).toEqual([
      {
        url: "/api/v1/product-jury",
        method: "GET",
        headers: {},
        body: undefined,
        credentials: "same-origin",
      },
    ]);
  });

  it("throws the envelope code and message", async () => {
    stubFetch(
      jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "no council" } }, 404),
    );

    const error = await readProductJury().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).status).toBe(404);
    expect((error as RuntimeClientError).code).toBe("NOT_FOUND");
    expect((error as RuntimeClientError).message).toBe("no council");
  });

  it("uses UNKNOWN and the default message when the error object is missing", async () => {
    stubFetch(jsonResponse({ ok: true }, 500));

    const error = await readProductJury().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).status).toBe(500);
    expect((error as RuntimeClientError).code).toBe("UNKNOWN");
    expect((error as RuntimeClientError).message).toBe(
      "无法读取 product-jury，请确认 Host 已更新并重启。",
    );
  });

  it("uses the default message when the code is present and the message is not", async () => {
    stubFetch(jsonResponse({ ok: false, error: { code: "FORBIDDEN" } }, 200));

    const error = await readProductJury().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).status).toBe(200);
    expect((error as RuntimeClientError).code).toBe("FORBIDDEN");
    expect((error as RuntimeClientError).message).toBe(
      "无法读取 product-jury，请确认 Host 已更新并重启。",
    );
  });

  it("rejects a council that misses the response contract", async () => {
    stubFetch(jsonResponse({ ok: true, data: {} }));

    const error = await readProductJury().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ZodError");
    expect((error as Error).message).toContain("revision");
  });
});

describe("readOrSaveReviewJury", () => {
  it("GETs the review jury without a CSRF header", async () => {
    const { calls } = stubFetch(jsonResponse({ ok: true, data: JURY }));

    expect(await readOrSaveReviewJury()).toEqual(JURY);
    expect(calls).toEqual([
      {
        url: "/api/v1/review-jury",
        method: "GET",
        headers: {},
        body: undefined,
        credentials: "same-origin",
      },
    ]);
  });

  it("POSTs a validated update with the CSRF header from the document", async () => {
    stubCsrf("csrf-jury");
    const saved = { ...JURY, revision: "rev-2" };
    const { calls } = stubFetch(jsonResponse({ ok: true, data: saved }));

    expect(await readOrSaveReviewJury(UPDATE)).toEqual(saved);
    expect(calls[0]?.url).toBe("/api/v1/review-jury");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers).toEqual({
      "Content-Type": "application/json",
      "x-councilkit-csrf": "csrf-jury",
    });
    expect(calls[0]?.credentials).toBe("same-origin");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(UPDATE);
  });

  it("throws the review-jury default message when the error fields are absent", async () => {
    stubFetch(jsonResponse({ ok: false }, 503));

    const error = await readOrSaveReviewJury().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).status).toBe(503);
    expect((error as RuntimeClientError).code).toBe("UNKNOWN");
    expect((error as RuntimeClientError).message).toBe(
      "无法读取默认席位，请确认 Host 已更新并重启。",
    );
  });

  it("uses a provided message and falls back the code", async () => {
    stubFetch(jsonResponse({ ok: false, error: { message: "stale revision" } }, 409));

    const error = await readOrSaveReviewJury().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).status).toBe(409);
    expect((error as RuntimeClientError).code).toBe("UNKNOWN");
    expect((error as RuntimeClientError).message).toBe("stale revision");
  });

  it("does not fetch when the page has no CSRF meta", async () => {
    vi.stubGlobal("document", undefined);
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    const error = await readOrSaveReviewJury(UPDATE).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'runtime bootstrap: missing <meta name="councilkit-csrf"> content — the page must be served by the Runtime Host',
    );
    expect(fetchFn.mock.calls).toEqual([]);
  });

  it("does not fetch when the reporter is not a seat", async () => {
    stubCsrf("csrf-jury");
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    const error = await readOrSaveReviewJury({
      ...UPDATE,
      reporterAgentId: "missing",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ZodError");
    expect((error as Error).message).toContain("汇总席位必须参与审查");
    expect(fetchFn.mock.calls).toEqual([]);
  });

  it("does not fetch when two seats share an agent id", async () => {
    stubCsrf("csrf-jury");
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const seat = UPDATE.seats[0];
    if (!seat) throw new Error("fixture seat missing");

    const error = await readOrSaveReviewJury({
      revision: "rev-2",
      reporterAgentId: "seat-a",
      seats: [seat, { ...seat }],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ZodError");
    expect((error as Error).message).toContain("席位不可重复");
    expect(fetchFn.mock.calls).toEqual([]);
  });
});
