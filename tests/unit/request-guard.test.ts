/**
 * Loopback guard decisions. Each rejection is the full status plus error literal.
 * isPreflight is separate: the guard itself does not treat OPTIONS as special.
 */
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  type GuardOptions,
  type GuardResult,
  guardRequest,
  isPreflight,
} from "../../runtime-host/security/request-guard";
import { createSessionCapability } from "../../runtime-host/security/session-capability";

const HOST = "127.0.0.1:43127";
const ORIGIN = "http://127.0.0.1:43127";
const SESSION_TOKEN = "session-token-aaa";
const CSRF_TOKEN = "csrf-token-bbb";
const COOKIE = "councilkit_session=session-token-aaa";

const HOST_MISMATCH: GuardResult = {
  ok: false,
  status: 403,
  error: {
    code: "HOST_HEADER_MISMATCH",
    phase: "security",
    message: "Unexpected Host header.",
    retryable: false,
  },
};

const UNAUTHENTICATED: GuardResult = {
  ok: false,
  status: 401,
  error: {
    code: "UNAUTHENTICATED",
    phase: "security",
    message: "Missing or invalid session capability.",
    retryable: false,
  },
};

const ORIGIN_MISMATCH: GuardResult = {
  ok: false,
  status: 403,
  error: {
    code: "ORIGIN_MISMATCH",
    phase: "security",
    message: "Missing or unexpected Origin header.",
    retryable: false,
  },
};

const CSRF_MISMATCH: GuardResult = {
  ok: false,
  status: 403,
  error: {
    code: "CSRF_MISMATCH",
    phase: "security",
    message: "Missing or invalid CSRF capability.",
    retryable: false,
  },
};

const OK: GuardResult = { ok: true };

function scripted(tokens: readonly string[]): { bytes(n: number): string } {
  let index = 0;
  return {
    bytes() {
      const token = tokens[index];
      index += 1;
      if (token === undefined) {
        throw new Error(`no scripted token for entropy call ${index}`);
      }
      return token;
    },
  };
}

const session = createSessionCapability(scripted([SESSION_TOKEN, CSRF_TOKEN]));

function incoming(method: string, headers: IncomingHttpHeaders): IncomingMessage {
  return { method, headers } as IncomingMessage;
}

function decide(
  method: string,
  headers: IncomingHttpHeaders,
  options: Omit<GuardOptions, "session">,
): GuardResult {
  return guardRequest(incoming(method, headers), { session, ...options });
}

describe("guardRequest host boundary", () => {
  it("rejects missing and non-canonical Host values before session or origin", () => {
    const hosts = [
      "localhost:43127",
      "[::1]:43127",
      "[::ffff:127.0.0.1]:43127",
      "127.0.0.1:9999",
      "127.0.0.1",
      ":43127",
      "127.0.0.1.evil.example",
      "example.com:43127",
      "http://127.0.0.1:43127",
      "127.0.0.1:43127 ",
      " 127.0.0.1:43127",
    ];
    expect(
      hosts.map((host) =>
        decide(
          "POST",
          {
            host,
            cookie: COOKIE,
            origin: ORIGIN,
            "x-councilkit-csrf": CSRF_TOKEN,
          },
          { auth: "mutation" },
        ),
      ),
    ).toEqual(hosts.map(() => HOST_MISMATCH));
    expect(decide("GET", {}, { auth: "public" })).toEqual(HOST_MISMATCH);
    expect(decide("GET", { "x-forwarded-host": HOST, origin: ORIGIN }, { auth: "public" })).toEqual(
      HOST_MISMATCH,
    );
  });

  it("uses the canonical host when hostHeader is omitted, and an explicit header when set", () => {
    expect(decide("GET", { host: HOST }, { auth: "public" })).toEqual(OK);
    expect(decide("HEAD", { host: HOST }, { auth: "public" })).toEqual(OK);
    expect(
      decide("GET", { host: "127.0.0.1:9" }, { auth: "public", hostHeader: "127.0.0.1:9" }),
    ).toEqual(OK);
    expect(decide("GET", { host: HOST }, { auth: "public", hostHeader: "127.0.0.1:9" })).toEqual(
      HOST_MISMATCH,
    );
    expect(decide("GET", { host: "" }, { auth: "public", hostHeader: "" })).toEqual(OK);
    expect(decide("GET", { host: HOST }, { auth: "public", hostHeader: "" })).toEqual(
      HOST_MISMATCH,
    );
  });

  it("checks Host before the session cookie", () => {
    expect(decide("GET", { host: "evil.example", cookie: COOKIE }, { auth: "session" })).toEqual(
      HOST_MISMATCH,
    );
    expect(decide("GET", { cookie: COOKIE }, { auth: "session" })).toEqual(HOST_MISMATCH);
  });
});

