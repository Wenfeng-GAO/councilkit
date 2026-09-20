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
});
