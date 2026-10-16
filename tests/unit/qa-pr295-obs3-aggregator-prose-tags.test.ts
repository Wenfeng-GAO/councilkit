/**
 * QA-PR295-OBS3 (#288): the aggregator's progress blockingCount counted
 * severity tags quoted in prose (## 分歧: 「review-adversarial 标 `[critical]`，
 * review-correctness 标 `[major]`。聚合取 `[major]`」) as findings. QA's PR295
 * head-B run reported 9 findings / 4 blocking for 3 real findings, all 规格外;
 * R-1 reported 6 / 1 for 3 real findings, all 规格外. Fixture text is the
 * aggregator section of QA's real report.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeSeatOutput } from "@shared/runtime/seat-result";
import { describe, expect, it } from "vitest";

function aggregatorSection(path: string): string {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("## 概览");
  const end = text.indexOf("## 过程对比");
  return text.slice(start, end);
}

describe("QA-PR295-OBS3 aggregator counts only real finding items", () => {
  it("QA head-B run: 3 findings, 0 blocking (all suggest-amend-spec), prose tags ignored", () => {
    const section = aggregatorSection(join(__dirname, "../fixtures/qa-pr295-task-run/report.md"));
    expect(section).toContain("标 `[critical]`");
    expect(summarizeSeatOutput(section)).toMatchObject({ findingCount: 3, blockingCount: 0 });
  });

  it("R-1 shape: a quoted `[major]` in 分歧 is not a blocking finding", () => {
    const text = [
      "## 建议修订规格",
      "- [major][suggest-amend-spec] 求和循环闭区间上界导致多加一项出错",
      "- [major][suggest-amend-spec] 非空数组取末项因下标越界恒得空值",
      "## 分歧",
      "支付令牌严重度：review-correctness 标 `[minor]`；review-adversarial 标 `[major]`（密钥入库模式）。",
    ].join("\n");
    expect(summarizeSeatOutput(text)).toMatchObject({ findingCount: 2, blockingCount: 0 });
  });

  it("still counts list, numbered and heading findings; in-contract majors still block", () => {
    const text = [
      "## 发现",
      "- [major][act-on] A",
      "1. [critical] B",
      "### [major] C",
      "- **[minor]** D",
    ].join("\n");
    expect(summarizeSeatOutput(text)).toMatchObject({ findingCount: 4, blockingCount: 3 });
  });
});
