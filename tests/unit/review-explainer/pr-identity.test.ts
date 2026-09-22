import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANTCODE_PR_URL,
  ASSERTION,
  FINDING,
  MODULES,
  OTHER_ANTCODE_PR_URL,
  OTHER_PR_URL,
  PR_URL,
} from "../../review-explainer/contract";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

const hash = (assertion: string) => createHash("sha256").update(assertion).digest("hex");
const skipped = {
  findingId: FINDING.busy,
  decision: "wont_fix",
  identity: { kind: "stable-id", value: FINDING.busy },
  aliases: [{ id: "h-111111111111", basis: "explicit" }],
  originalAssertion: ASSERTION.busy,
  assertionVersion: 1,
  assertionHash: hash(ASSERTION.busy),
  prUrl: PR_URL,
};
const candidate = {
  id: FINDING.busy,
  title: "prompt accepted then busy",
  text: ASSERTION.busy,
  originalAssertion: ASSERTION.busy,
  assertionVersion: 1,
  assertionHash: hash(ASSERTION.busy),
  prUrl: PR_URL,
};
async function api() {
  const mod = await importFeature<Record<string, unknown>>(MODULES.prDecisions);
  return {
    matches: requireExport<(input: Record<string, unknown>) => { skip: boolean; reason: string }>(
      mod,
      "matchesSkippedIdentity",
      MODULES.prDecisions,
    ),
    skipList: requireExport<(input: Record<string, unknown>) => { ids: string[] }>(
      mod,
      "skipListForPr",
      MODULES.prDecisions,
    ),
  };
}

describe("A05 skipped identity is a frozen assertion, not a file or title", () => {
  it("continues the same assertion across stable ID and explicitly confirmed alias", async () => {
    const { matches } = await api();
    expect(matches({ skipped, candidate }).skip).toBe(true);
    expect(
      matches({
        skipped,
        candidate: {
          ...candidate,
          id: "h-111111111111",
          title: "Plain-language rewording",
          files: ["renamed/session.go"],
        },
      }).skip,
    ).toBe(true);
  });

  it.each([
    {
      ...candidate,
      originalAssertion: ASSERTION.newBusyMechanism,
      text: ASSERTION.newBusyMechanism,
      assertionHash: hash(ASSERTION.newBusyMechanism),
      assertionVersion: 2,
    },
    {
      ...candidate,
      originalAssertion: ASSERTION.newBusyMechanism,
      text: ASSERTION.newBusyMechanism,
      assertionHash: hash(ASSERTION.newBusyMechanism),
    },
    { ...candidate, id: FINDING.freshSameFile, files: ["src/busy.go"] },
    { ...candidate, prUrl: OTHER_PR_URL },
  ])("does not suppress another mechanism, version, unconfirmed ID or PR: %j", async (changed) => {
    const { matches } = await api();
    expect(matches({ skipped, candidate: changed }).skip).toBe(false);
  });

  it("does not use same ID alone when legacy text supplies a different assertion", async () => {
    const { matches } = await api();
    expect(
      matches({
        skipped,
        candidate: {
          id: FINDING.busy,
          title: "another mechanism",
          text: ASSERTION.newBusyMechanism,
          prUrl: PR_URL,
        },
      }).skip,
    ).toBe(false);
  });

  it("normalizes AntCode query/fragment and host casing, preserving PR isolation", async () => {
    const { matches } = await api();
    const antSkip = { ...skipped, prUrl: ANTCODE_PR_URL };
    expect(
      matches({
        skipped: antSkip,
        candidate: {
          ...candidate,
          prUrl: `${ANTCODE_PR_URL.replace("code.alipay.com", "CODE.ALIPAY.COM")}/?tab=commit#comment`,
        },
      }).skip,
    ).toBe(true);
    expect(
      matches({ skipped: antSkip, candidate: { ...candidate, prUrl: OTHER_ANTCODE_PR_URL } }).skip,
    ).toBe(false);
    expect(matches({ skipped: antSkip, candidate }).skip).toBe(false);
  });

  it("a newer explicit undecided/will_fix supersedes prior skip membership", async () => {
    const { matches, skipList } = await api();
    for (const decision of ["undecided", "will_fix"]) {
      const current = { ...skipped, decision };
      expect(matches({ skipped: current, candidate }).skip).toBe(false);
      expect(skipList({ prUrl: PR_URL, items: { [FINDING.busy]: current } }).ids).toEqual([]);
    }
  });

  it("leaves fuzzy aliases undecided rather than inventing an accepted identity", async () => {
    const { matches, skipList } = await api();
    const fuzzy = matches({ skipped, candidate: { ...candidate, id: "h-222222222222" } });
    expect(fuzzy.skip).toBe(false);
    expect(fuzzy.reason).toMatch(/unconfirmed|undecided|no-match|explicit/i);
    expect(skipList({ prUrl: PR_URL, items: { [FINDING.busy]: skipped } }).ids).toEqual([
      FINDING.busy,
    ]);
  });
});
