import { RepairRunPanel, readRepairLaunchSummary } from "@/components/report/RepairRunPanel";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

const review = {
  runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
  kind: "review" as const,
  status: "completed" as const,
  progress: null,
  businessResult: null,
  reasonCode: null,
  sourceRunId: null,
};

function render(node: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, node));
}

describe("RepairRunPanel", () => {
  it("shows the primary CTA when a profile is ready", () => {
    const html = render(
      createElement(RepairRunPanel, {
        run: review,
        profiles: [
          {
            name: "default",
            prUrl: "https://github.com/a/b/pull/1",
            sourceBranch: "feat",
            base: "main",
          },
        ],
      }),
    );
    expect(html).toContain("Squad 自动修复");
    expect(html).toContain("button");
    expect(html).not.toContain("还没有保存的修复授权");
  });

  it("shows the launch summary form when no profile exists", () => {
    const html = render(createElement(RepairRunPanel, { run: review, profiles: [] }));
    expect(html).toContain("还没有保存的修复授权");
    expect(html).toContain("保存授权并启动");
    expect(html).toContain("profile 名");
    expect(html).toContain("源分支");
    expect(html).toContain("目标分支");
    expect(html).toContain("不是 PR 地址");
  });

  it("prefills source and base from the current review when Host can inspect them", () => {
    const html = render(
      createElement(RepairRunPanel, {
        run: review,
        profiles: [],
        sourceBranchDefault: "hengzhuo/fix/session-replay-performance",
        baseDefault: "sprint_independent-pre_S090011901586_20260911",
        hintSource: "review",
      }),
    );
    expect(html).toContain("已从本次审查冻结上下文识别");
    expect(html).toContain("hengzhuo/fix/session-replay-performance");
    expect(html).toContain("sprint_independent-pre_S090011901586_20260911");
    expect(html).toContain('type="hidden"');
  });

  it("does not default the target branch to main", () => {
    const html = render(createElement(RepairRunPanel, { run: review, profiles: [] }));
    expect(html).not.toContain('value="main"');
    expect(html).toContain("本 PR 的 base 分支");
  });

  it("rejects an empty source branch before save", () => {
    const data = new FormData();
    data.set("name", "default");
    data.set("sourceBranch", "   ");
    data.set("base", "main");
    expect(readRepairLaunchSummary(data)).toEqual({
      ok: false,
      error: "请填写源分支（本 PR 的 head 分支）",
    });
  });

  it("disables the CTA when the squad bridge is missing", () => {
    const html = render(
      createElement(RepairRunPanel, {
        run: review,
        profiles: [{ name: "default", prUrl: "p", sourceBranch: "f", base: "m" }],
        bridgeAvailable: false,
      }),
    );
    expect(html).toContain("Squad 桥不可用");
    expect(html).not.toContain(">Squad 自动修复</button>");
  });

  it("links to an active parent run", () => {
    const html = render(
      createElement(RepairRunPanel, {
        run: review,
        activeRepair: {
          runId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
          status: "running",
          progress: null,
          businessResult: null,
          reasonCode: null,
        },
      }),
    );
    expect(html).toContain("查看自动修复");
    expect(html).toContain("/reports/ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3");
  });

  it("shows a page error", () => {
    const html = render(
      createElement(RepairRunPanel, {
        run: review,
        profiles: [{ name: "default", prUrl: "p", sourceBranch: "f", base: "m" }],
        error: "mutation failed",
      }),
    );
    expect(html).toContain("mutation failed");
  });

  it("hides retry when the parent budget is exhausted", () => {
    const html = render(
      createElement(RepairRunPanel, {
        run: {
          runId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
          kind: "repair",
          status: "completed",
          progress: { phase: "repair-finalizing", attempts: [], updatedAt: "t" },
          businessResult: "needs_attention",
          reasonCode: "findings_open",
          sourceRunId: review.runId,
        },
        outerUsed: 10,
        outerMax: 10,
      }),
    );
    expect(html).toContain("第 10 / 10 次外循环");
    expect(html).toContain("不能再修一次");
    expect(html).not.toContain("恢复");
  });
});
