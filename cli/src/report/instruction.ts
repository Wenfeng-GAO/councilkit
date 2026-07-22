/**
 * Reporter instruction (plan-a §5, §7). The Reporter is the council's
 * explicitly-designated agent that makes ONE final summary call after the N
 * ordinary rounds. Its instruction demands a Markdown decision report with
 * exactly nine level-2 sections, and explicit references to the participating
 * agents and their points.
 *
 * Sync-point: the nine section headings are copied verbatim from
 * `src/orchestrator/discussion-instructions.ts` `REPORT_SECTION_HEADINGS`
 * (product.md §5.5). If the source section set changes, mirror it here and
 * update the nine-section unit test. The wire instruction kind is `summary`
 * (same persist→ACK lineage as a browser summary); the CLI names it "report".
 */
import type { CouncilSnapshot } from "../run/types";

/** The nine required Markdown level-2 section headings, in order. Copied from
 * `src/orchestrator/discussion-instructions.ts` REPORT_SECTION_HEADINGS
 * (sync-point). A unit test asserts this array has exactly nine entries. */
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

export const REPORT_WIRE_KIND = "summary" as const;

/** Build the Reporter instruction text. Always lists the nine required section
 * headings and names every participating agent so the model can reference them. */
export function reporterInstruction(input: {
  council: Pick<CouncilSnapshot, "topic" | "background" | "targetOutput">;
  agentNames: ReadonlyArray<string>;
  reporterName: string;
}): string {
  const headings = REPORT_SECTION_HEADINGS.join("\n");
  const roster = input.agentNames.map((n) => `- ${n}`).join("\n");
  const parts: string[] = [
    `You are "${input.reporterName}", the Reporter of a structured multi-agent council on the topic: ${input.council.topic}.`,
    "All ordinary discussion rounds are complete. The shared context above contains every agent's speeches.",
    "Produce the final decision report as Markdown. It MUST strictly contain the following nine sections, each starting with a level-2 Markdown heading (## …), in this exact order:",
    headings,
    `In "Participating agents" and throughout the report, explicitly reference the participating agents by name and cite their points:`,
    roster,
    "Do not fabricate consensus that the discussion did not reach. Where agents disagreed, surface the disagreement. Output only the report body.",
  ];
  if (input.council.targetOutput.trim().length > 0) {
    parts.push(`Target output: ${input.council.targetOutput.trim()}`);
  }
  return parts.join("\n");
}
