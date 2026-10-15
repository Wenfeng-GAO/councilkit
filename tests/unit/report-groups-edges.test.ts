import {
  buildPrComment,
  caseNeedsAttention,
  isWorkspaceRun,
  readableCaseTitle,
  runHistoryLabel,
  seatProgress,
} from "@/lib/report-groups";
import type { ParsedReviewReport } from "@/lib/review-report";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

function run(
  partial: Partial<CliRunSummaryDto> &
    Pick<CliRunSummaryDto, "runId" | "title" | "kind" | "status">,
): CliRunSummaryDto {
  return {
    startedAt: null,
    endedAt: null,
    hasReport: false,
    hasPlan: false,
    hasFindings: false,
    hasPlanLock: false,
    reportUrl: "http://127.0.0.1/reports/x",
    progress: null,
    pipeline: null,
    handoff: null,
    ...partial,
  };
}

const EVIDENCE = {
  complete: true,
  sha: "a".repeat(40),
  prUrl: "https://github.com/acme/repo/pull/1",
  againstRunId: null,
  blockingIds: [] as string[],
  unverifiedFixIds: [] as string[],
  openIds: [] as string[],
};

describe("report group edges", () => {
  it("treats review, squad, and repair as workspace runs", () => {
    expect(isWorkspaceRun({ kind: "review" })).toBe(true);
    expect(isWorkspaceRun({ kind: "squad" })).toBe(true);
    expect(isWorkspaceRun({ kind: "repair" })).toBe(true);
    expect(isWorkspaceRun({ kind: "ideate" })).toBe(false);
    // B4 DM-03: discussion runs (incl. slow-gen 示例) are listed in /reports.
    expect(isWorkspaceRun({ kind: "discuss" })).toBe(true);
    expect(isWorkspaceRun({ kind: "unknown" })).toBe(false);
  });

  it("reads a non-GitHub pull path and leaves ordinary labels unchanged", () => {
    expect(readableCaseTitle("https://gitlab.example.com/group/repo/pull/12")).toBe(
      "group/repo  #12",
    );
    expect(readableCaseTitle("https://gitlab.example.com/group/repo/pull_requests/8")).toBe(
      "group/repo  #8",
    );
    expect(readableCaseTitle("https://example.com/readme")).toBe("https://example.com/readme");
    expect(readableCaseTitle("plain title")).toBe("plain title");
  });

  it("labels a plain review as 审查 and other kinds by title", () => {
    const review = run({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      kind: "review",
      status: "completed",
      title: "https://github.com/acme/repo/pull/1",
    });
    const ideate = run({
      runId: "ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
      kind: "ideate",
      status: "completed",
      title: "创意讨论",
    });
    expect(runHistoryLabel(review, "https://github.com/acme/repo/pull/1")).toBe("审查");
    expect(runHistoryLabel(ideate, "case")).toBe("创意讨论");
  });

  it("counts finished seats only while the run is still live", () => {
    const attempts = [
      { status: "success" },
      { status: "failure" },
      { status: "running" },
      { status: "cancelled" },
    ];
    expect(seatProgress(run({ runId: "r", title: "t", kind: "review", status: "completed" }))).toBe(
      null,
    );
    expect(
      seatProgress(
        run({
          runId: "r",
          title: "t",
          kind: "review",
          status: "completed",
          progress: { phase: "done", updatedAt: null, attempts: attempts as never },
        }),
      ),
    ).toBeNull();
    expect(
      seatProgress(
        run({
          runId: "r",
          title: "t",
          kind: "review",
          status: "running",
          progress: { phase: "attempts", updatedAt: null, attempts: attempts as never },
        }),
      ),
    ).toBe("3/4");
    expect(
      seatProgress(
        run({
          runId: "r",
          title: "t",
          kind: "squad",
          status: "awaiting_orchestrator",
          progress: {
            phase: "reviewing",
            updatedAt: null,
            attempts: [{ status: "pending" }] as never,
          },
        }),
      ),
    ).toBe("0/1");
  });

  it("flags a quiet completed review when the ledger still blocks", () => {
    expect(
      caseNeedsAttention([
        run({
          runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
          kind: "review",
          status: "completed",
          title: "https://github.com/acme/repo/pull/1",
          reviewEvidence: { ...EVIDENCE, blockingIds: ["f1"], openIds: ["f1"] },
        }),
      ]),
    ).toBe(true);
    expect(
      caseNeedsAttention([
        run({
          runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
          kind: "review",
          status: "completed",
          title: "https://github.com/acme/repo/pull/1",
          reviewEvidence: EVIDENCE,
        }),
      ]),
    ).toBe(false);
  });

  it("builds a PR comment from consensus findings and an empty fallback", () => {
    const report: ParsedReviewReport = {
      title: "Autonomous Review Report",
      meta: {},
      attempts: [],
      preface: "",
      verdict: "changes-requested",
      sections: [
        {
          id: "consensus",
          title: "共识发现",
          body: "",
          groups: null,
          findings: [
            { severity: "major", qualifier: "必现", text: "第一行\n第二行" },
            { severity: null, qualifier: null, text: "无级别" },
          ],
        },
        {
          id: "unique",
          title: "独有发现",
          body: "",
          groups: null,
          findings: [{ severity: "nit", qualifier: null, text: "忽略" }],
        },
      ],
    };
    expect(buildPrComment("paas-core/agentrun #126", report)).toBe(
      [
        "CouncilKit Jury：changes-requested",
        "",
        "paas-core/agentrun #126",
        "",
        "## 共识发现",
        "- [major][必现] 第一行",
        "-  无级别",
        "",
        "请按 critical/major 优先修复，并在评论里说明验证命令。",
        "",
      ].join("\n"),
    );
    expect(
      buildPrComment("无共识", {
        ...report,
        verdict: null,
        sections: [{ id: "overview", title: "概览", body: "", findings: null, groups: null }],
      }),
    ).toBe(
      [
        "CouncilKit Jury：comment",
        "",
        "无共识",
        "",
        "## 共识发现",
        "（报告里没有解析出共识发现条目。）",
        "",
        "请按 critical/major 优先修复，并在评论里说明验证命令。",
        "",
      ].join("\n"),
    );
  });
});
