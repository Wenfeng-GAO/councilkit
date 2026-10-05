import type {
  ExplainerFinding,
  ExplanationPayload,
} from "@shared/runtime/review-explainer/contracts";

const LEADING_SOURCE_FILE =
  /^`?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][A-Za-z0-9-]*(?=$|[:`\s—–：-])(?::\d+(?:-\d+)?)?`?\s*(?:[—–:：-]\s*)?/;

/** A display-only excerpt; the original title and text remain intact in the detail view. */
export function displayFindingTitle(
  finding: Pick<ExplainerFinding, "title">,
  summary?: string | null,
): string {
  if (summary) return summary;
  const title = finding.title.trim();
  const withoutPath = title.replace(LEADING_SOURCE_FILE, "").trim();
  const display = withoutPath || title;
  return display.length > 120 ? `${display.slice(0, 119)}…` : display;
}

/** Older decisions contain a system audit description, not a note written by the user. */
export function displayDecisionReason(reason?: string): string {
  return reason === "用户明确选择此处理决定" ? "" : (reason ?? "");
}

/** A title is a complete model summary, never a truncated assertion posing as one. */
export function explanationSummaryTitle(payload: ExplanationPayload): string | null {
  const title = payload.title?.replace(/\s+/g, " ").trim();
  if (title && title.length <= 80) return title;
  const assertion = payload.assertion.replace(/\s+/g, " ").trim();
  return assertion && assertion.length <= 80 ? assertion : null;
}
