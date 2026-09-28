import type { ExplainerFinding } from "@shared/runtime/review-explainer/contracts";

/** A display-only excerpt; the original title and text remain intact in the detail view. */
export function displayFindingTitle(finding: Pick<ExplainerFinding, "title">): string {
  const title = finding.title.trim();
  const withoutPath = title
    .replace(/^`?(?:[\w.-]+\/)+[\w./-]+(?::\d+(?:-\d+)?)?`?\s*(?:[—–:：-]\s*)?/, "")
    .trim();
  const display = withoutPath || title;
  return display.length > 120 ? `${display.slice(0, 119)}…` : display;
}

/** Older decisions contain a system audit description, not a note written by the user. */
export function displayDecisionReason(reason?: string): string {
  return reason === "用户明确选择此处理决定" ? "" : (reason ?? "");
}
