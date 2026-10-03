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
});
