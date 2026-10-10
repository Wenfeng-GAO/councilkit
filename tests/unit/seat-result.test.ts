import { cliRunAttemptResultSchema } from "@shared/runtime/schemas";
import { summarizeSeatOutput } from "@shared/runtime/seat-result";
import { describe, expect, it } from "vitest";

describe("summarizeSeatOutput", () => {
  it("does not treat missing structure as zero findings", () => {
    expect(summarizeSeatOutput(null)).toEqual({
      parseStatus: "empty",
      summary: null,
      findingCount: null,
      blockingCount: null,
    });
    expect(summarizeSeatOutput("looked at the diff and will write later")).toMatchObject({
      parseStatus: "unparsed",
      findingCount: null,
      blockingCount: null,
    });
  });

  it("counts severity tags and keeps an overview excerpt", () => {
    const output = `## 概览

鉴权绕过仍可复现，建议先修。

## 发现

- [critical] 未校验 session
- [major] 错误被吞掉
- [nit] 命名不一致
`;
    expect(summarizeSeatOutput(output)).toEqual({
      parseStatus: "parsed",
      summary: "鉴权绕过仍可复现，建议先修。",
      findingCount: 3,
      blockingCount: 2,
    });
  });

  it("parses an empty structured report as zero listed findings", () => {
    const output = `## 概览

没有列出具体缺陷。

## 结论

comment
`;
    expect(summarizeSeatOutput(output)).toEqual({
      parseStatus: "parsed",
      summary: "没有列出具体缺陷。",
      findingCount: 0,
      blockingCount: 0,
    });
  });

  it("ignores a fenced review example when counting findings and reading the overview", () => {
    const output = [
      "旧报告摘录：",
      "",
      "```md",
      "## 概览",
      "示例概述，不该出现在席位摘要里。",
      "## 发现",
      "- [critical] 示例缺陷",
      "- [major] 另一条示例",
      "```",
      "",
      "## 概览",
      "",
      "本席没有阻塞项。",
      "",
      "## 发现",
      "",
      "- [nit] 措辞可以更短",
    ].join("\n");
    expect(summarizeSeatOutput(output)).toEqual({
      parseStatus: "parsed",
      summary: "本席没有阻塞项。",
      findingCount: 1,
      blockingCount: 0,
    });
  });

  it("clips an emoji overview to the UTF-16 budget the list schema accepts", () => {
    const emoji = "😀";
    const output = `## 概览\n\n${emoji.repeat(240)}\n`;
    const result = summarizeSeatOutput(output);
    expect(result.summary).toBe(emoji.repeat(120));
    expect(cliRunAttemptResultSchema.safeParse(result).success).toBe(true);
  });

  it("drops an emoji that would split a surrogate at the summary limit", () => {
    const output = `## 概览\n\n${"a".repeat(239)}😀\n`;
    expect(summarizeSeatOutput(output).summary).toBe("a".repeat(239));
  });

  it("counts a short act-on major even when the next item is suggest-amend-spec", () => {
    // Regression: an 80-char lookahead used to see the next item's marker and
    // wrongly exclude the first finding from blockingCount.
    const output = `## 概览

短项回归。

## 发现

- [major][act-on] 短阻塞项
- [major][suggest-amend-spec] 规格外建议
`;
    expect(summarizeSeatOutput(output)).toEqual({
      parseStatus: "parsed",
      summary: "短项回归。",
      findingCount: 2,
      blockingCount: 1,
    });
  });

  it("does not count suggest-amend-spec majors as blocking", () => {
    const output = `## 概览

仅规格外。

## 发现

- [major][suggest-amend-spec] 规格未覆盖缓存上限
- [critical][out-of-spec] 规格外临界项
`;
    expect(summarizeSeatOutput(output)).toEqual({
      parseStatus: "parsed",
      summary: "仅规格外。",
      findingCount: 2,
      blockingCount: 0,
    });
  });

});
