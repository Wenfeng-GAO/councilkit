import {
  OTHER_SQUADS_KEY,
  caseMatchesStatusFilter,
  caseNeedsAttention,
  caseStatusAxis,
  caseViewOf,
  diffFindings,
  flattenFindings,
  groupCliRuns,
  readableCaseTitle,
  runHistoryLabel,
  runInKindScope,
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

describe("caseStatusAxis / caseViewOf (representative semantics)", () => {
  const PR = "https://github.com/acme/repo/pull/1";
  const evidence = (blockingIds: string[] = []) => ({
    complete: true,
    sha: "a".repeat(40),
    prUrl: PR,
    againstRunId: null,
    blockingIds,
    unverifiedFixIds: [],
    openIds: blockingIds,
  });

  it("judges by the latest run: an old failure does not pollute a new completion", () => {
    const status = caseStatusAxis([
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        title: PR,
        status: "failed",
        startedAt: "2026-09-20T01:00:00.000Z",
        reviewEvidence: evidence(),
      }),
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        title: PR,
        startedAt: "2026-09-21T02:00:00.000Z",
        reviewEvidence: evidence(),
      }),
    ]);
    expect(status).toEqual({ active: false, done: true, attention: false });
  });

  it("keeps an interrupted squad in attention and never done", () => {
    const status = caseStatusAxis([
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        kind: "squad",
        title: "20260921-break",
        status: "interrupted",
        startedAt: "2026-09-21T02:00:00.000Z",
      }),
    ]);
    expect(status).toEqual({ active: false, done: false, attention: true });
  });

  it("treats a finished-with-blocking review as done AND attention (dual axis)", () => {
    const status = caseStatusAxis([
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        title: PR,
        startedAt: "2026-09-21T02:00:00.000Z",
        reviewEvidence: evidence(["f1"]),
      }),
    ]);
    expect(status).toEqual({ active: false, done: true, attention: true });
  });

  it("never calls a needs_attention repair done, even though its run completed", () => {
    const repair = (businessResult: "needs_attention" | null) =>
      run({
        runId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
        kind: "repair",
        title: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
        startedAt: "2026-09-21T02:00:00.000Z",
        businessResult,
      });
    expect(caseStatusAxis([repair("needs_attention")])).toEqual({
      active: false,
      done: false,
      attention: true,
    });
    expect(caseStatusAxis([repair(null)])).toEqual({
      active: false,
      done: true,
      attention: false,
    });
  });

  it("scopes mixed cases by kind: repair stays in 工程班, review in 审查", () => {
    expect(runInKindScope({ kind: "repair" }, "squad")).toBe(true);
    expect(runInKindScope({ kind: "repair" }, "review")).toBe(false);
    expect(runInKindScope({ kind: "squad" }, "review")).toBe(false);
    expect(runInKindScope({ kind: "review" }, "review")).toBe(true);
    const groups = groupCliRuns([
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        title: PR,
        startedAt: "2026-09-20T01:00:00.000Z",
        reviewEvidence: evidence(),
      }),
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        kind: "squad",
        title: "20260921-pr1-fix",
        status: "failed",
        startedAt: "2026-09-21T02:00:00.000Z",
      }),
    ]);
    const group = groups[0];
    expect(group?.runs).toHaveLength(2);
    const reviewView = caseViewOf(group, "review");
    expect(reviewView?.kindLabels).toEqual(["审查"]);
    expect(reviewView?.scopedRuns.map((item) => item.kind)).toEqual(["review"]);
    expect(reviewView?.status.done).toBe(true);
    const squadView = caseViewOf(group, "squad");
    expect(squadView?.kindLabels).toEqual(["工程班"]);
    expect(squadView?.representative.kind).toBe("squad");
    expect(squadView?.status.attention).toBe(true);
  });

  it("lets a newer completed squad close the case over an older failed review", () => {
    // 旧 review 失败后，新的 squad run 完成收尾：全部类型范围里代表是
    // completed squad，历史审查失败不得把案件拖回“需要处理”。
    const groups = groupCliRuns([
      run({
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        title: PR,
        status: "failed",
        startedAt: "2026-09-20T01:00:00.000Z",
        reviewEvidence: evidence(),
      }),
      run({
        runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4",
        kind: "squad",
        title: "20260921-pr1-fix",
        startedAt: "2026-09-21T02:00:00.000Z",
      }),
    ]);
    const group = groups[0];
    if (!group) throw new Error("expected one case group");
    const allView = caseViewOf(group, "all");
    expect(allView?.representative.kind).toBe("squad");
    expect(allView?.status).toEqual({ active: false, done: true, attention: false });
    // 审查范围里最新记录仍是那次失败 review，审查轴照常需要恢复。
    const reviewView = caseViewOf(group, "review");
    expect(reviewView?.representative.status).toBe("failed");
    expect(reviewView?.status.attention).toBe(true);
  });

  it("maps status filters onto the case axis", () => {
    expect(caseMatchesStatusFilter({ active: true, done: false, attention: true }, "active")).toBe(
      true,
    );
    expect(caseMatchesStatusFilter({ active: true, done: false, attention: true }, "done")).toBe(
      false,
    );
    expect(
      caseMatchesStatusFilter({ active: false, done: true, attention: false }, "attention"),
    ).toBe(false);
    expect(caseMatchesStatusFilter(null, "all")).toBe(false);
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
