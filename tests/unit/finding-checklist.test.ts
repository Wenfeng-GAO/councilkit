/**
 * @vitest-environment node
 */
import { buildFindingChecklist } from "@/lib/finding-checklist";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

describe("buildFindingChecklist", () => {
  const mockRun: CliRunDetailResponse = {
    runId: "ck-run-test-123",
    kind: "review",
    title: "Test Review",
    status: "completed",
    markdown: "Full report content",
    truncated: false,
    hasFindings: true,
    findings: [
      {
        id: "finding-1",
        title: "触发与后果：调用方法前未检查对象是否为空",
        severity: "critical",
        source: "consensus",
        status: "open",
        text: "触发与后果：调用方法前未检查对象是否为空\n建议：添加空指针检查\n证据：在文件中发现多处",
        files: ["src/utils/helper.ts:42"],
        reviewer: "review-security",
      },
      {
        id: "finding-2",
        title: "触发与后果：直接拼接用户输入到 SQL 查询",
        severity: "major",
        source: "unique",
        status: "open",
        text: "触发与后果：直接拼接用户输入到 SQL 查询\n建议：使用参数化查询",
        files: ["src/db/queries.ts:15-20"],
        reviewer: "review-correctness",
      },
      {
        id: "finding-3",
        title: "建议：为新增功能添加测试覆盖",
        severity: "minor",
        source: "unique",
        status: "closed",
        text: "建议：为新增功能添加测试覆盖",
        files: [],
        reviewer: "review-maintainability",
        verification: {
          reviewer: "review-maintainability",
          method: "source_analysis",
          reason: "已在后续提交中添加测试",
          candidateSha: "abc123def456",
          evidence: "测试文件已创建",
          locations: ["tests/unit/feature.test.ts"],
        },
      },
    ],
    findingGroups: null,
    reviewEvidence: {
      sha: "abc123def456789",
      complete: true,
      evidenceComplete: true,
      prUrl: null,
      againstRunId: null,
      uncoveredIds: [],
    },
    progress: null,
    landings: [],
    planLock: null,
    pipeline: null,
    sourceRunId: null,
    lastError: null,
    createdAt: 1234567890,
    outerUsed: null,
    outerMax: null,
  };

  it("builds checklist with all findings by default", () => {
    const result = buildFindingChecklist(mockRun, { filter: "all" });

    expect(result).toContain("# 问题清单 (全部)");
    expect(result).toContain("共 3 个问题");
    expect(result).toContain("## #01 致命");
    expect(result).toContain("触发与后果：调用方法前未检查对象是否为空");
    expect(result).toContain("## #02 重大");
    expect(result).toContain("触发与后果：直接拼接用户输入到 SQL 查询");
    expect(result).toContain("## #03 次要");
    expect(result).toContain("建议：为新增功能添加测试覆盖");
    expect(result).toContain("`helper.ts:42`");
    expect(result).toContain("`queries.ts:15-20`");
  });

  it("filters to only pending findings", () => {
    const result = buildFindingChecklist(mockRun, { filter: "pending" });

    expect(result).toContain("# 问题清单 (待处理)");
    expect(result).toContain("共 3 个问题");
    expect(result).toContain("触发与后果：调用方法前未检查对象是否为空");
    expect(result).toContain("触发与后果：直接拼接用户输入到 SQL 查询");
    expect(result).toContain("建议：为新增功能添加测试覆盖");
  });

  it("filters to only resolved findings", () => {
    const result = buildFindingChecklist(mockRun, { filter: "resolved" });

    expect(result).toContain("# 问题清单 (已解决)");
    expect(result).toContain("当前筛选无问题");
  });

  it("includes actionable suggestions when present", () => {
    const result = buildFindingChecklist(mockRun, { filter: "all" });

    expect(result).toContain("**建议**: 添加空指针检查");
    expect(result).toContain("**建议**: 使用参数化查询");
    expect(result).toContain("**建议**: 为新增功能添加测试覆盖");
  });

  it("includes status tags", () => {
    const result = buildFindingChecklist(mockRun, { filter: "all" });

    // Check that status tags are present with blocking status first
    expect(result).toContain("待处理");
    expect(result).toContain("账本阻塞");
    expect(result).toContain("共识");
    expect(result).toContain("独有");
    expect(result).toContain("待验证当前提交");
  });

  it("handles empty findings list", () => {
    const emptyRun = {
      ...mockRun,
      findings: [],
      hasFindings: false,
    };

    const result = buildFindingChecklist(emptyRun, { filter: "all" });

    expect(result).toContain("当前筛选无问题");
  });

  it("can omit header when requested", () => {
    const result = buildFindingChecklist(mockRun, {
      filter: "all",
      includeHeader: false,
    });

    expect(result).not.toContain("# 问题清单");
    expect(result).not.toContain("Run:");
    expect(result).toContain("## #01 致命 · 触发与后果：调用方法前未检查对象是否为空");
  });

  it("includes commit SHA in header", () => {
    const result = buildFindingChecklist(mockRun, { filter: "all" });

    expect(result).toContain("Run: ck-run-test-123");
    expect(result).toContain("Commit: abc123def456");
  });

  it("handles findings with merged members", () => {
    const runWithGroups: CliRunDetailResponse = {
      ...mockRun,
      findingGroups: {
        groups: [
          {
            rootCauseId: "root-1",
            basis: "重复的空指针问题",
            findingIds: ["finding-1", "finding-2"],
            aliases: [],
          },
        ],
      },
    };

    const result = buildFindingChecklist(runWithGroups, { filter: "all" });

    expect(result).toContain("**根因**: 重复的空指针问题");
    expect(result).toContain("合并 2 条");
  });

  it("extracts actionable suggestions without full text blocks", () => {
    const result = buildFindingChecklist(mockRun, { filter: "all" });

    // Should NOT contain the evidence label line from full text
    expect(result).not.toContain("证据：在文件中发现多处");

    // Should contain extracted suggestions as separate **建议** lines
    expect(result).toContain("**建议**: 添加空指针检查");
    expect(result).toContain("**建议**: 使用参数化查询");
    expect(result).toContain("**建议**: 为新增功能添加测试覆盖");

    // Title may contain "触发与后果：" as part of the extracted title
    expect(result).toContain("触发与后果：");
  });
});
