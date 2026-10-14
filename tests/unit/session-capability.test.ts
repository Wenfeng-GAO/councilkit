/**
 * Per-startup session and CSRF capabilities: fixed entropy for exact tokens,
 * and the default CSPRNG for the 256-bit cookie shape.
 */
import { describe, expect, it } from "vitest";
import {
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  createSessionCapability,
} from "../../runtime-host/security/session-capability";

const SESSION_TOKEN = "session-token-aaa";
const CSRF_TOKEN = "csrf-token-bbb";
const SESSION_COOKIE = "councilkit_session=session-token-aaa";
const COOKIE_ATTRIBUTES = "councilkit_session=session-token-aaa; HttpOnly; SameSite=Strict; Path=/";

function scripted(tokens: readonly string[]): { bytes(n: number): string; sizes: number[] } {
  const sizes: number[] = [];
  return {
    sizes,
    bytes(n: number) {
      sizes.push(n);
      const token = tokens[sizes.length - 1];
      if (token === undefined) {
        throw new Error(`no scripted token for entropy call ${sizes.length}`);
      }
      return token;
    },
  };
}

function fixedCapability() {
  return createSessionCapability(scripted([SESSION_TOKEN, CSRF_TOKEN]));
}

describe("createSessionCapability scripted entropy", () => {
  it("asks for 32 bytes twice and keeps those exact secrets", () => {
    const entropy = scripted([SESSION_TOKEN, CSRF_TOKEN]);
    const cap = createSessionCapability(entropy);
    expect(cap.sessionToken).toBe("session-token-aaa");
    expect(cap.csrfToken).toBe("csrf-token-bbb");
    expect(cap.hasSession("councilkit_session=session-token-aaa")).toBe(true);
    expect(cap.hasCsrf("csrf-token-bbb")).toBe(true);
    expect(cap.sessionCookieValue()).toBe(
      "councilkit_session=session-token-aaa; HttpOnly; SameSite=Strict; Path=/",
    );
    expect(entropy.sizes).toEqual([32, 32]);
  });

  it("re-exports the cookie and CSRF header names", () => {
    expect(SESSION_COOKIE_NAME).toBe("councilkit_session");
    expect(CSRF_HEADER_NAME).toBe("x-councilkit-csrf");
  });

  it("emits an HttpOnly SameSite=Strict Path=/ cookie and no Domain, Secure, or expiry", () => {
    const cap = fixedCapability();
    expect(cap.sessionCookieValue()).toBe(COOKIE_ATTRIBUTES);
    expect(cap.hasSession(cap.sessionCookieValue())).toBe(true);
    expect(cap.hasSession(SESSION_COOKIE)).toBe(true);
  });

  it("keeps '=' inside a scripted token when parsing and when emitting the cookie", () => {
    const cap = createSessionCapability(scripted(["aaaa=bbbb", "cccc=dddd"]));
    expect(cap.sessionToken).toBe("aaaa=bbbb");
    expect(cap.csrfToken).toBe("cccc=dddd");
    expect(cap.sessionCookieValue()).toBe(
      "councilkit_session=aaaa=bbbb; HttpOnly; SameSite=Strict; Path=/",
    );
    expect(cap.hasSession("councilkit_session=aaaa=bbbb")).toBe(true);
    expect(cap.hasSession("councilkit_session=aaaa")).toBe(false);
    expect(cap.hasCsrf("cccc=dddd")).toBe(true);
    expect(cap.hasCsrf("cccc")).toBe(false);
  });

  it("does not accept another capability's session or CSRF token", () => {
    const first = fixedCapability();
    const second = createSessionCapability(scripted(["other-session-token", "other-csrf-token"]));
    expect(second.sessionToken).toBe("other-session-token");
    expect(second.csrfToken).toBe("other-csrf-token");
    expect(first.hasSession("councilkit_session=other-session-token")).toBe(false);
    expect(second.hasSession(SESSION_COOKIE)).toBe(false);
    expect(first.hasCsrf("other-csrf-token")).toBe(false);
    expect(second.hasCsrf(CSRF_TOKEN)).toBe(false);
    expect(second.sessionCookieValue()).toBe(
      "councilkit_session=other-session-token; HttpOnly; SameSite=Strict; Path=/",
    );
  });
});

