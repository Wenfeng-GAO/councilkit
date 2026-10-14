/**
 * The nine Markdown level-2 headings a decision report must contain
 * (product.md §5.5), in order.
 *
 * The browser report instruction and the CLI Reporter instruction both embed
 * this list. The strings are the contract; do not reorder or reword them
 * without the nine-section tests.
 */
export const REPORT_SECTION_HEADINGS = [
  "## Background（背景）",
  "## Discussion goal（讨论目标）",
  "## Participating agents（参与角色）",
  "## Discussion summary（讨论摘要）",
  "## Key consensus（关键共识）",
  "## Remaining disagreements（未决分歧）",
  "## Recommendation（推荐）",
  "## Risks and objections（风险与异议）",
  "## Next actions（下一步行动）",
] as const;
