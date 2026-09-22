import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertPrDecision } from "@shared/runtime/review-explainer/pr-decisions";
import { describe, expect, it } from "vitest";
import { extractFindingsFromReport } from "../../../cli/src/auto/ledger";
import { projectPrDecisions } from "../../../cli/src/auto/pr-decisions";
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

describe("A05 confirmed aliases normalize only leading ID metadata", () => {
  const alias = "h-111111111111";
  const decorate = (id: string, body: string) => `\`${id}\` — ${body}`;
  // Exact production ledger shape: the severity/list prefix has been parsed away;
  // the unchanged source citation is part of the saved assertion body.
  const assertionWithLocation = `${ASSERTION.busy} src/busy.go:23`;
  const original = decorate(FINDING.busy, assertionWithLocation);
  const decoratedDecision = {
    ...skipped,
    originalAssertion: original,
    assertionHash: hash(original),
  };
  const observed = (text: string, id = alias) => ({
    id,
    text,
    prUrl: PR_URL,
    assertionVersion: 1,
  });

  it.each(["", "- [major] "])(
    "continues one unchanged assertion when the confirmed leading ID changes (%s)",
    async (prefix) => {
      const { matches } = await api();
      const stored = `${prefix}${original}`;
      expect(
        matches({
          skipped: { ...decoratedDecision, originalAssertion: stored, assertionHash: hash(stored) },
          candidate: observed(`${prefix}${decorate(alias, assertionWithLocation)}`),
        }).skip,
      ).toBe(true);
    },
  );

  it("does not normalize an ID quoted inside the actual assertion body", async () => {
    const { matches } = await api();
    const body = `The stored key \`${FINDING.busy}\` is sent to the wrong request.`;
    const originalWithBodyId = decorate(FINDING.busy, body);
    expect(
      matches({
        skipped: {
          ...decoratedDecision,
          originalAssertion: originalWithBodyId,
          assertionHash: hash(originalWithBodyId),
        },
        candidate: observed(
          decorate(alias, `The stored key \`${alias}\` is sent to the wrong request.`),
        ),
      }).skip,
    ).toBe(false);
  });

  it.each([
    [decorate("h-999999999999", assertionWithLocation), alias],
    [decorate("h-999999999999", assertionWithLocation), "h-999999999999"],
    [decorate(alias, ASSERTION.newBusyMechanism), alias],
    [
      decorate(FINDING.busy, `${assertionWithLocation} ${ASSERTION.newBusyMechanism}`),
      FINDING.busy,
    ],
    [`The review mentioned ${decorate(alias, assertionWithLocation)}`, alias],
  ])("keeps unconfirmed metadata and changed body distinct: %s", async (text, id) => {
    const { matches } = await api();
    expect(matches({ skipped: decoratedDecision, candidate: observed(text, id) }).skip).toBe(false);
  });

  it("does not erase a different assertion version while normalizing the leading ID", async () => {
    const { matches } = await api();
    expect(
      matches({
        skipped: decoratedDecision,
        candidate: { ...observed(decorate(alias, assertionWithLocation)), assertionVersion: 2 },
      }).skip,
    ).toBe(false);
  });
});

describe("A05 undecorated assertions cannot hide a new mechanism through containment", () => {
  it.each([
    `${ASSERTION.busy} ${ASSERTION.newBusyMechanism}`,
    `A different failure quotes an old finding: ${ASSERTION.busy}`,
    `\`${FINDING.busy}\` — ${ASSERTION.busy} src/busy.go:23 ${ASSERTION.newBusyMechanism}`,
    `${ASSERTION.busy} \`src/busy.go:23\` New failure: cancellation bypasses ownership.`,
  ])("keeps prose outside the frozen original assertion open: %s", async (text) => {
    const { matches } = await api();
    expect(matches({ skipped, candidate: { id: FINDING.busy, prUrl: PR_URL, text } }).skip).toBe(
      false,
    );
  });

  it.each(["src/busy.go:23", "`src/busy.go:23-27`"])(
    "preserves only explicit same-body location metadata compatibility: %s",
    async (location) => {
      const { matches } = await api();
      expect(
        matches({
          skipped,
          candidate: {
            id: FINDING.busy,
            prUrl: PR_URL,
            text: `\`${FINDING.busy}\` — ${ASSERTION.busy} ${location}`,
          },
        }).skip,
      ).toBe(true);
    },
  );

  it("real extraction → persisted skip → same-ID successor with another mechanism remains open", () => {
    const home = mkdtempSync(join(tmpdir(), "ck-skip-new-mechanism-"));
    try {
      const extract = (text: string) =>
        extractFindingsFromReport({
          markdown: [
            "# Autonomous Review Report",
            "",
            "---",
            "## Overview",
            "fixture",
            "## Consensus findings",
            `- [major] ${text}`,
            "## Unique findings",
            "",
            "## Disagreements",
            "",
            "## Verdict",
            "comment",
          ].join("\n"),
          runId: "ck-review-11111111-1111-4111-8111-111111111111",
          extractedAt: "2026-09-23T00:00:00.000Z",
          sha: "a".repeat(40),
        });
      const original = extract("Shutdown may return before releasing a lease. src/session.ts:12");
      expect(original.findings).toHaveLength(1);
      const finding = original.findings[0];
      if (!finding) throw new Error("Missing original fixture finding");
      const decision = upsertPrDecision({
        home,
        prUrl: PR_URL,
        finding,
        decision: "wont_fix",
        expectedRevision: 0,
      });
      const successor = extract(
        `\`${finding.id}\` — ${finding.text} New mechanism: after restart, an unrelated session can delete the active lease.`,
      );
      expect(successor.findings).toHaveLength(1);
      expect(successor.findings[0]?.id).toBe(finding.id);
      const projected = projectPrDecisions(successor, decision);
      expect(projected.findings[0]?.text).toContain("New mechanism: after restart");
      expect(projected.findings[0]?.status).toBe("open");
      expect(projected.findings[0]?.acceptedReason).toBeUndefined();
      expect(projected.findings[0]?.acceptedAt).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
