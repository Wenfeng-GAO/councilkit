import { createHash } from "node:crypto";
import type { FindingsFile, LedgerFinding } from "@shared/runtime/cli-ledger";
import { normalizeReviewPr } from "@shared/runtime/review-case";
import type { DecisionItem, DecisionsFile } from "@shared/runtime/review-explainer/contracts";
import { decisionForFinding, loadPrDecisions } from "@shared/runtime/review-explainer/pr-decisions";

export { loadPrDecisions };

export function loadReviewPrDecisions(
  prUrl: string | undefined,
  home?: string,
): DecisionsFile | undefined {
  return prUrl && normalizeReviewPr(prUrl) ? loadPrDecisions(prUrl, home) : undefined;
}

/** A projection for this execution; never rewrites a historical Run or the PR authority. */
export function projectPrDecisions(file: FindingsFile, decisions: DecisionsFile): FindingsFile {
  return { ...file, findings: file.findings.map((row) => projectFindingDecision(row, decisions)) };
}

function projectFindingDecision(row: LedgerFinding, decisions: DecisionsFile): LedgerFinding {
  const decision = decisionForFinding(decisions, row);
  if (decision?.decision === "wont_fix") {
    return {
      ...row,
      status: "accepted",
      acceptedReason:
        decision.audit?.reason ?? "用户在评审解读中选择不修复；接受风险，未表示已验证关闭。",
      acceptedAt: decision.decidedAt ?? new Date().toISOString(),
    };
  }
  // Current intent overrides inherited acceptance, including descendants created before withdrawal.
  // A reused ID with a different assertion must not inherit its predecessor's acceptance either.
  if (row.status === "accepted" && (decision || controllingDecision(decisions, row))) {
    const { acceptedReason: _reason, acceptedAt: _at, verification: _verification, ...rest } = row;
    return { ...rest, status: "open" };
  }
  return row;
}

function controllingDecision(
  decisions: DecisionsFile,
  finding: LedgerFinding,
): DecisionItem | undefined {
  return Object.values(decisions.items).find(
    (item) =>
      item.findingId === finding.id ||
      item.identity?.value === finding.id ||
      item.aliases?.some((alias) => alias.basis === "explicit" && alias.id === finding.id),
  );
}

/** Return null for unmanaged identities so the established legacy classifier stays compatible. */
export function matchDecisionIdentity(
  decisions: DecisionsFile | undefined,
  prior: LedgerFinding,
  next: LedgerFinding,
): boolean | null {
  if (!decisions) return null;
  const controlled = controllingDecision(decisions, prior) ?? controllingDecision(decisions, next);
  if (!controlled) return null;
  // Identical repeated observations of a new mechanism can be deduplicated without inheriting
  // the saved decision; projection below still requires the original assertion to match.
  if (prior.id === next.id && prior.text === next.text) return true;
  const before = decisionForFinding(decisions, prior);
  const after = decisionForFinding(decisions, next);
  return Boolean(before && after && before.findingId === after.findingId);
}

/** Keep a newly reported mechanism even if a model reuses a controlled historical ID. */
export function separateChangedAssertions(
  prior: readonly LedgerFinding[],
  next: readonly LedgerFinding[],
  decisions: DecisionsFile | undefined,
): LedgerFinding[] {
  return next.map((row) => {
    const old = prior.find((item) => item.id === row.id);
    if (!old || matchDecisionIdentity(decisions, old, row) !== false) return row;
    const suffix = createHash("sha256").update(row.text).digest("hex").slice(0, 12);
    return { ...row, id: `${row.id.slice(0, 140)}-new-${suffix}`, status: "open" };
  });
}
