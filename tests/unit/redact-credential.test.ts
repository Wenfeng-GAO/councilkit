/**
 * Credential names joined with `_` or camelCase never reach the `\b` matchers.
 * `GITHUB_TOKEN=…`, `OPENAI_API_KEY=…`, and `AWS_SECRET_ACCESS_KEY=…` stay
 * intact, and a structural `{ password, apiKey, GITHUB_TOKEN, access_token }`
 * is copied through because the string walker never sees the key.
 * Exported diagnostics, observation text, publish messages, driver diagnostics,
 * and CLI redact all share that hole.
 */
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

const SECRETS = [
  "plainTOKENLEAK",
  "plainAPILEAK",
  "awsLEAKSECRET",
  "askpass-LEAK",
  "plainMYTOKEN",
  "pwLEAK",
  "keyLEAK",
  "structLEAK",
  "promptLEAK",
  "atLEAK",
  "plainANTHROPIC",
];

function expectSecretsGone(text: string): void {
  for (const secret of SECRETS) {
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
    expectSecretsGone(exported);
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
    const text = redactObservationText(
      `${ASSIGNMENTS}\n{"access_token":"atLEAK"}\nhttps://example.test/hook?token=atLEAK`,
    );
    expectSecretsGone(text);
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
    const published = sanitizePublishMessage(
      `${ASSIGNMENTS} {"access_token":"atLEAK"} token = spaced-LEAK`,
    );
    expect(published).not.toContain("plainTOKENLEAK");
    expect(published).not.toContain("plainAPILEAK");
    expect(published).not.toContain("awsLEAKSECRET");
    expect(published).not.toContain("atLEAK");
    expect(published).not.toContain("spaced-LEAK");
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
      detail: expect.stringContaining("GITHUB_TOKEN=[redacted]"),
    });
    const cliText = String(redact(ASSIGNMENTS));
    expect(cliText).not.toContain("plainTOKENLEAK");
    expect(cliText).not.toContain("awsLEAKSECRET");
    expect(cliText).not.toContain("plainAPILEAK");
  });
});
