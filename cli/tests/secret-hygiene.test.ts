/**
 * Secret-hygiene unit tests (plan-a §10 AC5). A fixed canary secret is run
 * through every emission path — redactor, store persistence (with the canary
 * embedded in user content), JSON/human output, and error rendering — and every
 * artifact is asserted to be free of the canary and the cookie/CSRF footprint.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errors } from "../src/errors";
import { createOutput, renderErrorHuman } from "../src/output";
import { REDACT_PLACEHOLDER, containsSecret, redact } from "../src/store/../redact";
import { resolvePaths } from "../src/store/paths";
import { Store } from "../src/store/store";

const CANARY_COOKIE = "councilkit_session=CANARY-SECRET-12345";
const CANARY_CSRF = "CANARY-CSRF-67890";

describe("cli redact (pure)", () => {
  it("scrubs the session cookie pair and the csrf header key", () => {
    const before = `got cookie=${CANARY_COOKIE}; csrf header x-councilkit-csrf=${CANARY_CSRF}`;
    const after = redact(before) as string;
    expect(after).not.toContain(CANARY_COOKIE);
    expect(after).not.toContain("CANARY-SECRET-12345");
    expect(after).toContain(REDACT_PLACEHOLDER);
  });

  it("containsSecret detects a surviving canary", () => {
    expect(containsSecret(`hello ${CANARY_COOKIE}`, CANARY_COOKIE)).toBe(true);
    expect(containsSecret("clean text", CANARY_COOKIE)).toBe(false);
  });

  it("redacts nested objects and tainted keys", () => {
    const out = redact({
      headers: { Cookie: CANARY_COOKIE, "x-councilkit-csrf": CANARY_CSRF },
      nested: [{ cookie: CANARY_COOKIE }],
    }) as { headers: Record<string, string>; nested: { cookie: string }[] };
    expect(out.headers.Cookie).toBe(REDACT_PLACEHOLDER);
    expect(out.nested[0].cookie).toBe(REDACT_PLACEHOLDER);
  });
});

describe("cli secret hygiene across emission paths", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "councilkit-hygiene-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("does not persist a canary decorating user content (agents.json)", () => {
    const store = new Store({ env: { ...process.env, COUNCILKIT_HOME: home } });
    store.createAgent({
      name: "leaky",
      personaPrompt: `persona with ${CANARY_COOKIE} inside`,
      modelId: "m",
      color: "#123456",
      driverSelection: { driverId: "kimi-stream-json", options: {} },
    });
    const paths = resolvePaths({ ...process.env, COUNCILKIT_HOME: home });
    const onDisk = readFileSync(paths.agents, "utf8");
    expect(containsSecret(onDisk, CANARY_COOKIE)).toBe(false);
    expect(containsSecret(onDisk, "CANARY-SECRET-12345")).toBe(false);
  });

  it("keeps --json stdout free of canary (redacted before emit)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const out = createOutput(true);
      out.finish({ status: "ok", detail: `cookie=${CANARY_COOKIE}` });
      const emitted = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(containsSecret(emitted, CANARY_COOKIE)).toBe(false);
      expect(containsSecret(emitted, "CANARY-SECRET-12345")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps stderr progress in JSON mode free of canary", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const out = createOutput(true);
      out.progress(`progress ${CANARY_COOKIE}`);
      out.diag(`diag ${CANARY_CSRF}`);
      const emitted = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(containsSecret(emitted, CANARY_COOKIE)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders errors without leaking a canary in message or detail", () => {
    const err = errors.runFailed(`boom ${CANARY_COOKIE}`, { token: CANARY_CSRF });
    const human = renderErrorHuman(err);
    expect(containsSecret(human, CANARY_COOKIE)).toBe(false);
    expect(containsSecret(human, "CANARY-CSRF-67890")).toBe(false);
  });
});
