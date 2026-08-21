import { parseFindingGroups, parseFindings, parseReviewReport } from "@/lib/review-report";
import { describe, expect, it } from "vitest";

const SAMPLE = `# Autonomous Review Report

- Run: ck-review-34e2b26f-46c4-42c4-9336-b6e1ff6e7e8c
- Task: review PR https://code.alipay.com/paas-core/agentrun/pull_requests/126
- Aggregator: review-correctness (codex-app-server/gpt-5.6-sol)

| Attempt | Driver/Model | 结果 | 耗时 | 工具调用 |
| --- | --- | --- | --- | --- |
| review-security | claude-stream-json/antchat/GLM-5.2[1m] | ok | 6m08s | 19 |
| review-correctness | codex-app-server/gpt-5.6-sol | ok | 39m35s | 97 |
- Status: complete
- Started: 2026-08-18T10:03:21.946Z
- Ended: 2026-08-18T10:45:06.403Z

---

## 概览

四位成功审查者均给出 \`changes-requested\`。

## 共识发现

- [major][必现] 非文本内容被错误转换为 live-only preview。
- [minor] Java SDK 将 seq 改为可空 Long。

## 结论

changes-requested
`;

describe("parseReviewReport", () => {
  it("reads header, attempts, verdict and finding cards", () => {
    const parsed = parseReviewReport(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe("Autonomous Review Report");
    expect(parsed?.meta.Run).toBe("ck-review-34e2b26f-46c4-42c4-9336-b6e1ff6e7e8c");
    expect(parsed?.attempts).toHaveLength(2);
    expect(parsed?.attempts[0]?.name).toBe("review-security");
    expect(parsed?.verdict).toBe("changes-requested");
    expect(parsed?.sections.map((section) => section.title)).toEqual(["概览", "共识发现", "结论"]);
    expect(parsed?.sections[1]?.findings).toEqual([
      {
        severity: "major",
        qualifier: "必现",
        text: "非文本内容被错误转换为 live-only preview。",
      },
      {
        severity: "minor",
        qualifier: null,
        text: "Java SDK 将 seq 改为可空 Long。",
      },
    ]);
  });

  it("keeps fixture prose as preface when there are no chapters", () => {
    const parsed = parseReviewReport(
      "# Autonomous Review Report\n\nE2E fixture body. `<script>alert(1)</script>` stays text.\n",
    );
    expect(parsed?.preface).toContain("<script>alert(1)</script>");
    expect(parsed?.sections).toEqual([]);
    expect(parsed?.verdict).toBeNull();
  });

  it("returns null for ordinary markdown", () => {
    expect(parseReviewReport("# 决策报告\n\nhello")).toBeNull();
  });
});

describe("parseFindings", () => {
  it("returns null when the section is not a list", () => {
    expect(parseFindings("一段说明，不是列表。")).toBeNull();
  });

  it("reads bold-wrapped severity tags used by later aggregators", () => {
    const findings = parseFindings(
      "- **[major][偶现] `WatchEvents` 在 replay/live 切换窗口永久漏事件。**\n",
    );
    expect(findings).toEqual([
      {
        severity: "major",
        qualifier: "偶现",
        text: "`WatchEvents` 在 replay/live 切换窗口永久漏事件。",
      },
    ]);
  });

  it("reads a slash qualifier inside one tag", () => {
    const findings = parseFindings("- **[major/偶现] chunk 可能晚于对应 completed 发出。**\n");
    expect(findings?.[0]).toEqual({
      severity: "major",
      qualifier: "偶现",
      text: "chunk 可能晚于对应 completed 发出。",
    });
  });

  it("reads a speaker prefix with a mid-line severity tag", () => {
    const findings = parseFindings(
      "- **`review-correctness`：[major][必现] 进程中断会把旧 partial 错误持久化。**\n",
    );
    expect(findings?.[0]).toEqual({
      severity: "major",
      qualifier: "必现",
      text: "`review-correctness` — 进程中断会把旧 partial 错误持久化。",
    });
  });

  it("reads numbered consensus items and space qualifiers", () => {
    const findings = parseFindings(
      [
        "1. **[critical/major] EventLog 短写会撕裂 JSONL**  ",
        "   共识来源：review-adversarial。",
        "2. **[major 家族] Preview seq 契约不自洽**",
      ].join("\n"),
    );
    expect(findings?.[0]).toMatchObject({
      severity: "critical",
      qualifier: "major",
      text: expect.stringContaining("EventLog 短写会撕裂 JSONL"),
    });
    expect(findings?.[1]).toMatchObject({
      severity: "major",
      qualifier: "家族",
      text: expect.stringContaining("Preview seq"),
    });
  });

  it("groups unique findings by reviewer heading", () => {
    const groups = parseFindingGroups(
      [
        "**review-correctness**",
        "",
        "- [major] WaitGroup Add/Wait 竞态",
        "",
        "**review-security**",
        "",
        "- [nit] Java seq 可空",
      ].join("\n"),
    );
    expect(groups?.map((group) => group.title)).toEqual(["review-correctness", "review-security"]);
    expect(groups?.[0]?.findings[0]?.severity).toBe("major");
    expect(groups?.[1]?.findings[0]?.severity).toBe("nit");
  });

  it("splits a glued ## 概览 heading into its own chapter", () => {
    const parsed = parseReviewReport(
      [
        "# Autonomous Review Report",
        "",
        "---",
        "",
        "先核对元数据。## 概览",
        "",
        "这是概览。",
        "",
        "## 结论",
        "",
        "approve",
      ].join("\n"),
    );
    expect(parsed?.sections.map((section) => section.title)).toEqual(["概览", "结论"]);
    expect(parsed?.preface).toContain("先核对元数据。");
  });

  it("does not split #### appendix headings into top-level chapters", () => {
    const parsed = parseReviewReport(
      [
        "# Autonomous Review Report",
        "",
        "---",
        "",
        "## 附录:各审查者交付物",
        "",
        "### review-security",
        "",
        "#### 发现",
        "",
        "- [nit] hello",
        "",
        "## 结论",
        "",
        "comment",
      ].join("\n"),
    );
    expect(parsed?.sections.map((section) => section.title)).toEqual([
      "附录:各审查者交付物",
      "结论",
    ]);
  });

  it("parses the live #126 aggregator layout into cards", () => {
    const parsed = parseReviewReport(
      [
        "# Autonomous Review Report",
        "",
        "- Run: ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        "",
        "---",
        "",
        "## 共识发现",
        "",
        "1. **[critical/major] EventLog 撕裂 JSONL**  ",
        "   共识来源：adversarial。",
        "",
        "## 独有发现",
        "",
        "**review-correctness**",
        "",
        "- [major] WaitGroup 竞态",
        "",
        "## 分歧",
        "",
        "- **Verdict**：review-security 给 approve。",
        "",
        "## 结论",
        "",
        "changes-requested",
      ].join("\n"),
    );
    expect(parsed?.sections.find((s) => s.title === "共识发现")?.findings?.[0]?.severity).toBe(
      "critical",
    );
    expect(parsed?.sections.find((s) => s.title === "独有发现")?.groups?.[0]?.title).toBe(
      "review-correctness",
    );
    expect(parsed?.sections.find((s) => s.title === "分歧")?.findings?.[0]?.severity).toBeNull();
  });

  it("does not treat 分歧 labels as severity tags", () => {
    const parsed = parseReviewReport(
      [
        "# Autonomous Review Report",
        "",
        "- Run: ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        "",
        "---",
        "",
        "## 分歧",
        "",
        "- **Verdict**：review-security 给 approve；其余三位给 changes-requested。",
        "- **重试严重度**：adversarial = critical。",
        "",
        "## 结论",
        "",
        "changes-requested",
      ].join("\n"),
    );
    const section = parsed?.sections.find((item) => item.title === "分歧");
    expect(section?.groups).toBeNull();
    expect(section?.findings?.every((item) => item.severity === null)).toBe(true);
    expect(section?.body).toContain("**Verdict**");
  });
});
