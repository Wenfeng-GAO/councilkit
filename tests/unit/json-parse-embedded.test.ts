/**
 * Embedded JSON recovery must keep one object when noise contains braces.
 * `indexOf("{")` through `lastIndexOf("}")` treats those braces as the
 * object's ends, so a real payload is dropped. Two top-level objects stay
 * unparsed so a log object cannot replace the payload.
 */
import { jsonParse, jsonParseEmbedded } from "@shared/runtime/json-parse";
import { parseOfficialPolicyFreezeStdout } from "@shared/runtime/squad-gate-policy";
import { describe, expect, it } from "vitest";

const HASH = "a".repeat(64);

describe("jsonParseEmbedded", () => {
  it("parses a whole JSON value, including null and arrays", () => {
    expect(jsonParseEmbedded('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
    expect(jsonParseEmbedded("[1,2]")).toEqual([1, 2]);
    expect(jsonParseEmbedded("null")).toBeNull();
    expect(jsonParseEmbedded("  ")).toBeNull();
    expect(jsonParse("null")).toBeNull();
  });

  it("keeps an object when a string brace is followed by a trailing brace", () => {
    expect(jsonParseEmbedded('{"text":"say } hi","sessionId":"sid"} trailing }')).toEqual({
      text: "say } hi",
      sessionId: "sid",
    });
    expect(jsonParseEmbedded('{"a":"say \\"} hi"} trailing }')).toEqual({ a: 'say "} hi' });
    expect(jsonParseEmbedded('{"a":{"b":"x}y"},"c":[1,{"d":"}"}]} trailing }')).toEqual({
      a: { b: "x}y" },
      c: [1, { d: "}" }],
    });
    expect(jsonParseEmbedded('{"a":"\\u007d"} trailing }')).toEqual({ a: "}" });
  });

  it("keeps the one object after an invalid brace group", () => {
    expect(jsonParseEmbedded('warn {retry}\n{"text":"COUNCILKIT_OK","sessionId":"sid-1"}')).toEqual(
      {
        text: "COUNCILKIT_OK",
        sessionId: "sid-1",
      },
    );
  });

  it("returns null when two top-level objects are present", () => {
    expect(jsonParseEmbedded('{"trusted":false}{"trusted":true}')).toBeNull();
    expect(jsonParseEmbedded('{"a":1}\n{"b":2}')).toBeNull();
  });

  it("parses an official freeze when the note after the object contains a brace", () => {
    const body = JSON.stringify({
      policy_hash: HASH,
      brief_hash: HASH,
    });
    const parsed = parseOfficialPolicyFreezeStdout(`${body}\nsee {docs}`, {
      taskId: "task",
      taskDir: "/tmp/task",
      policyFileHash: HASH,
      policy: {
        required_gates: [
          {
            gate_id: "review",
            role: "reviewer",
            min_realism_tier: "unit_mock",
            baseline_required: false,
            evidence_kind: "supervised",
          },
        ],
        independence: {
          distinct_runs: true,
          distinct_sessions: true,
          distinct_worktrees: true,
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.freeze.policyHash).toBe(HASH);
    expect(parsed.freeze.briefHash).toBe(HASH);
  });

  it("rejects an official freeze when a second object follows the payload", () => {
    const payload = JSON.stringify({ policy_hash: HASH, brief_hash: HASH });
    const other = JSON.stringify({ policy_hash: "b".repeat(64), brief_hash: HASH });
    const parsed = parseOfficialPolicyFreezeStdout(`${payload}\n${other}`, {
      taskId: "task",
      taskDir: "/tmp/task",
      policyFileHash: HASH,
      policy: {
        required_gates: [
          {
            gate_id: "review",
            role: "reviewer",
            min_realism_tier: "unit_mock",
            baseline_required: false,
            evidence_kind: "supervised",
          },
        ],
        independence: {
          distinct_runs: true,
          distinct_sessions: true,
          distinct_worktrees: true,
        },
      },
    });
    expect(parsed).toEqual({ ok: false, reason: "official policy freeze stdout was not JSON" });
  });
});