describe("guardRequest public and session auth", () => {
  it("accepts a public request on the canonical host and ignores cookie, origin, and csrf", () => {
    expect(decide("GET", { host: HOST }, { auth: "public" })).toEqual(OK);
    expect(
      decide(
        "POST",
        {
          host: HOST,
          cookie: "councilkit_session=nope",
          origin: "https://evil.example",
          "x-councilkit-csrf": "nope",
        },
        { auth: "public" },
      ),
    ).toEqual(OK);
  });

  it("requires the session cookie and does not accept the CSRF header in its place", () => {
    const rejected: IncomingHttpHeaders[] = [
      { host: HOST },
      { host: HOST, cookie: "" },
      { host: HOST, cookie: "noequals" },
      { host: HOST, cookie: "councilkit_session=nope" },
      { host: HOST, cookie: "councilkit_session=session-token-zzz" },
      { host: HOST, cookie: "councilkit_session=session-token-aaa-extra" },
      { host: HOST, cookie: "other=session-token-aaa" },
      { host: HOST, cookie: "Councilkit_session=session-token-aaa" },
      { host: HOST, "x-councilkit-csrf": SESSION_TOKEN },
      { host: HOST, "x-councilkit-csrf": CSRF_TOKEN },
    ];
    expect(rejected.map((headers) => decide("GET", headers, { auth: "session" }))).toEqual(
      rejected.map(() => UNAUTHENTICATED),
    );
    expect("session-token-zzz".length).toBe(SESSION_TOKEN.length);
  });

  it("accepts a session request without origin or csrf, including a cookie segment that lacks '='", () => {
    expect(decide("GET", { host: HOST, cookie: COOKIE }, { auth: "session" })).toEqual(OK);
    expect(
      decide(
        "POST",
        {
          host: HOST,
          cookie: "noequals; councilkit_session=session-token-aaa",
          origin: "https://evil.example",
          "x-councilkit-csrf": "nope",
        },
        { auth: "session" },
      ),
    ).toEqual(OK);
    expect(
      decide(
        "GET",
        {
          host: HOST,
          cookie: "councilkit_session=session-token-aaa; HttpOnly; SameSite=Strict; Path=/",
        },
        { auth: "session" },
      ),
    ).toEqual(OK);
  });

  it("checks the session before origin on a mutation", () => {
    expect(
      decide(
        "POST",
        { host: HOST, origin: "https://evil.example", "x-councilkit-csrf": "nope" },
        { auth: "mutation" },
      ),
    ).toEqual(UNAUTHENTICATED);
  });
});

