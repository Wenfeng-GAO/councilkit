/**
 * Edge coverage for cli/src/host/auth.ts: fallback Set-Cookie parsing, refused
 * documents, caller-signal abort reasons, and the in-memory secret registration.
 */
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "@shared/runtime/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthClient,
  cookieHeader,
  extractCsrfToken,
  extractSessionCookie,
  mutationHeaders,
  sessionHeaders,
} from "../src/host/auth";
import { clearSecrets, redact } from "../src/redact";

const COOKIE = `${SESSION_COOKIE_NAME}=s3ssion-value`;
const TOKEN = "csrf-token-edges-9f3a";

function html(token: string, quote: "double" | "single" = "double"): string {
  if (quote === "single") {
    return `<html><head><meta name='councilkit-csrf' content='${token}'></head></html>`;
  }
  return `<html><head><meta content="${token}" name="councilkit-csrf"></head></html>`;
}

function responseWith(opts: {
  status?: number;
  cookie?: string | null;
  body?: string;
}): Response {
  const headers = new Headers();
  if (opts.cookie) headers.append("set-cookie", opts.cookie);
  return new Response(opts.body ?? html(TOKEN), {
    status: opts.status ?? 200,
    headers,
  });
}

afterEach(() => {
  clearSecrets();
});

describe("extractSessionCookie", () => {
  it("returns the first councilkit_session pair from getSetCookie", () => {
    const headers = new Headers();
    headers.append("set-cookie", "theme=dark; Path=/");
    headers.append("set-cookie", `${SESSION_COOKIE_NAME}=abc=def; HttpOnly`);
    headers.append("set-cookie", `${SESSION_COOKIE_NAME}=later; Path=/`);
    expect(extractSessionCookie(headers)).toBe(`${SESSION_COOKIE_NAME}=abc=def`);
  });

  it("returns empty when the structured cookie value is empty", () => {
    const headers = new Headers();
    headers.append("set-cookie", `${SESSION_COOKIE_NAME}=; Path=/`);
    expect(extractSessionCookie(headers)).toBe("");
  });

  it("returns empty when getSetCookie yields nothing, ignoring the raw header", () => {
    const headers = {
      getSetCookie: () => [],
      get: () => `${SESSION_COOKIE_NAME}=hidden`,
    } as unknown as Headers;
    expect(extractSessionCookie(headers)).toBe("");
  });

  it("falls back to the combined set-cookie header when getSetCookie is absent", () => {
    const combined = ["theme=dark; Path=/", `${SESSION_COOKIE_NAME}=from-combined; HttpOnly`].join(
      ", ",
    );
    const headers = {
      get: (name: string) => (name.toLowerCase() === "set-cookie" ? combined : null),
    } as unknown as Headers;
    expect(extractSessionCookie(headers)).toBe(`${SESSION_COOKIE_NAME}=from-combined`);
  });

  it("splits a combined header on an Expires comma and keeps the session pair", () => {
    const combined = `other=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT, ${SESSION_COOKIE_NAME}=from-exp; Path=/`;
    const headers = {
      get: (name: string) => (name.toLowerCase() === "set-cookie" ? combined : null),
    } as unknown as Headers;
    expect(extractSessionCookie(headers)).toBe(`${SESSION_COOKIE_NAME}=from-exp`);
  });

  it("returns empty for a missing combined header, a non-match, and an empty value", () => {
    const missing = { get: () => null } as unknown as Headers;
    expect(extractSessionCookie(missing)).toBe("");

    const other = {
      get: () => "theme=dark; Path=/",
    } as unknown as Headers;
    expect(extractSessionCookie(other)).toBe("");

    const empty = {
      get: () => `${SESSION_COOKIE_NAME}=; Path=/`,
    } as unknown as Headers;
    expect(extractSessionCookie(empty)).toBe("");
  });

  it("trims a leading space before the session pair in the combined header", () => {
    const headers = {
      get: () => `  ${SESSION_COOKIE_NAME}=padded; Path=/`,
    } as unknown as Headers;
    expect(extractSessionCookie(headers)).toBe(`${SESSION_COOKIE_NAME}=padded`);
  });
});