describe("hasSession", () => {
  const cap = fixedCapability();

  it("rejects missing, malformed, and non-matching cookie headers", () => {
    expect("session-token-aaa".length).toBe(17);
    expect("session-token-zzz".length).toBe(17);
    const rejected: Array<string | undefined> = [
      undefined,
      "",
      ";;;",
      "noequals",
      "councilkit_session=session-token-zzz",
      "councilkit_session=nope",
      "councilkit_session=session-token-aaa-extra",
      "councilkit_session=session-token-%61aa",
      "other=session-token-aaa",
      "xcouncilkit_session=session-token-aaa",
      "councilkit_session_extra=session-token-aaa",
      "Councilkit_session=session-token-aaa",
      "councilkit_session=",
      "=session-token-aaa",
    ];
    expect(rejected.map((cookie) => cap.hasSession(cookie))).toEqual([
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
      false,
      false,
      false,
      false,
    ]);
  });

  it("accepts the session cookie with trimming, extra pairs, and segments that lack '='", () => {
    const accepted = [
      "councilkit_session=session-token-aaa",
      "  councilkit_session = session-token-aaa  ",
      "\tcouncilkit_session\t=\tsession-token-aaa\t",
      "theme=dark; councilkit_session=session-token-aaa; other=1",
      "noequals; councilkit_session=session-token-aaa",
      ";;;councilkit_session=session-token-aaa",
      "councilkit_session=session-token-zzz; councilkit_session=session-token-aaa",
      "councilkit_session=session-token-aaa; HttpOnly; SameSite=Strict; Path=/",
      "councilkit_session=session-token-aaa ",
      " councilkit_session=session-token-aaa",
    ];
    expect(accepted.map((cookie) => cap.hasSession(cookie))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("hasCsrf", () => {
  const cap = fixedCapability();

  it("accepts only the exact CSRF token, including when it is the first array entry", () => {
    expect("csrf-token-bbb".length).toBe(14);
    expect("csrf-token-zzz".length).toBe(14);
    const cases: Array<[string | string[] | undefined, boolean]> = [
      [undefined, false],
      ["", false],
      ["   ", false],
      ["nope", false],
      ["csrf-token-zzz", false],
      ["csrf-token-bbb-extra", false],
      ["session-token-aaa", false],
      [" csrf-token-bbb", false],
      ["csrf-token-bbb ", false],
      ["csrf-token-bbb", true],
      [["csrf-token-bbb"], true],
      [["csrf-token-bbb", "extra"], true],
      [["nope", "csrf-token-bbb"], false],
      [["", "csrf-token-bbb"], false],
      [[], false],
    ];
    for (const [header, expected] of cases) {
      expect(cap.hasCsrf(header), JSON.stringify(header)).toBe(expected);
    }
  });
});

describe("createSessionCapability default CSPRNG", () => {
  it("issues two distinct 32-byte base64url secrets and a fixed cookie suffix", () => {
    const cap = createSessionCapability();
    const other = createSessionCapability();
    expect(cap.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cap.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(other.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(other.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(cap.sessionToken, "base64url").length).toBe(32);
    expect(Buffer.from(cap.csrfToken, "base64url").length).toBe(32);
    expect(Buffer.from(cap.sessionToken, "base64url").toString("base64url")).toBe(cap.sessionToken);
    expect(Buffer.from(cap.csrfToken, "base64url").toString("base64url")).toBe(cap.csrfToken);
    expect(cap.sessionToken).not.toBe(cap.csrfToken);
    expect(cap.sessionToken).not.toBe(other.sessionToken);
    expect(cap.csrfToken).not.toBe(other.csrfToken);
    expect(cap.sessionCookieValue()).toBe(
      `councilkit_session=${cap.sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
    );
    expect(cap.hasSession(`councilkit_session=${cap.sessionToken}`)).toBe(true);
    expect(cap.hasSession(cap.sessionCookieValue())).toBe(true);
    expect(cap.hasSession(`councilkit_session=${cap.csrfToken}`)).toBe(false);
    expect(cap.hasSession(`councilkit_session=${other.sessionToken}`)).toBe(false);
    expect(cap.hasCsrf(cap.csrfToken)).toBe(true);
    expect(cap.hasCsrf(cap.sessionToken)).toBe(false);
    expect(cap.hasCsrf(other.csrfToken)).toBe(false);
    expect(cap.hasCsrf([cap.csrfToken, "extra"])).toBe(true);
    expect(cap.hasCsrf(["extra", cap.csrfToken])).toBe(false);
    expect(cap.hasSession(undefined)).toBe(false);
    expect(cap.hasCsrf(undefined)).toBe(false);
    expect(cap.hasCsrf([])).toBe(false);
    const flipped = `${cap.sessionToken.slice(0, -1)}${cap.sessionToken.endsWith("A") ? "B" : "A"}`;
    expect(flipped.length).toBe(43);
    expect(flipped).not.toBe(cap.sessionToken);
    expect(cap.hasSession(`councilkit_session=${flipped}`)).toBe(false);
    expect(cap.hasCsrf(flipped)).toBe(false);
  });
});