describe("guardRequest mutation origin and csrf", () => {
  const authed = {
    host: HOST,
    cookie: COOKIE,
    "x-councilkit-csrf": CSRF_TOKEN,
  };

  it("rejects missing, null, and non-exact Origin values when expectedOrigin is omitted", () => {
    const origins = [
      undefined,
      "null",
      "",
      "https://evil.example",
      "http://127.0.0.1:9999",
      "http://localhost:43127",
      "http://127.0.0.1:43127/",
      "HTTP://127.0.0.1:43127",
      "http://127.0.0.1:43127, http://127.0.0.1:43127",
      "http://127.0.0.1:43127 ",
    ];
    expect(
      origins.map((origin) =>
        decide(
          "POST",
          {
            ...authed,
            origin,
            referer: ORIGIN,
          },
          { auth: "mutation" },
        ),
      ),
    ).toEqual(origins.map(() => ORIGIN_MISMATCH));
  });

  it("uses an explicit expectedOrigin and still rejects the canonical origin", () => {
    expect(
      decide(
        "POST",
        {
          host: "127.0.0.1:9",
          cookie: COOKIE,
          origin: "http://127.0.0.1:9",
          "x-councilkit-csrf": CSRF_TOKEN,
        },
        {
          auth: "mutation",
          hostHeader: "127.0.0.1:9",
          expectedOrigin: "http://127.0.0.1:9",
        },
      ),
    ).toEqual(OK);
    expect(
      decide(
        "POST",
        {
          host: "127.0.0.1:9",
          cookie: COOKIE,
          origin: ORIGIN,
          "x-councilkit-csrf": CSRF_TOKEN,
        },
        {
          auth: "mutation",
          hostHeader: "127.0.0.1:9",
          expectedOrigin: "http://127.0.0.1:9",
        },
      ),
    ).toEqual(ORIGIN_MISMATCH);
    expect(
      decide("POST", { ...authed, origin: "" }, { auth: "mutation", expectedOrigin: "" }),
    ).toEqual(OK);
    expect(
      decide("POST", { ...authed, origin: ORIGIN }, { auth: "mutation", expectedOrigin: "" }),
    ).toEqual(ORIGIN_MISMATCH);
  });

  it("requires the CSRF header only after origin matches, and does not read it from the cookie", () => {
    expect(
      decide("POST", { host: HOST, cookie: COOKIE, origin: ORIGIN }, { auth: "mutation" }),
    ).toEqual(CSRF_MISMATCH);
    const badCsrf: Array<string | string[] | undefined> = [
      undefined,
      "",
      "   ",
      "nope",
      "csrf-token-zzz",
      SESSION_TOKEN,
      "csrf-token-bbb ",
      ["nope", CSRF_TOKEN],
      ["", CSRF_TOKEN],
      [],
    ];
    expect("csrf-token-zzz".length).toBe(CSRF_TOKEN.length);
    expect(
      badCsrf.map((csrf) =>
        decide(
          "POST",
          { ...authed, origin: ORIGIN, "x-councilkit-csrf": csrf },
          { auth: "mutation" },
        ),
      ),
    ).toEqual(badCsrf.map(() => CSRF_MISMATCH));
    expect(
      decide(
        "POST",
        {
          host: HOST,
          cookie: `councilkit_session=${SESSION_TOKEN}; csrf=${CSRF_TOKEN}`,
          origin: ORIGIN,
        },
        { auth: "mutation" },
      ),
    ).toEqual(CSRF_MISMATCH);
  });

  it("accepts an exact origin and CSRF token, including a GET and an array header", () => {
    expect(
      decide(
        "POST",
        { ...authed, origin: ORIGIN, "x-councilkit-csrf": CSRF_TOKEN },
        { auth: "mutation" },
      ),
    ).toEqual(OK);
    expect(
      decide(
        "GET",
        { ...authed, origin: ORIGIN, "x-councilkit-csrf": CSRF_TOKEN },
        { auth: "mutation" },
      ),
    ).toEqual(OK);
    expect(
      decide(
        "DELETE",
        { ...authed, origin: ORIGIN, "x-councilkit-csrf": [CSRF_TOKEN, "extra"] },
        { auth: "mutation" },
      ),
    ).toEqual(OK);
    expect(
      decide(
        "PUT",
        {
          host: HOST,
          cookie: "noequals; councilkit_session=session-token-aaa",
          origin: ORIGIN,
          "x-councilkit-csrf": [CSRF_TOKEN],
        },
        { auth: "mutation" },
      ),
    ).toEqual(OK);
  });

  it("does not treat POST as a mutation unless the route auth says so", () => {
    expect(decide("POST", { host: HOST, cookie: COOKIE }, { auth: "session" })).toEqual(OK);
    expect(
      decide("GET", { host: HOST, cookie: COOKIE, origin: ORIGIN }, { auth: "mutation" }),
    ).toEqual(CSRF_MISMATCH);
  });
});

describe("isPreflight", () => {
  it("is true only for the exact OPTIONS method", () => {
    expect(isPreflight(incoming("OPTIONS", {}))).toBe(true);
    expect(
      isPreflight(incoming("OPTIONS", { host: "evil.example", origin: "https://evil.example" })),
    ).toBe(true);
    const methods = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "options",
      "Options",
      "OPTIONS ",
      "",
    ];
    expect(methods.map((method) => isPreflight(incoming(method, {})))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(isPreflight({ headers: {} } as IncomingMessage)).toBe(false);
  });
});
