import {
  OTHER_SQUADS_KEY,
  caseNeedsAttention,
  diffFindings,
  flattenFindings,
  groupCliRuns,
  readableCaseTitle,
  runHistoryLabel,
  squadPrNumber,
} from "@/lib/report-groups";
import { parseReviewReport } from "@/lib/review-report";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

function run(
  partial: Partial<CliRunSummaryDto> & Pick<CliRunSummaryDto, "runId" | "title">,
): CliRunSummaryDto {
  return {
    kind: "review",
    status: "completed",
    startedAt: null,
    endedAt: null,
    hasReport: true,
    hasPlan: false,
    hasFindings: false,
    hasPlanLock: false,
    reportUrl: `http://127.0.0.1:43127/reports/${partial.runId}`,
    progress: null,
    pipeline: null,
    handoff: null,
    ...partial,
  };
}

describe("groupCliRuns", () => {
  it("groups two reviews of the same PR", () => {
    const groups = groupCliRuns([
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        title: "https://code.alipay.com/org/app/pull_requests/1",
      }),
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        title: "https://code.alipay.com/org/app/pull_requests/1",
      }),
      run({ runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3", title: "other" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.runs).toHaveLength(2);
    expect(groups[1]?.runs).toHaveLength(1);
  });

  it("attaches a squad to the unique matching PR number", () => {
    const groups = groupCliRuns([
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        title: "https://code.alipay.com/paas-core/agentrun/pull_requests/126",
      }),
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        kind: "squad",
        title: "20260908-pr126-ckfix-r2n6",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(readableCaseTitle(groups[0]?.label ?? "")).toBe("paas-core/agentrun #126");
    expect(groups[0]?.runs.map((item) => item.kind).sort()).toEqual(["review", "squad"]);
  });

  it("keeps squads together by prN when the number is ambiguous across repos", () => {
    const groups = groupCliRuns([
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        title: "https://github.com/acme/one/pull/7",
      }),
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        title: "https://github.com/acme/two/pull/7",
      }),
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
        kind: "squad",
        title: "20260907-pr7-rereview-n8k3",
      }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.find((group) => group.label === "PR #7")?.runs).toHaveLength(1);
  });

  it("buckets squads without a PR hint", () => {
    const groups = groupCliRuns([
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        kind: "squad",
        title: "20260908-squad-opt-6n2q",
      }),
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        kind: "squad",
        title: "20260908-councilkit-opt-6n2q",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe(OTHER_SQUADS_KEY);
    expect(groups[0]?.label).toBe("其他工程班");
    expect(groups[0]?.runs).toHaveLength(2);
  });

  it("keeps an in-progress unmatched squad out of the archive bucket", () => {
    const groups = groupCliRuns([
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        kind: "squad",
        title: "20260908-squad-opt-6n2q",
        status: "running",
      }),
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        kind: "squad",
        title: "20260908-councilkit-opt-6n2q",
      }),
    ]);
    expect(groups.map((group) => group.label).sort()).toEqual([
      "20260908-squad-opt-6n2q",
      "其他工程班",
    ]);
  });
});

describe("squadPrNumber / readableCaseTitle / history", () => {
  it("reads prN from squad slugs and ignores product-like words", () => {
    expect(squadPrNumber("20260908-pr126-ckfix-r2n6")).toBe("126");
    expect(squadPrNumber("20260907-pr7-node-floor")).toBe("7");
    expect(squadPrNumber("product-jury")).toBeNull();
  });

  it("labels review history without repeating the PR title", () => {
    const review = run({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      title: "https://github.com/acme/repo/pull/1",
      reviewEvidence: {
        complete: true,
        sha: "a".repeat(40),
        prUrl: "https://github.com/acme/repo/pull/1",
        againstRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee0",
        blockingIds: [],
        unverifiedFixIds: [],
        openIds: [],
      },
    });
    expect(runHistoryLabel(review, "https://github.com/acme/repo/pull/1")).toBe("对照复审");
    expect(readableCaseTitle("https://github.com/acme/repo/pull/1")).toBe("acme/repo #1");
  });

  it("treats a failed review as needing attention", () => {
    expect(
      caseNeedsAttention([
        run({
          runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
          title: "other",
          status: "failed",
        }),
      ]),
    ).toBe(true);
  });
});

describe("diffFindings", () => {
  it("splits findings that only appear in one report", () => {
    const markdownA = `# Autonomous Review Report

- Task: review PR https://example.com/p/1

---

## 共识发现

- [major][必现] WatchEvents 漏事件。
- [minor] 文档示例带 id。

## 结论

changes-requested
`;
    const markdownB = `# Autonomous Review Report

- Task: review PR https://example.com/p/1

---

## 共识发现

- [major][必现] WatchEvents 漏事件。
- [major] 超大 chunk 绕过上限。

## 结论

changes-requested
`;
    const parsedA = parseReviewReport(markdownA);
    const parsedB = parseReviewReport(markdownB);
    expect(parsedA).not.toBeNull();
    expect(parsedB).not.toBeNull();
    if (parsedA === null || parsedB === null) return;
    const a = flattenFindings(parsedA);
    const b = flattenFindings(parsedB);
    const diff = diffFindings(a, b);
    expect(diff.both).toHaveLength(1);
    expect(diff.onlyA.map((item) => item.text)).toEqual(["文档示例带 id。"]);
    expect(diff.onlyB.map((item) => item.text)[0]).toContain("超大 chunk");
  });
});
