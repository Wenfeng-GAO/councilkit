import type { GatewayError, ModelMessage } from "@/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// We import the adapter under test directly to keep these unit tests
// decoupled from dispatch/db/crypto wiring (those are exercised by the
// integration path elsewhere). fetch is mocked per-test.
import {
  anthropicAdapter,
  mapStreamErrorToGatewayError,
  normalizeBaseUrl,
  openaiCompatibleAdapter,
} from "@/services/gateway-adapters";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function mockResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const baseMessages: ModelMessage[] = [{ role: "user", content: "hi" }];

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("normalizeBaseUrl", () => {
  it("strips trailing slash", () => {
    expect(normalizeBaseUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com");
  });
  it("strips /v1 suffix when present", () => {
    expect(normalizeBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
  });
  it("leaves host root intact when no /v1 / no trailing slash", () => {
    expect(normalizeBaseUrl("https://api.openai.com")).toBe("https://api.openai.com");
  });
  it("handles /v1 + trailing slash combo", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com");
  });
});

describe("mapStreamErrorToGatewayError", () => {
  it("maps 401 → invalid_key", () => {
    const e = mapStreamErrorToGatewayError({ httpStatus: 401, errorMessage: "no key" });
    expect(e).toEqual<GatewayError>({ kind: "invalid_key", message: "no key", httpStatus: 401 });
  });
  it("maps 403 → invalid_key", () => {
    const e = mapStreamErrorToGatewayError({ httpStatus: 403, errorMessage: "forbidden" });
    expect(e.kind).toBe("invalid_key");
    expect(e.httpStatus).toBe(403);
  });
  it("maps 429 → rate_limit", () => {
    const e = mapStreamErrorToGatewayError({ httpStatus: 429, errorMessage: "slow down" });
    expect(e).toEqual<GatewayError>({ kind: "rate_limit", message: "slow down", httpStatus: 429 });
  });
  it("maps 500 → upstream", () => {
    const e = mapStreamErrorToGatewayError({ httpStatus: 500, errorMessage: "boom" });
    expect(e).toEqual<GatewayError>({ kind: "upstream", message: "boom", httpStatus: 500 });
  });
  it("maps 503 → upstream (5xx family)", () => {
    const e = mapStreamErrorToGatewayError({ httpStatus: 503, errorMessage: "unavailable" });
    expect(e.kind).toBe("upstream");
    expect(e.httpStatus).toBe(503);
  });
  it("maps errorCode 'timeout' → timeout (no httpStatus)", () => {
    const e = mapStreamErrorToGatewayError({ errorMessage: "10s", errorCode: "timeout" });
    expect(e).toEqual<GatewayError>({ kind: "timeout", message: "10s" });
    expect(e.httpStatus).toBeUndefined();
  });
  it("falls back to network when nothing matches", () => {
    const e = mapStreamErrorToGatewayError({ errorMessage: "weird", errorCode: "stream" });
    expect(e).toEqual<GatewayError>({ kind: "network", message: "weird" });
  });
});

describe("anthropicAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requests the canonical /v1/messages URL on a bare host baseUrl", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse(
          sseBody([
            'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n',
            "data: [DONE]\n",
          ]),
        ),
      );
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const chunks = await collect(
      anthropicAdapter({
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant",
        model: "claude-sonnet-4",
        messages: baseMessages,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(chunks).toEqual(["hi"]);
  });

  it("normalizes baseUrl with /v1 and trailing slash (no double /v1)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(sseBody(["data: [DONE]\n"])));
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    await collect(
      anthropicAdapter({
        baseUrl: "https://api.anthropic.com/v1/",
        apiKey: "sk-ant",
        model: "claude-sonnet-4",
        messages: baseMessages,
      }),
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("parses Anthropic content_block_delta SSE", async () => {
    (globalThis as { fetch: unknown }).fetch = vi
      .fn()
      .mockResolvedValue(
        mockResponse(
          sseBody([
            'data: {"type":"content_block_delta","delta":{"text":"hel"}}\n',
            'data: {"type":"content_block_delta","delta":{"text":"lo"}}\n',
            "data: [DONE]\n",
          ]),
        ),
      );
    const chunks = await collect(
      anthropicAdapter({
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant",
        model: "claude-sonnet-4",
        messages: baseMessages,
      }),
    );
    expect(chunks).toEqual(["hel", "lo"]);
  });

  it("yields GatewayError invalid_key on HTTP 401", async () => {
    (globalThis as { fetch: unknown }).fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const chunks = await collect(
      anthropicAdapter({
        baseUrl: "https://api.anthropic.com",
        apiKey: "bad",
        model: "claude-sonnet-4",
        messages: baseMessages,
      }),
    );
    expect(chunks).toHaveLength(1);
    const e = chunks[0] as GatewayError;
    expect(e.kind).toBe("invalid_key");
    expect(e.httpStatus).toBe(401);
  });
});

describe("openaiCompatibleAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requests {baseUrl normalized}/v1/chat/completions with Bearer header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse(
          sseBody(['data: {"choices":[{"delta":{"content":"hi"}}]}\n', "data: [DONE]\n"]),
        ),
      );
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const chunks = await collect(
      openaiCompatibleAdapter({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-xxx",
        model: "gpt-4o",
        messages: baseMessages,
      }),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-xxx");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(chunks).toEqual(["hi"]);
  });

  it("parses OpenAI choices[].delta.content SSE", async () => {
    (globalThis as { fetch: unknown }).fetch = vi
      .fn()
      .mockResolvedValue(
        mockResponse(
          sseBody([
            'data: {"choices":[{"delta":{"content":"hel"}}]}\n',
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
            "data: [DONE]\n",
          ]),
        ),
      );
    const chunks = await collect(
      openaiCompatibleAdapter({
        baseUrl: "https://api.openai.com",
        apiKey: "sk-xxx",
        model: "gpt-4o",
        messages: baseMessages,
      }),
    );
    expect(chunks).toEqual(["hel", "lo"]);
  });

  it("yields GatewayError rate_limit on HTTP 429", async () => {
    (globalThis as { fetch: unknown }).fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429 }));
    const chunks = await collect(
      openaiCompatibleAdapter({
        baseUrl: "https://api.openai.com",
        apiKey: "sk-xxx",
        model: "gpt-4o",
        messages: baseMessages,
      }),
    );
    expect((chunks[0] as GatewayError).kind).toBe("rate_limit");
    expect((chunks[0] as GatewayError).httpStatus).toBe(429);
  });

  it("yields GatewayError upstream on HTTP 500", async () => {
    (globalThis as { fetch: unknown }).fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500 }));
    const chunks = await collect(
      openaiCompatibleAdapter({
        baseUrl: "https://api.openai.com",
        apiKey: "sk-xxx",
        model: "gpt-4o",
        messages: baseMessages,
      }),
    );
    expect((chunks[0] as GatewayError).kind).toBe("upstream");
  });

  it("yields GatewayError timeout when fetch aborts (AbortError)", async () => {
    (globalThis as { fetch: unknown }).fetch = vi.fn().mockImplementation(() => {
      const err = new DOMException("aborted", "AbortError");
      throw err;
    });
    const chunks = await collect(
      openaiCompatibleAdapter({
        baseUrl: "https://api.openai.com",
        apiKey: "sk-xxx",
        model: "gpt-4o",
        messages: baseMessages,
      }),
    );
    expect((chunks[0] as GatewayError).kind).toBe("timeout");
    expect((chunks[0] as GatewayError).httpStatus).toBeUndefined();
  });

  it("yields GatewayError network on non-abort fetch throw", async () => {
    (globalThis as { fetch: unknown }).fetch = vi.fn().mockImplementation(() => {
      throw new TypeError("Failed to fetch");
    });
    const chunks = await collect(
      openaiCompatibleAdapter({
        baseUrl: "https://api.openai.com",
        apiKey: "sk-xxx",
        model: "gpt-4o",
        messages: baseMessages,
      }),
    );
    expect((chunks[0] as GatewayError).kind).toBe("network");
    expect((chunks[0] as GatewayError).message).toContain("Failed to fetch");
  });
});
