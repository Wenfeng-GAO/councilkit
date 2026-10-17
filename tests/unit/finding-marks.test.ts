/**
 * Locked report labels (#377): solid spec, outline consensus, grey single-seat.
 * Colour is not the only difference — the class names carry the shape.
 */
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { findingMarkdown } from "@/lib/finding-marks";
import { parseReviewReport } from "@/lib/review-report";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

function page(markdown: string, findings: unknown[]) {
  const run = cliRunDetailResponseSchema.parse({
    runId: "ck-review-marks",
    kind: "review",
    status: "completed",
    title: "marks",
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: "2026-10-17T00:01:00.000Z",
    hasReport: true,
    reportUrl: "/reports/ck-review-marks",
    progress: null,
    markdown,
    truncated: false,
    findings,
  });
  const parsed = parseReviewReport(markdown);
  return renderToStaticMarkup(
    createElement(OverviewView, {
      run,
      parsed,
      hasRepair: false,
      onOpenRepair: () => undefined,
    }),
  );
}

const header = "# Autonomous Review Report\n\n- Status: completed\n\n---\n\n";

describe("report label shapes", () => {
  it("renders a solid spec tag and keeps changes-requested red", () => {
    const html = page(
      `${header}## 结论\n\nchanges-requested\n\n阻塞 1。\n\n## 共识发现\n\n- [major][act-on] 空串分支被删除\n  违反了规格里的 AC-3：空串输入必须问候\n  违反规格 · AC-3\n  不变量：\`AC-3\`\n`,
      [
        {
          id: "f-ac-3",
          severity: "major",
          status: "open",
          title: "空串分支被删除",
          text: '空串分支被删除\n违反了规格里的 AC-3：空串输入必须问候\n违反规格 · AC-3\n不变量：AC-3\n反例：Greet("") 不再问候',
          source: "consensus",
          reviewer: "kimi",
          files: ["toy.go"],
          contractClass: "in_contract",
          invariantId: "AC-3",
          counterexample: 'Greet("") 不再问候',
        },
      ],
    );
    expect(html).toContain("ck-tag-spec");
    expect(html).toContain("违反规格 · AC-3");
    expect(html).toContain("违反了规格里的 AC-3：空串输入必须问候");
    expect(html).toContain("ck-verdict-changes");
    expect(html).toContain("阻塞依据：违反了规格里的AC-3：空串输入必须问候。");
    expect(html).not.toContain("严重度是重大或致命");
    expect(html).not.toContain("不会自动改这项门禁");
    expect(html).not.toContain("规格合同减法");
    expect(html).not.toContain("合同内 Act On");
    expect(html).not.toContain("不变量 ID");
    expect(html).not.toContain("不变量：");
    expect(html).not.toContain("未绑定规格");
    expect(html).not.toContain("ck-tag-consensus");
    expect(html).not.toContain("ck-tag-pending");
  });

  it("renders an outline consensus tag and the grey basis line", () => {
    const basis = "无规格依据，依据是 2/3 席一致：kimi、cursor";
    const html = page(
      `${header}## 结论\n\nchanges-requested\n\n${basis}\n\n阻塞 1。\n\n## 共识发现\n\n- [major][多席一致 2/3] Add 把加法改成减法\n  ${basis}\n`,
      [
        {
          id: "f-add",
          severity: "major",
          status: "open",
          title: "Add 把加法改成减法",
          text: `Add 把加法改成减法\n${basis}`,
          source: "consensus",
          reviewer: null,
          files: ["toy.go"],
        },
      ],
    );
    expect(html).toContain("ck-tag-consensus");
    expect(html).toContain("多席一致 2/3");
    expect(html).toContain("ck-tag-basis");
    expect(html).toContain(basis);
    expect(html).toContain("ck-verdict-changes");
    expect(html).toContain(
      "阻塞依据：未绑定规格；多数席位各自指出同一高严重度缺陷即阻塞，单席问题进「待确认」。",
    );
    expect(html).not.toContain("规格合同减法");
    expect(html).not.toContain("ck-tag-spec");
    expect(html).not.toContain("ck-tag-pending");
  });

  it("renders a grey 待确认 tag and does not paint a single seat red", () => {
    const html = page(
      `${header}## 结论\n\ncomment\n\n无规格依据。没有多数席位一致的高严重度缺陷。单席意见见「待确认」。\n\n阻塞 0。\n\n## 待确认\n\n- [major][待确认 · kimi] Add 把加法改成减法\n  位置：\`toy.go\`\n`,
      [],
    );
    expect(html).toContain("ck-tag-pending");
    expect(html).toContain("待确认 · kimi");
    expect(html).toContain("没有需要处理的问题，另有 1 条待确认（只有一席提出）。");
    expect(html).not.toContain("0 个问题");
    expect(html).not.toContain("这份审查还没有问题记录。");
    expect(html).toContain("账本无阻塞");
    expect(html).not.toContain("账本未生成");
    expect(html).not.toContain("尚无法判断阻塞");
    expect(html).not.toMatch(/Add 把加法改成减法\s*位置/);
    expect(html).toContain("<p>位置：<code>toy.go</code></p>");
    expect(html).not.toContain("ck-tag-spec");
    expect(html).not.toContain("ck-tag-consensus");
    expect(html).not.toContain("ck-verdict-changes");
  });

  it("lists absent seats in amber with the circle-alert icon", () => {
    const html = page(
      `${header}## 结论\n\ncomment\n\n缺席：review-cursor（cursor-agent）：运行失败，退出码 1。\n这份报告只汇总了其余 2 席的结果，缺席的这几席负责查的问题可能没被发现。\n\n阻塞 0。\n`,
      [],
    );
    const decision = html.slice(html.indexOf("审查结论"), html.indexOf("原始汇总报告"));
    expect(decision).toContain("缺席：review-cursor（cursor-agent）：运行失败，退出码 1。");
    expect(decision).toContain(
      "这份报告只汇总了其余 2 席的结果，缺席的这几席负责查的问题可能没被发现。",
    );
    expect(decision).toContain('data-absence-icon="circle-alert"');
    expect(decision).toContain("ck-wb-absence");
    expect(decision).not.toContain("review-security");
    expect(decision).not.toContain("cld");
    expect(decision).toContain("账本无阻塞");
  });

  it("renders councilkit init as inline code and keeps the absence note secondary", () => {
    const html = page(
      `${header}## 结论\n\ncomment\n\n缺席：review-correctness（grok）：原因未记录，重新运行 \`councilkit init\` 可以看到原因。\n这份报告只汇总了其余 4 席的结果，缺席的这几席负责查的问题可能没被发现。\n\n阻塞 0。\n`,
      [],
    );
    const decision = html.slice(html.indexOf("审查结论"), html.indexOf("原始汇总报告"));
    expect(decision).toContain('<code class="ck-inline-code">councilkit init</code>');
    expect(decision).not.toContain("`");
    expect(decision).toContain('class="ck-wb-absence-note"');
    expect(decision).toContain(
      "这份报告只汇总了其余 4 席的结果，缺席的这几席负责查的问题可能没被发现。",
    );
  });
});

