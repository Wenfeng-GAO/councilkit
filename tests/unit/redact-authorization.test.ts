/**
 * Authorization header values are the rest of the field. A matcher that keeps
 * only the first word treats the scheme (`Basic`, `Digest`) as the secret and
 * leaves the credential in exported diagnostics, observation text, and publish
 * messages.
 */
import { redactObservationText } from "@shared/runtime/repair-observation";
import { sanitizePublishMessage } from "@shared/runtime/squad-bridge-contract";
import { describe, expect, it } from "vitest";
import { redactDriverDiagnostic } from "../../cli/src/auto/driver-terminal";
import { redact } from "../../cli/src/redact";
import { createLogger } from "../../runtime-host/logging";

const BASIC = "Authorization: Basic c2VjcmV0OnBhc3M";
const DIGEST = 'Authorization: Digest username="ada", response="DIGESTSECRET"';
const PROXY = "Proxy-Authorization: Basic PROXYSECRET";
const SAME_LINE = "note; Authorization: Basic SAMESECRET; tail=visible";

function expectCredentialGone(text: string): void {
  expect(text).not.toContain("c2VjcmV0OnBhc3M");
  expect(text).not.toContain("DIGESTSECRET");
  expect(text).not.toContain("PROXYSECRET");
  expect(text).not.toContain("SAMESECRET");
  expect(text).not.toContain("BARESECRET");
  expect(text).toContain("tail=visible");
}

describe("authorization header redaction", () => {
  it("drops scheme-plus-credential values from observation text", () => {
    const out = redactObservationText(
      [BASIC, DIGEST, PROXY, SAME_LINE, "Basic BARESECRET"].join("\n"),
    );
    expectCredentialGone(out);
    expect(out).toContain("[REDACTED]");
  });

  it("drops them from the exported problem ring and the diagnostics ring", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    logger.warn("driver.auth", { stderr: `${BASIC}\n${DIGEST}` });
    logger.diagnostic("watchdog-stderr", `${PROXY}\nBasic BARESECRET\n${SAME_LINE}`);
    expectCredentialGone(JSON.stringify(logger.recentProblems()));
    expectCredentialGone(JSON.stringify(logger.diagnostics()));
    // Local stderr stays sanitized but unredacted. Only exported rings drop secrets.
    const sink = lines.join("\n");
    expect(sink).toContain("c2VjcmV0OnBhc3M");
    expect(sink).toContain("PROXYSECRET");
  });

  it("drops them from publish diagnostics, driver terminal text, and CLI redact", () => {
    const joined = [BASIC, DIGEST, PROXY, SAME_LINE, "Basic BARESECRET"].join("\n");
    const published = sanitizePublishMessage(joined);
    expectCredentialGone(published);
    expectCredentialGone(String(redact(joined)));
    const driver = redactDriverDiagnostic([PROXY, SAME_LINE, "Basic BARESECRET"].join("\n"));
    expect(driver).not.toContain("PROXYSECRET");
    expect(driver).not.toContain("SAMESECRET");
    expect(driver).not.toContain("BARESECRET");
    expect(driver).toContain("tail=visible");
  });
});
