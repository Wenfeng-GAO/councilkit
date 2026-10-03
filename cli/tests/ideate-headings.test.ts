import { describe, expect, it } from "vitest";
import { renderIdeateReport } from "../src/auto/ideate-report";
import type { IdeateReportInput } from "../src/auto/ideate-report";
import { IDEATE_REPORT_HEADINGS, missingReportHeadings } from "../src/auto/templates/ideate";

const REAL = IDEATE_REPORT_HEADINGS.map((heading) => `${heading}\n正文`).join("\n\n");

function quotedOutline(marker: (heading: string) => string): string {
  return ["只有引用，没有正文章节。", "", ...IDEATE_REPORT_HEADINGS.map(marker)].join("\n");
}

function report(output: string): string {
  const input: IdeateReportInput = {
    runId: "ck-ideate-headings",
    startedAt: "2026-10-03T00:00:00.000Z",
    endedAt: "2026-10-03T00:01:00.000Z",
    idea: "quoted headings",
    background: "",
    debateRounds: 0,
    status: "completed",
    integrity: {
      plannedProposals: 1,
      successfulProposals: 1,
      plannedDebates: 0,
      successfulDebates: 0,
      configuredModels: 1,
      successfulModels: 1,
      incomplete: false,
      degradedReasons: [],
      contextTruncated: false,
      failedSeats: [],
    },
    aggregator: { agentName: "Agg", driverId: "grok-stream-json", modelId: "grok" },
    aggregation: {
      attemptId: "aggregate-final",
      agentId: "agg",
      agentName: "Agg",
      driverId: "grok-stream-json",
      modelId: "grok",
      status: "success",
      output,
      exitCode: 0,
      durationMs: 1,
      workspace: "/tmp/ideate",
    },
    proposals: [],
    debates: [],
  };
  return renderIdeateReport(input);
}

describe("ideate chapter headings", () => {
  it("accepts real chapters and ignores the same headings inside a fence, a quote, or an indented sample", () => {
    expect(missingReportHeadings(REAL)).toEqual([]);
    expect(
      missingReportHeadings(IDEATE_REPORT_HEADINGS.map((heading) => `   ${heading}`).join("\n")),
    ).toEqual([]);
    const fenced = ["```md", ...IDEATE_REPORT_HEADINGS, "```", "", REAL].join("\n");
    expect(missingReportHeadings(fenced)).toEqual([]);
    expect(missingReportHeadings(quotedOutline((heading) => `> ${heading}`))).toEqual([
      ...IDEATE_REPORT_HEADINGS,
    ]);
    expect(
      missingReportHeadings(
        ["```", ...IDEATE_REPORT_HEADINGS, "```", "自由正文，没有二级标题。"].join("\n"),
      ),
    ).toEqual([...IDEATE_REPORT_HEADINGS]);
    expect(
      missingReportHeadings(
        ["~~~", ...IDEATE_REPORT_HEADINGS, "~~~", "自由正文，没有二级标题。"].join("\n"),
      ),
    ).toEqual([...IDEATE_REPORT_HEADINGS]);
    expect(
      missingReportHeadings(IDEATE_REPORT_HEADINGS.map((heading) => `    ${heading}`).join("\n")),
    ).toEqual([...IDEATE_REPORT_HEADINGS]);
  });

  it("warns in the report when every required heading is only quoted", () => {
    const quoted = ["```md", ...IDEATE_REPORT_HEADINGS, "```"].join("\n");
    expect(report(quoted)).toContain(`> 关键章节缺失：${IDEATE_REPORT_HEADINGS.join("、")}`);
    expect(report(REAL)).not.toContain("关键章节缺失");
  });
});