describe("extractCsrfToken", () => {
  it("reads double quotes, single quotes, and a case-insensitive name", () => {
    expect(extractCsrfToken(html("tok-dq"))).toBe("tok-dq");
    expect(extractCsrfToken(html("tok-sq", "single"))).toBe("tok-sq");
    expect(extractCsrfToken(`<meta NAME="COUNCILKIT-CSRF" content="AbC">`)).toBe("AbC");
  });

  it("ignores a decoy meta and an empty content attribute", () => {
    const doc = `<meta name="viewport" content="width=device-width"><meta name="councilkit-csrf" content="   "><meta name="councilkit-csrf" content="only">`;
    expect(extractCsrfToken(doc)).toBe("only");
  });

  it("returns empty when the content attribute is unquoted", () => {
    expect(extractCsrfToken(`<meta name="councilkit-csrf" content=abc>`)).toBe("");
  });

  it("returns empty when the document has no meta or two valued csrf metas", () => {
    expect(extractCsrfToken("<html></html>")).toBe("");
    expect(
      extractCsrfToken(
        `<meta name="councilkit-csrf" content="a"><meta name="councilkit-csrf" content="b">`,
      ),
    ).toBe("");
  });
});

describe("auth header builders", () => {
  const auth = { cookie: COOKIE, csrfToken: TOKEN };

  it("cookieHeader returns the raw pair", () => {
    expect(cookieHeader(auth)).toBe(COOKIE);
  });

  it("sessionHeaders sends only the cookie", () => {
    expect(sessionHeaders(auth)).toEqual({ Cookie: COOKIE });
  });

  it("mutationHeaders sends cookie, canonical origin, csrf, and json", () => {
    expect(mutationHeaders(auth)).toEqual({
      Cookie: COOKIE,
      Origin: "http://127.0.0.1:43127",
      [CSRF_HEADER_NAME]: TOKEN,
      "Content-Type": "application/json",
    });
  });
});

