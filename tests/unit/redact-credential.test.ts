/**
 * Credential names joined with `_` or camelCase never reach the `\b` matchers.
 * `GITHUB_TOKEN=…`, `OPENAI_API_KEY=…`, and `AWS_SECRET_ACCESS_KEY=…` stay
 * intact, and a structural `{ password, apiKey, GITHUB_TOKEN, access_token }`
 * is copied through because the string walker never sees the key.
 * Exported diagnostics, observation text, publish messages, driver diagnostics,
 * and CLI redact all share that hole.
 */
import { redactCredentialMaterial } from "@shared/runtime/redact-credential";
import { redactObservationText, redactObservationValue } from "@shared/runtime/repair-observation";
import { sanitizePublishMessage } from "@shared/runtime/squad-bridge-contract";
import { describe, expect, it } from "vitest";
import { redactDriverDiagnostic } from "../../cli/src/auto/driver-terminal";
import { REDACT_PLACEHOLDER, redact } from "../../cli/src/redact";
import { createLogger } from "../../runtime-host/logging";

const ASSIGNMENTS = [
  "GITHUB_TOKEN=plainTOKENLEAK",
  "OPENAI_API_KEY=plainAPILEAK",
  "AWS_SECRET_ACCESS_KEY=awsLEAKSECRET",
  "GIT_ASKPASS=/tmp/askpass-LEAK",
  "MY_TOKEN=plainMYTOKEN",
].join(" ");

const REDACTED_ASSIGNMENTS = [
  "GITHUB_TOKEN=[redacted]",
  "OPENAI_API_KEY=[redacted]",
  "AWS_SECRET_ACCESS_KEY=[redacted]",
  "GIT_ASKPASS=[redacted]",
  "MY_TOKEN=[redacted]",
].join(" ");

function expectSecretsGone(text: string, source: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    expect(source, `planted ${secret}`).toContain(secret);
    expect(text, secret).not.toContain(secret);
  }
}

