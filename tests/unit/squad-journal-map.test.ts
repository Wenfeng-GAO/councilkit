import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canRequestPublish } from "@shared/runtime/squad-bridge-contract";
import {
  eventKindFromSquadStatus,
  journalFromSquadStatus,
} from "@shared/runtime/squad-journal-map";
import { describe, expect, it } from "vitest";

const actual = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/squad-status-official.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const SHA = "9c0e83b83496b47590667532e71b2ffdca9fd7de";
const POLICY = "b07590c09986aadf0b193743e3cf82026709003d2ffa8cec95a86ceaffbaf263";

describe("journalFromSquadStatus", () => {
  it("accepts the official completed candidate + aggregate + independence shape", () => {
    const journal = journalFromSquadStatus(actual);
    expect(journal.candidateSha).toBe(SHA);
    expect(journal.gatePolicyHash).toBe(POLICY);
    expect(journal.independentReview).toBe(true);
    expect(journal.independentVerify).toBe(true);
    expect(journal.requiredGatesPassed).toBe(true);
    expect(journal.invalidated).toBe(false);
    expect(eventKindFromSquadStatus(actual)).toBe("running");
    expect(
      canRequestPublish({
        kind: "candidate_ready",
        journal,
      }),
    ).toBe(true);
  });

  it("is candidate_ready only after phase=integrating", () => {
    expect(
      eventKindFromSquadStatus({ ...actual, phase: "integrating", control_status: "active" }),
    ).toBe("candidate_ready");
  });

  it("does not treat missing aggregate as a pass", () => {
    const journal = journalFromSquadStatus({
      ...actual,
      projection: {},
    });
    expect(journal.requiredGatesPassed).toBe(false);
    expect(journal.independentReview).toBe(false);
    expect(journal.independentVerify).toBe(false);
  });

  it("ignores superseded or old-fail gates on another SHA", () => {
    const journal = journalFromSquadStatus({
      ...actual,
      gates: [
        {
          gate_id: "review",
          role: "reviewer",
          verdict: "fail",
          candidate_sha: "a".repeat(40),
        },
      ],
    });
    expect(journal.requiredGatesPassed).toBe(true);
  });

  it("does not pass when independence is not satisfied even if gates look green", () => {
    const journal = journalFromSquadStatus({
      ...actual,
      independence: {
        ...(actual.independence as object),
        policy_status: "degraded",
      },
    });
    expect(journal.requiredGatesPassed).toBe(false);
  });

  it("allows actual_identity_complete=false with policy satisfied", () => {
    const independence = actual.independence as { actual_identity_complete: boolean };
    expect(independence.actual_identity_complete).toBe(false);
    expect(journalFromSquadStatus(actual).requiredGatesPassed).toBe(true);
  });

  it("does not pass an incomplete candidate", () => {
    const journal = journalFromSquadStatus({
      ...actual,
      candidate: { ...(actual.candidate as object), status: "pending" },
    });
    expect(journal.requiredGatesPassed).toBe(false);
  });
});
