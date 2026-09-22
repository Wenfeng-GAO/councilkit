import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveCouncilkitHome } from "../cli-home";
import type { LedgerFinding } from "../cli-ledger";
import { normalizeReviewPr } from "../review-case";
import type { DecisionItem, DecisionsFile, FindingDecision } from "./contracts";
import { applyFindingDecision, readFindingDecisions } from "./decisions";
import { ExplainerError, assertPrivatePath } from "./io";

export function canonicalPr(pr: string): string {
  const url = new URL(pr);
  if (url.username || url.password) throw new ExplainerError("Invalid PR identity");
  const normalized = normalizeReviewPr(pr);
  if (!normalized) throw new ExplainerError("Unsupported PR identity");
  return normalized;
}
export function prDecisionsPath(home: string, prUrl: string): string {
  const url = new URL(canonicalPr(prUrl));
  const parts = url.pathname.split("/").filter(Boolean);
  const project = parts.slice(0, -2).join("__");
  return join(home, "pr-decisions", `${url.hostname}__${project}#${parts.at(-1)}.json`);
}
export function loadPrDecisions(
  prUrl: string,
  home = resolveCouncilkitHome(process.env),
): DecisionsFile {
  const normalized = canonicalPr(prUrl);
  const file = prDecisionsPath(home, normalized);
  assertPrivatePath(home, file, true);
  const result = readFindingDecisions(file);
  if (result.prUrl && canonicalPr(result.prUrl) !== normalized)
    throw new ExplainerError("Decision PR identity mismatch", 409);
  return { ...result, prUrl: normalized };
}
export function upsertPrDecision(input: {
  prUrl: string;
  home?: string;
  finding: LedgerFinding;
  decision: FindingDecision;
  expectedRevision: number;
  sourceRunId?: string;
  reason?: string;
}): DecisionsFile {
  const home = input.home ?? resolveCouncilkitHome(process.env);
  const prUrl = canonicalPr(input.prUrl);
  const current = loadPrDecisions(prUrl, home);
  const existing = decisionForFinding(current, input.finding);
  const findingId = existing?.findingId ?? input.finding.id;
  const originalAssertion =
    existing?.originalAssertion ?? (input.finding.text || input.finding.title);
  return applyFindingDecision({
    file: prDecisionsPath(home, prUrl),
    root: home,
    prUrl,
    findingId,
    decision: input.decision,
    expectedRevision: input.expectedRevision,
    item: {
      identity: { kind: "stable-id", value: findingId },
      originalAssertion,
      assertionHash: hashAssertion(originalAssertion),
      assertionVersion: existing?.assertionVersion ?? 1,
      aliases: existing?.aliases ?? [],
      sourceRunId: input.sourceRunId,
      decidedAt: new Date().toISOString(),
      audit: { event: "user_clicked", reason: input.reason ?? "用户明确选择此处理决定" },
    },
  });
}
export function hashAssertion(assertion: string): string {
  return createHash("sha256").update(assertion).digest("hex");
}
type Candidate = {
  id: string;
  text: string;
  prUrl: string;
  originalAssertion?: string;
  assertionVersion?: number;
  assertionHash?: string;
};
/** Strip only a confirmed ID marker at the start of a report entry.
 * IDs elsewhere are assertion data. Never substitute them in the body. */
function leadingIdentityBody(text: string, item: DecisionItem): { body: string; marked: boolean } {
  const marker =
    /^(?:[-*][ \t]+)?(?:\[(?:critical|major|minor|nit)\][ \t]+)?`([^`\n]+)`[ \t]+(?:—|–|-|:)[ \t]+/.exec(
      text,
    );
  const id = marker?.[1];
  const confirmed =
    id === item.findingId ||
    item.aliases?.some((alias) => alias.basis === "explicit" && alias.id === id) === true;
  return marker && confirmed
    ? { body: text.slice(marker[0].length), marked: true }
    : { body: text, marked: false };
}
function sameAssertion(skipped: DecisionItem, candidate: Candidate): boolean {
  if (!skipped.originalAssertion) return false;
  if (
    candidate.assertionVersion !== undefined &&
    skipped.assertionVersion !== undefined &&
    candidate.assertionVersion !== skipped.assertionVersion
  )
    return false;
  if (
    candidate.assertionHash !== undefined &&
    candidate.assertionHash !== (skipped.assertionHash ?? hashAssertion(skipped.originalAssertion))
  )
    return false;
  const text = candidate.originalAssertion ?? candidate.text;
  const original = leadingIdentityBody(skipped.originalAssertion, skipped);
  const body = leadingIdentityBody(text, skipped).body;
  if (body === original.body) return true;
  // Compatibility for an older bare assertion followed by one explicit source
  // citation. Never match an assertion quoted inside prose or followed by a new
  // mechanism; decorated/explicit assertions must match their entire body.
  if (original.marked || candidate.originalAssertion || !body.startsWith(original.body))
    return false;
  const suffix = body.slice(original.body.length);
  const location = /^[ \t]+(`?)([\w.-]+(?:\/[\w.-]+)*):([1-9]\d*)(?:-([1-9]\d*))?\1[ \t]*$/.exec(
    suffix,
  );
  if (!location || location[2]?.split("/").some((part) => part === "." || part === ".."))
    return false;
  const start = Number(location[3]);
  const end = Number(location[4] ?? location[3]);
  return (
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start && end <= 10_000_000
  );
}
function identityMatch(item: DecisionItem, candidate: Candidate): boolean {
  return (
    (item.findingId === candidate.id ||
      item.aliases?.some((alias) => alias.basis === "explicit" && alias.id === candidate.id) ===
        true) &&
    sameAssertion(item, candidate)
  );
}
export function matchesSkippedIdentity(input: {
  skipped: DecisionItem & { prUrl: string };
  candidate: Candidate;
}): { skip: boolean; reason: string } {
  if (canonicalPr(input.skipped.prUrl) !== canonicalPr(input.candidate.prUrl))
    return { skip: false, reason: "different-pr" };
  if (input.skipped.decision !== "wont_fix")
    return { skip: false, reason: "undecided-or-selected" };
  const skip = identityMatch(input.skipped, input.candidate);
  return { skip, reason: skip ? "explicit-same-assertion" : "unconfirmed-identity-or-assertion" };
}
export function decisionForFinding(
  file: DecisionsFile,
  candidate: LedgerFinding,
): DecisionItem | undefined {
  return Object.values(file.items).find((item) =>
    identityMatch(item, { ...candidate, prUrl: file.prUrl ?? "" }),
  );
}
export function skipListForPr(input: { prUrl: string; items: Record<string, DecisionItem> }): {
  ids: string[];
  items: Array<DecisionItem & { prUrl: string }>;
} {
  const prUrl = canonicalPr(input.prUrl);
  const items = Object.values(input.items)
    .filter((item) => item.decision === "wont_fix" && item.originalAssertion)
    .map((item) => ({ ...item, prUrl }));
  return { ids: items.map((item) => item.findingId), items };
}