describe("findingMarkdown", () => {
  it("separates only the title and location line", () => {
    const markdown = findingMarkdown("空指针\n位置：`src/a.ts`\n触发与后果：调用方崩溃。");
    expect(markdown.startsWith("空指针\n\n位置：`src/a.ts`\n")).toBe(true);
    expect(markdown).toContain("触发与后果：调用方崩溃。");
    expect(markdown).not.toContain("触发与后果：调用方崩溃。\n\n");
  });

  it("keeps a table, a nested list, and indented code", () => {
    const markdown = findingMarkdown(
      [
        "空指针",
        "位置：`src/a.ts`",
        "| 列 | 值 |",
        "| --- | --- |",
        "| a | 1 |",
        "- 外层",
        "  - 内层",
        "    const x = 1;",
        "不变量：INV-1",
        "规格合同减法：不要这条",
      ].join("\n"),
    );
    expect(markdown).toContain("| 列 | 值 |\n| --- | --- |\n| a | 1 |");
    expect(markdown).toContain("- 外层\n  - 内层");
    expect(markdown).toContain("    const x = 1;");
    expect(markdown).not.toContain("不变量");
    expect(markdown).not.toContain("规格合同减法");
    expect(markdown).not.toMatch(/\| 列 \| 值 \|\n\n\| --- \|/);
  });
});
