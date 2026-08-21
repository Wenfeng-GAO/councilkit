import { diffFindings, flattenFindings, groupCliRuns } from "@/lib/report-groups";
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
