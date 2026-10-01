import { describe, expect, it } from "vitest";
import { extractFindingsFromReport } from "../src/auto/ledger";
import { buildAggregatePrompt, buildAttemptPrompt } from "../src/auto/templates/review";

const TITLE = "状态回滚失败后会话永久停留在创建中";
const DETAILS = [
  "位置：`pkg/runtime/manager/session_manager.go:204-205`",
  "触发与后果：UUID 提交与状态写入连续失败后，重试无法恢复会话状态。",
  "证据：`scheduleRevertRetry` 再次遇到状态不匹配；未运行反例测试。",
  "建议：保留可重试状态，直到 UUID 与就绪状态一致。",
];

function extract(item: string) {
  return extractFindingsFromReport({
    markdown: [
      "# Autonomous Review Report",
      "",
      "---",
      "## 共识发现",
      "",
      item,
      "",
      "## 结论",
      "changes-requested",
    ].join("\n"),
    runId: "ck-review-11111111-1111-4111-8111-111111111111",
    extractedAt: "2026-09-28T00:00:00.000Z",
  }).findings;
}

describe("review finding title format", () => {
  it("extracts the short headline while retaining the complete assertion and source location", () => {
    const rows = extract(`- [major] ${TITLE}\n${DETAILS.map((line) => `  ${line}`).join("\n")}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe(TITLE);
    expect(rows[0]?.text.replace(/\n\s+/g, "\n")).toBe([TITLE, ...DETAILS].join("\n"));
    expect(rows[0]?.files).toEqual(["pkg/runtime/manager/session_manager.go"]);
    expect(rows[0]?.severity).toBe("major");
  });

  it.each(["F-1", "pkg.runtime.manager.session_manager.go--uuid-write-failure"])(
    "preserves the explicit prior finding ID %s from the indented body",
    (id) => {
      const rows = extract(
        `- [major] ${TITLE}\n${[...DETAILS, `原 Finding ID：\`${id}\``].map((line) => `  ${line}`).join("\n")}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(id);
      expect(rows[0]?.title).toBe(TITLE);
      expect(rows[0]?.text).toContain(`原 Finding ID：\`${id}\``);
      expect(rows[0]?.files).toEqual(["pkg/runtime/manager/session_manager.go"]);
    },
  );

  it("keeps the labeled finding id when an earlier evidence backtick contains --", () => {
    const rows = extract(
      `- [major] ${TITLE}\n${[
        ...DETAILS,
        "对照：`--resume` 会按数组下标复用，另一项是 `pkg.runtime.manager.session_manager.go--other`。",
        "原 Finding ID：`F-1`",
      ]
        .map((line) => `  ${line}`)
        .join("\n")}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("F-1");
    expect(rows[0]?.title).toBe(TITLE);
  });

  it("does not use a body backtick that contains -- as the finding id", () => {
    const rows = extract(
      `- [major] ${TITLE}\n${[...DETAILS, "对照：`--resume` 会按数组下标复用。"]
        .map((line) => `  ${line}`)
        .join("\n")}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(
      "pkg.runtime.manager.session_manager.go--状态回滚失败后会话永久停留在创建中",
    );
    expect(rows[0]?.title).toBe(TITLE);
  });

  it("keeps legacy one-line finding titles, assertions and IDs unchanged", () => {
    const text = "src/session.ts:20 — Session lock leaks after timeout.";
    const rows = extract(`- [major] ${text}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "src.session.ts--src-session.ts-20-session-lock-leaks",
      title: text,
      text,
      files: ["src/session.ts"],
    });
  });

  it.each(["attempt", "aggregator"] as const)(
    "requires a semantic short title and indented evidence from the %s",
    (stage) => {
      const task = { task: "审查状态回滚", against: "ck-review-prior", againstLedger: "F-1" };
      const prompt =
        stage === "attempt"
          ? buildAttemptPrompt({ agentName: "review-correctness", personaPrompt: "", task })
          : buildAggregatePrompt({ aggregatorName: "review-reporter", task, attempts: [] });
      expect(prompt).toContain("16–32 字");
      expect(prompt).toContain("关键条件 + 实际后果");
      expect(prompt).toContain("后续正文缩进两个空格");
      expect(prompt).toContain("原 Finding ID：`<原 ID>`");
      expect(prompt).toContain("不要截取正文开头");
      expect(prompt).toContain("approve | changes-requested | comment");
      if (stage === "attempt") expect(prompt).toContain("```councilkit-findings");
    },
  );
});
