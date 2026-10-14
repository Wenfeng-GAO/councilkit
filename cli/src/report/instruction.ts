/**
 * Reporter instruction (plan-a §5, §7). The Reporter is the council's
 * explicitly-designated agent that makes ONE final summary call after the N
 * ordinary rounds. Its instruction demands a Markdown decision report with
 * exactly nine level-2 sections, and explicit references to the participating
 * agents and their points.
 *
 * The nine headings are `REPORT_SECTION_HEADINGS` in
 * `@shared/runtime/report-sections` (product.md §5.5), the same list the
 * browser report instruction embeds. The wire instruction kind is `summary`
 * (same persist→ACK lineage as a browser summary); the CLI names it "report".
 */
import { REPORT_SECTION_HEADINGS } from "@shared/runtime/report-sections";
import type { CouncilSnapshot } from "../run/types";

export { REPORT_SECTION_HEADINGS };

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