describe("AuthClient extraction", () => {
  it("caches the first extraction and registers the cookie and csrf for redaction", async () => {
    let calls = 0;
    const fetchFn = async (input: string | URL | Request) => {
      calls += 1;
      expect(String(input)).toBe("http://127.0.0.1:9/");
      return responseWith({ cookie: `${COOKIE}; Path=/; HttpOnly`, body: html(TOKEN) });
    };
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    const first = await auth.get();
    const second = await auth.get();
    expect(calls).toBe(1);
    expect(first).toEqual({ cookie: COOKIE, csrfToken: TOKEN });
    expect(second).toEqual({ cookie: COOKIE, csrfToken: TOKEN });
    expect(redact(`see ${TOKEN} now`)).toBe("see [redacted] now");
    expect(redact(COOKIE)).toBe("[redacted]");
    expect(redact(`prefix ${COOKIE}; suffix`)).toBe("prefix [redacted]; suffix");
  });

  it("refresh and invalidate each force a new document GET", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return responseWith({
        cookie: `${SESSION_COOKIE_NAME}=v${calls}; Path=/`,
        body: html(`tok-${calls}`),
      });
    };
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    expect(await auth.get()).toEqual({
      cookie: `${SESSION_COOKIE_NAME}=v1`,
      csrfToken: "tok-1",
    });
    auth.invalidate();
    expect(await auth.get()).toEqual({
      cookie: `${SESSION_COOKIE_NAME}=v2`,
      csrfToken: "tok-2",
    });
    expect(await auth.refresh()).toEqual({
      cookie: `${SESSION_COOKIE_NAME}=v3`,
      csrfToken: "tok-3",
    });
    expect(calls).toBe(3);
  });

  it("throws the HTTP status when the document is not ok", async () => {
    const fetchFn = async () => responseWith({ status: 503, body: "down" });
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await expect(auth.get()).rejects.toThrow("document GET / -> HTTP 503");
  });

  it("throws when the document has no session cookie", async () => {
    const fetchFn = async () => responseWith({ cookie: null, body: html(TOKEN) });
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await expect(auth.get()).rejects.toThrow(
      "document response carried no councilkit_session cookie",
    );
  });

  it("throws when the document has no unique csrf meta", async () => {
    const fetchFn = async () =>
      responseWith({ cookie: `${COOKIE}; Path=/`, body: "<html></html>" });
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await expect(auth.get()).rejects.toThrow("document carried no councilkit-csrf meta tag");
  });

  it("throws the same missing-csrf error when two csrf metas make the document ambiguous", async () => {
    const body = `<meta name="councilkit-csrf" content="a"><meta name="councilkit-csrf" content="b">`;
    const fetchFn = async () => responseWith({ cookie: `${COOKIE}; Path=/`, body });
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await expect(auth.get()).rejects.toThrow("document carried no councilkit-csrf meta tag");
  });

  it("propagates a fetch failure without wrapping it", async () => {
    const fetchFn = async () => {
      throw new TypeError("network down");
    };
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await expect(auth.get()).rejects.toThrow("network down");
  });

  it("aborts an in-flight extraction with the caller reason", async () => {
    const caller = new AbortController();
    const fetchFn = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            const reason = signal.reason;
            const error = new Error(typeof reason === "string" ? reason : "not-string");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    const pending = auth.get({ signal: caller.signal, timeoutMs: 5_000 });
    caller.abort("cleanup-deadline");
    await expect(pending).rejects.toThrow("cleanup-deadline");
  });

  it("uses the caller-abort fallback when the caller aborts with a null reason", async () => {
    const caller = new AbortController();
    const fetchFn = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            const reason = signal.reason;
            const error = new Error(typeof reason === "string" ? reason : "not-string");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    const pending = auth.get({ signal: caller.signal, timeoutMs: 5_000 });
    caller.abort(null);
    await expect(pending).rejects.toThrow("caller-abort");
  });

  it("uses the caller-abort fallback when the caller signal is already aborted with a null reason", async () => {
    const caller = new AbortController();
    caller.abort(null);
    const fetchFn = (_input: string | URL | Request, init?: RequestInit) => {
      const reason = init?.signal?.reason;
      const error = new Error(typeof reason === "string" ? `reason:${reason}` : "not-string");
      error.name = "AbortError";
      throw error;
    };
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await expect(auth.get({ signal: caller.signal, timeoutMs: 5_000 })).rejects.toThrow(
      "reason:caller-abort",
    );
  });

  it("aborts immediately when the caller signal is already aborted", async () => {
    const caller = new AbortController();
    caller.abort("pre");
    const fetchFn = (_input: string | URL | Request, init?: RequestInit) => {
      const reason = init?.signal?.reason;
      const error = new Error(typeof reason === "string" ? `reason:${reason}` : "not-string");
      error.name = "AbortError";
      throw error;
    };
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await expect(auth.get({ signal: caller.signal, timeoutMs: 5_000 })).rejects.toThrow(
      "reason:pre",
    );
  });

  it("aborts with auth-timeout when the document never arrives", async () => {
    const fetchFn = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            const reason = signal.reason;
            const error = new Error(typeof reason === "string" ? `reason:${reason}` : "not-string");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await expect(auth.get({ timeoutMs: 30 })).rejects.toThrow("reason:auth-timeout");
  });

  it("sends Accept text/html on the document GET", async () => {
    let accept = "";
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      accept = headers.get("accept") ?? "";
      return responseWith({ cookie: `${COOKIE}; Path=/`, body: html(TOKEN) });
    };
    const auth = new AuthClient("http://127.0.0.1:9", { fetchFn: fetchFn as typeof fetch });
    await auth.get();
    expect(accept).toBe("text/html");
  });
});
