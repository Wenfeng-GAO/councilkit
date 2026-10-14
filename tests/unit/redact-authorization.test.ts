/**
 * Authorization header values are the rest of the field. A matcher that keeps
 * only the first word treats the scheme (`Basic`, `Digest`) as the secret and
 * leaves the credential in exported diagnostics, observation text, and publish
 * messages.
 */
import { redactObservationText, redactObservationValue } from "@shared/runtime/repair-observation";
import { sanitizePublishMessage } from "@shared/runtime/squad-bridge-contract";
import { describe, expect, it } from "vitest";
import { redactDriverDiagnostic } from "../../cli/src/auto/driver-terminal";
import { redact } from "../../cli/src/redact";
import { createLogger } from "../../runtime-host/logging";

const BASIC = "Authorization: Basic c2VjcmV0OnBhc3M";
const DIGEST = 'Authorization: Digest username="ada", realm="ex;ample", response="DIGESTSECRET"';
const AWS =
  "Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024";
const PROXY = "Proxy-Authorization: Basic PROXYSECRET";
const SAME_LINE = "note; Authorization: Basic SAMESECRET; tail=visible";
const JOINED = [BASIC, DIGEST, AWS, PROXY, SAME_LINE, "Basic BARESECRET"].join("\n");
const JSON_DIGEST = '{"authorization":"Digest username=\\"ada\\", response=\\"DIGESTSECRET\\""}';
const JSON_BEARER = '{"authorization":"Bearer BEARERSECRET"}';
const JSON_OBJECT = '{"authorization":{"authority_ref":"KEEPME"},"title":"pr-profile"}';
const AWS_SIGNATURE = "fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024";

function expectCredentialGone(text: string): void {
  expect(text).not.toContain("c2VjcmV0OnBhc3M");
  expect(text).not.toContain("DIGESTSECRET");
  expect(text).not.toContain("PROXYSECRET");
  expect(text).not.toContain("SAMESECRET");
  expect(text).not.toContain("BARESECRET");
  expect(text).not.toContain("BEARERSECRET");
  expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(text).not.toContain(AWS_SIGNATURE);
  expect(text).toContain("tail=visible");
}

describe("authorization header redaction", () => {
  it("drops scheme-plus-credential values from observation text", () => {
    const out = redactObservationText(JOINED);
    expectCredentialGone(out);
    expect(out).toContain("Authorization: [REDACTED]");
    expect(out).toContain("tail=visible");
    expect(redactObservationText(`${DIGEST}; tail=visible`)).toBe(
      "Authorization: [REDACTED]; tail=visible",
    );
    expect(redactObservationText(`${AWS}; tail=visible`)).toBe(
      "Authorization: [REDACTED]; tail=visible",
    );
    expect(redactObservationText(JSON_DIGEST)).toBe('{"authorization":"[REDACTED]"}');
    expect(redactObservationText(JSON_BEARER)).toBe('{"authorization":"[REDACTED]"}');
    expect(redactObservationText(JSON_OBJECT)).toBe(JSON_OBJECT);
  });

  it("drops them from the exported problem ring and the diagnostics ring", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    const sameLineHeaders = `${DIGEST}; ${AWS}; tail=visible`;
    logger.warn("driver.auth", {
      stderr: sameLineHeaders,
      authorization: 'Digest username="ada", realm="ex;ample", response="DIGESTSECRET"',
    });
    logger.diagnostic("watchdog-stderr", sameLineHeaders);
    expectCredentialGone(JSON.stringify(logger.recentProblems()));
    expectCredentialGone(JSON.stringify(logger.diagnostics()));
    expect(logger.diagnostics()[0]?.message).toBe(
      "Authorization: [redacted]; Authorization: [redacted]; tail=visible",
    );
    expect(logger.recentProblems()[0]?.context).toEqual({
      stderr: "Authorization: [redacted]; Authorization: [redacted]; tail=visible",
      authorization: "[redacted]",
    });
    // Local stderr stays sanitized but unredacted. Only exported rings drop secrets.
    const sink = lines.join("\n");
    expect(sink).toContain("DIGESTSECRET");
    expect(sink).toContain(AWS_SIGNATURE);
  });

  it("drops them from publish diagnostics, driver terminal text, and CLI redact", () => {
    const published = sanitizePublishMessage(JOINED);
    expectCredentialGone(published);
    expect(sanitizePublishMessage(JSON_DIGEST)).toBe('{"authorization":"[redacted]"}');
    expect(sanitizePublishMessage(JSON_OBJECT)).toContain("KEEPME");
    const cliText = String(redact(JOINED));
    expectCredentialGone(cliText);
    expect(redact(JSON_BEARER)).toBe('{"authorization":"[redacted]"}');
    expect(
      redact({
        authorization: 'Digest username="ada", response="DIGESTSECRET"',
        "Proxy-Authorization": "Bearer BEARERSECRET",
        note: "tail=visible",
      }),
    ).toEqual({
      authorization: "[redacted]",
      "Proxy-Authorization": "[redacted]",
      note: "tail=visible",
    });
    const driver = redactDriverDiagnostic(
      [BASIC, DIGEST, PROXY, SAME_LINE, "Basic BARESECRET"].join("\n"),
    );
    expect(driver).not.toContain("c2VjcmV0OnBhc3M");
    expect(driver).not.toContain("DIGESTSECRET");
    expect(driver).not.toContain("PROXYSECRET");
    expect(driver).not.toContain("SAMESECRET");
    expect(driver).not.toContain("BARESECRET");
    expect(driver).toContain("tail=visible");
    expect(driver).toContain("Authorization: [redacted]");
  });

  it("replaces a structural Proxy-Authorization value in observation records", () => {
    expect(
      redactObservationValue({
        "proxy-authorization": 'Digest username="ada", response="DIGESTSECRET"',
        title: "tail=visible",
      }),
    ).toEqual({
      "proxy-authorization": "[REDACTED]",
      title: "tail=visible",
    });
  });
});
