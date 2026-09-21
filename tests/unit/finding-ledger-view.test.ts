import { FindingLedger } from "@/components/report/FindingLedger";
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { parseReviewReport } from "@/lib/review-report";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const SHA = "a".repeat(40);

function baseRun(overrides: Record<string, unknown> = {}) {
  return cliRunDetailResponseSchema.parse({
    runId: "ck-review-current",
    kind: "review",
    status: "completed",
    title: "Review",
    startedAt: null,
    endedAt: null,
    hasReport: true,
    reportUrl: "/reports/ck-review-current",
    progress: null,
    markdown: "",
    truncated: false,
    findings: [],
    ...overrides,
  });
}

describe("FindingLedger candidate evidence", () => {
  it.each(["a".repeat(40), "b".repeat(40), null])(
    "renders proof against the current candidate %s",
    (sha) => {
      const run = baseRun({
        reviewEvidence: sha
          ? {
              complete: true,
              sha,
              prUrl: null,
              againstRunId: "ck-review-prior",
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
              runId: "ck-review-prior",
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
        expect(html).toContain("问题清单");
      } else {
        expect(html).toContain("待验证当前提交");
        expect(html).toContain("1 阻塞");
        expect(html).not.toContain("已验证解决");
      }
    },
  );

  it("shows incomplete historical coverage on a linked re-review", () => {
    const run = baseRun({
      reviewEvidence: {
        complete: true,
        sha: SHA,
        prUrl: "https://github.com/example/repo/pull/1",
        againstRunId: "ck-review-prior",
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
    expect(html).toContain("历史问题评估覆盖不完整");
    expect(html).toContain("F-1");
    expect(html).toContain("against=ck-review-current");
    expect(html).toContain("/reports/ck-review-prior");
    expect(html).not.toContain("评估覆盖完整");
  });

  it("does not present first-review empty coverage as 评估覆盖完整", () => {
    const run = baseRun({
      reviewEvidence: {
        complete: true,
        sha: SHA,
        prUrl: null,
        againstRunId: null,
        blockingIds: ["F-1"],
        unverifiedFixIds: [],
        openIds: ["F-1"],
        evidenceComplete: true,
      },
      findings: [
        {
          id: "F-1",
          title: "Content loss",
          text: "Content loss",
          severity: "major",
          status: "open",
          source: "unique",
          reviewer: "review-correctness",
          files: [],
        },
      ],
    });
    const html = renderToStaticMarkup(createElement(FindingLedger, { run }));
    expect(html).toContain("本轮新审查，未关联历史修复记录");
    expect(html).toContain("待处理");
    expect(html).not.toContain("评估覆盖完整");
    expect(html).not.toContain("本轮解决");
  });

  it("shows the 357 duplicate as one row with both original ids in details", () => {
    const run = baseRun({
      findings: [
        {
          id: "recovery.go--357-uuid-close",
          title:
            "`recovery.go:357` — Resume 成功、提交 idle 遇到临时存储错误时 `closeOpenedOn` + `markRecoveryFailed`（UUID 仍在）。改用 `forgetOpenedOn`。",
          text: "`recovery.go:357` — Resume 成功、提交 idle 遇到临时存储错误时 `closeOpenedOn`。",
          severity: "major",
          status: "open",
          source: "unique",
          reviewer: "review-correctness",
          files: ["recovery.go"],
        },
        {
          id: "pkg.runtime.recovery.go--357-uuid",
          title:
            "pkg/runtime/recovery.go:357 — 原 UUID Resume 成功、提交 idle 遇到临时存储错误时 Close，改用 `forgetOpenedOn`。",
          text: "pkg/runtime/recovery.go:357 — 原 UUID Resume 成功后 Close。",
          severity: "major",
          status: "open",
          source: "unique",
          reviewer: "review-correctness",
          files: ["pkg/runtime/recovery.go"],
        },
        {
          id: "recovery.go--266-271-ctx",
          title: "`recovery.go:266-271` — Resume 失败只看 `ctx.Err()`，不看 `flightCurrent`。",
          text: "`recovery.go:266-271` — Resume 失败只看 `ctx.Err()`。",
          severity: "major",
          status: "open",
          source: "unique",
          reviewer: "review-adversarial",
          files: ["recovery.go"],
        },
      ],
    });
    const html = renderToStaticMarkup(createElement(FindingLedger, { run }));
    expect(html).toContain("展示 2 个问题");
    expect(html).toContain("账本 3 条");
    expect(html).toContain("2 阻塞");
    expect(html).toContain("原始 ID");
    expect(html).toContain("recovery.go--357-uuid-close");
    expect(html).toContain("pkg.runtime.recovery.go--357-uuid");
    expect(html.match(/class="ck-ledger-row"/g)?.length).toBe(2);
  });
});

describe("OverviewView reading order", () => {
  it("leads with 审查已完成, then 概览, then 问题清单, then the original report", () => {
    const markdown = `# Autonomous Review Report

- Run: ck-review-current
- Status: complete

---

## 概览

阻塞集中在恢复补偿。

## 共识发现

- [major] 共识项不应作为主清单的第二份待办。

## 独有发现

- [major] 独有项同样进入问题清单。

## 分歧

- **结论票**：意见不一致。

## 结论

changes-requested
`;
    const run = baseRun({
      markdown,
      findings: [
        {
          id: "F-unique",
          title: "独有项同样进入问题清单。",
          text: "独有项同样进入问题清单。",
          severity: "major",
          status: "open",
          source: "unique",
          reviewer: "review-correctness",
          files: [],
        },
      ],
    });
    const html = renderToStaticMarkup(
      createElement(OverviewView, {
        run,
        parsed: parseReviewReport(markdown),
        hasRepair: false,
        onOpenRepair: () => undefined,
      }),
    );
    const completed = html.indexOf("审查已完成");
    const brief = html.indexOf("阻塞集中在恢复补偿");
    const list = html.indexOf("问题清单");
    const original = html.indexOf("原始汇总报告");
    const consensus = html.indexOf("共识发现");
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(brief).toBeGreaterThan(completed);
    expect(list).toBeGreaterThan(brief);
    expect(original).toBeGreaterThan(list);
    expect(consensus).toBeGreaterThan(original);
    expect(html).toContain("分歧");
    expect(html).toContain("查看审查者之间的不同意见");
    expect(html).not.toContain("无法可靠归入");
    expect(html).toContain("Changes requested");
    expect(html).not.toContain("Finding 账本");
  });

  it("still shows first-review copy when the ledger is empty", () => {
    const run = baseRun({
      reviewEvidence: {
        complete: true,
        sha: SHA,
        prUrl: null,
        againstRunId: null,
        blockingIds: [],
        unverifiedFixIds: [],
        openIds: [],
        evidenceComplete: true,
      },
    });
    const html = renderToStaticMarkup(createElement(FindingLedger, { run }));
    expect(html).toContain("问题清单");
    expect(html).toContain("本轮新审查，未关联历史修复记录");
    expect(html).toContain("这份审查还没有问题记录");
    expect(html).not.toContain("评估覆盖完整");
  });

  it("does not invent progress when the against ledger is present but unusable", () => {
    const run = baseRun({
      reviewEvidence: {
        complete: true,
        sha: SHA,
        prUrl: "https://github.com/example/repo/pull/1",
        againstRunId: "ck-review-prior",
        blockingIds: [],
        unverifiedFixIds: [],
        openIds: [],
        evidenceComplete: false,
      },
      findings: [
        {
          id: "F-1",
          title: "Content loss",
          text: "Content loss",
          severity: "major",
          status: "open",
          source: "unique",
          reviewer: null,
          files: [],
        },
      ],
    });
    const html = renderToStaticMarkup(
      createElement(FindingLedger, { run, againstState: { status: "unavailable" } }),
    );
    expect(html).toContain("无法比较");
    expect(html).not.toContain("对照关联账本：新增");
  });
});
