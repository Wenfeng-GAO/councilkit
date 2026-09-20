import { FindingLedger } from "@/components/report/FindingLedger";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("FindingLedger candidate evidence", () => {
  it.each(["a".repeat(40), "b".repeat(40), null])(
    "renders proof against the current candidate %s",
    (sha) => {
      const run = cliRunDetailResponseSchema.parse({
        runId: "review-current",
        kind: "review",
        status: "completed",
        title: "Review",
        startedAt: null,
        endedAt: null,
        hasReport: true,
        reportUrl: "/reports/review-current",
        progress: null,
        markdown: "",
        truncated: false,
        reviewEvidence: sha
          ? {
              complete: true,
              sha,
              prUrl: null,
              againstRunId: "review-prior",
              blockingIds: [],
              unverifiedFixIds: [],
              openIds: [],
            }
          : null,
        findings: [
          {
            id: "F-1",
            title: "Content loss",
            text: "Content loss",
            severity: "critical",
            status: "closed",
            source: "unique",
            reviewer: null,
            files: [],
            verification: {
              outcome: "verified_closed",
              candidateSha: "a".repeat(40),
              runId: "review-prior",
              attemptId: "attempt-0",
              reviewer: "independent reviewer",
              method: "code_trace",
              reason: "Failed writes retain text",
              evidence: "Return precedes buffer clearing",
              locations: ["src/runtime.ts:42"],
              runComplete: true,
            },
          },
        ],
      });
      const html = renderToStaticMarkup(createElement(FindingLedger, { run }));
      if (sha === "a".repeat(40)) {
        expect(html).toContain("已验证解决");
        expect(html).toContain("0 阻塞");
      } else {
        expect(html).toContain("待验证当前提交");
        expect(html).toContain("1 阻塞");
        expect(html).not.toContain("已验证解决");
      }
    },
  );

  it("shows incomplete assessment coverage on the ledger summary", () => {
    const sha = "a".repeat(40);
    const run = cliRunDetailResponseSchema.parse({
      runId: "review-coverage",
      kind: "review",
      status: "completed",
      title: "Review",
      startedAt: null,
      endedAt: null,
      hasReport: true,
      reportUrl: "/reports/review-coverage",
      progress: null,
      markdown: "",
      truncated: false,
      reviewEvidence: {
        complete: true,
        sha,
        prUrl: null,
        againstRunId: "review-prior",
        blockingIds: ["F-1"],
        unverifiedFixIds: [],
        openIds: ["F-1"],
        evidenceComplete: false,
        uncoveredIds: ["F-1"],
      },
      findings: [
        {
          id: "F-1",
          title: "Content loss",
          text: "Content loss",
          severity: "critical",
          status: "open",
          source: "unique",
          reviewer: null,
          files: [],
        },
      ],
    });
    const html = renderToStaticMarkup(createElement(FindingLedger, { run }));
    expect(html).toContain("评估覆盖不完整");
    expect(html).toContain("F-1");
  });
});