describe("prefixed and structural credential redaction", () => {
  it("drops them from the exported problem ring and the diagnostics ring", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    logger.warn("driver.env", {
      detail: ASSIGNMENTS,
      password: "pwLEAK",
      apiKey: "keyLEAK",
      GITHUB_TOKEN: "structLEAK",
      prompt: "promptLEAK",
      nativeSession: "cursor-keep",
      input_tokens: 12,
      note: "tail=visible",
    });
    logger.diagnostic(
      "watchdog-stderr",
      "ANTHROPIC_API_KEY=plainANTHROPIC personaPrompt=keep-persona",
    );

    const exported = JSON.stringify({
      problems: logger.recentProblems(),
      diagnostics: logger.diagnostics(),
    });
    expectSecretsGone(
      exported,
      `${ASSIGNMENTS} pwLEAK keyLEAK structLEAK promptLEAK plainANTHROPIC`,
      [
        "plainTOKENLEAK",
        "plainAPILEAK",
        "awsLEAKSECRET",
        "askpass-LEAK",
        "plainMYTOKEN",
        "pwLEAK",
        "keyLEAK",
        "structLEAK",
        "promptLEAK",
        "plainANTHROPIC",
      ],
    );
    expect(exported).toContain("cursor-keep");
    expect(exported).toContain('"input_tokens":12');
    expect(exported).toContain("keep-persona");
    expect(exported).toContain("tail=visible");
    expect(exported).toContain("personaPrompt=keep-persona");

    const sink = lines.join("\n");
    expect(sink).toContain("plainTOKENLEAK");
    expect(sink).toContain("pwLEAK");
  });

  it("drops them from observation text and structural records", () => {
    const observed = `${ASSIGNMENTS}\n{"access_token":"atLEAK"}\nhttps://example.test/hook?token=atLEAK`;
    const text = redactObservationText(observed);
    expectSecretsGone(text, observed, [
      "plainTOKENLEAK",
      "plainAPILEAK",
      "awsLEAKSECRET",
      "askpass-LEAK",
      "plainMYTOKEN",
      "atLEAK",
    ]);
    expect(text).toContain("[REDACTED]");
    expect(redactObservationText("personaPrompt=keep-persona")).toContain("keep-persona");

    const value = redactObservationValue({
      access_token: "atLEAK",
      OPENAI_API_KEY: "sk-LEAKAPIKEY",
      password: "pwLEAK",
      nativeSession: "cursor-keep",
      title: "tail=visible",
    });
    const encoded = JSON.stringify(value);
    expect(encoded).not.toContain("atLEAK");
    expect(encoded).not.toContain("sk-LEAKAPIKEY");
    expect(encoded).not.toContain("pwLEAK");
    expect(encoded).toContain("cursor-keep");
    expect(encoded).toContain("tail=visible");
  });

  it("drops them from publish diagnostics, driver terminal text, and CLI redact", () => {
    const publishSource = `${ASSIGNMENTS} {"access_token":"atLEAK"} token = spaced-LEAK`;
    const published = sanitizePublishMessage(publishSource);
    expectSecretsGone(published, publishSource, [
      "plainTOKENLEAK",
      "plainAPILEAK",
      "awsLEAKSECRET",
      "askpass-LEAK",
      "plainMYTOKEN",
      "atLEAK",
      "spaced-LEAK",
    ]);
    expect(published).toContain("GITHUB_TOKEN=[redacted]");
    expect(published).toContain('"access_token":"[redacted]"');

    const driver = redactDriverDiagnostic(
      "unauthorized; GITHUB_TOKEN=plainTOKENLEAK; X-Api-Key: keyLEAK\nCookie: theme=light; sessionid=sidLEAK\ntail=visible",
    );
    expect(driver).not.toContain("plainTOKENLEAK");
    expect(driver).not.toContain("keyLEAK");
    expect(driver).not.toContain("sidLEAK");
    expect(driver).toContain("tail=visible");
    expect(driver).toContain("[redacted]");
    const cookieJson = redactObservationText('{"cookie":"cookLEAK","title":"tail=visible"}');
    expect(cookieJson).not.toContain("cookLEAK");
    expect(cookieJson).toContain("tail=visible");

    expect(
      redact({
        password: "pwLEAK",
        apiKey: "keyLEAK",
        GITHUB_TOKEN: "structLEAK",
        nativeSession: "cursor-keep",
        detail: ASSIGNMENTS,
      }),
    ).toEqual({
      password: REDACT_PLACEHOLDER,
      apiKey: REDACT_PLACEHOLDER,
      GITHUB_TOKEN: REDACT_PLACEHOLDER,
      nativeSession: "cursor-keep",
      detail: REDACTED_ASSIGNMENTS,
    });
    expect(String(redact(ASSIGNMENTS))).toBe(REDACTED_ASSIGNMENTS);
  });

  it("redacts a bearer second word, bracket values, and a semicolon inside the value", () => {
    const cases = [
      ["token: Bearer PLAINSECRET", "token: [redacted]"],
      ["api_key: Bearer PLAINSECRET", "api_key: [redacted]"],
      ["GITHUB_TOKEN: Bearer PLAINSECRET", "GITHUB_TOKEN: [redacted]"],
      ["password=Bearer PLAINSECRET", "password=[redacted]"],
      ["password={braceLEAK}", "password=[redacted]"],
      ["password=[bracketLEAK]", "password=[redacted]"],
      ["access_token={braceLEAK}", "access_token=[redacted]"],
      ["access_token=[bracketLEAK]", "access_token=[redacted]"],
      ['password={"blob":"jsonLEAK"}', "password=[redacted]"],
      ['password={ "blob": "spacedLEAK" }', "password=[redacted]"],
      ["password={braceLEAK} tail=visible", "password=[redacted] tail=visible"],
      ["password=foo;semiLEAK", "password=[redacted]"],
      ["password=semiWORD; tail=visible", "password=[redacted]; tail=visible"],
      ["Bearer abc,commaLEAK", "Bearer [redacted]"],
      ['{"note":"Bearer commaLEAK"}', '{"note":"Bearer [redacted]"}'],
      ["see Bearer SECRET}", "see Bearer [redacted]}"],
      [
        '{"authorization":{"authority_ref":"KEEPME"}}',
        '{"authorization":{"authority_ref":"KEEPME"}}',
      ],
      ["https://example.test?token=queryLEAK&x=1", "https://example.test?token=[redacted]&x=1"],
      ["secretkey=plainLEAK", "secretkey=[redacted]"],
      ["accesstoken=plainLEAK", "accesstoken=[redacted]"],
      ["sessiontoken=plainLEAK", "sessiontoken=[redacted]"],
      ["myaccesstoken=plainLEAK", "myaccesstoken=[redacted]"],
      ["clientsecret=plainLEAK", "clientsecret=[redacted]"],
      ["api_key='abc'defLEAK", "api_key=[redacted]"],
      ['api_key="abc"defLEAK', "api_key=[redacted]"],
      ["password='x'y'zLEAK", "password=[redacted]"],
      ["token='keep' tail=visible", "token='[redacted]' tail=visible"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(redactCredentialMaterial(input, "[redacted]"), input).toBe(expected);
    }

    const raw = [
      "token: Bearer PLAINSECRET",
      "password={braceLEAK}",
      "access_token=[bracketLEAK]",
      'api_key={"blob":"jsonLEAK"}',
      "secret=foo;semiLEAK",
      "Bearer abc,commaLEAK",
      "tail=visible",
    ].join(" ");
    const leaks = ["PLAINSECRET", "braceLEAK", "bracketLEAK", "jsonLEAK", "semiLEAK", "commaLEAK"];
    expectSecretsGone(redactObservationText(raw), raw, leaks);
    expect(redactObservationText(raw)).toContain("tail=visible");
    expect(redactObservationText("https://example.test?token=queryLEAK&x=1")).toBe(
      "https://example.test?token=[REDACTED]&x=1",
    );
    expect(
      redactObservationText("https://example.test?token=queryLEAK&key=keyLEAK&auth=authLEAK"),
    ).toBe("https://example.test?token=[REDACTED]&key=[REDACTED]&auth=[REDACTED]");

    const published = sanitizePublishMessage(raw);
    expectSecretsGone(published, raw, leaks);
    expect(published).toContain("tail=visible");
    expect(sanitizePublishMessage("https://example.test?token=queryLEAK&x=1")).toBe(
      "https://example.test?token=[redacted]&x=1",
    );

    const driver = redactDriverDiagnostic(raw);
    expectSecretsGone(driver, raw, leaks);
    expect(driver).toContain("tail=visible");

    expectSecretsGone(String(redact(raw)), raw, leaks);
    expect(String(redact(raw))).toContain("tail=visible");

    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    logger.warn("driver.env", { detail: raw });
    const exported = JSON.stringify(logger.recentProblems());
    expectSecretsGone(exported, raw, leaks);
    expect(exported).toContain("tail=visible");
    expect(lines.join("\n")).toContain("PLAINSECRET");
  });
});
