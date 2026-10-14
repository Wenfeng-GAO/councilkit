import { parseFindings, parseReviewReport } from "@/lib/review-report";
import { describe, expect, it } from "vitest";

describe("review report markup edges", () => {
  it("keeps a non-severity bracket tag as a qualifier", () => {
    expect(parseFindings("- [note][extra] something happened\nmore detail")).toEqual([
      {
        severity: null,
        qualifier: "note][extra",
        text: "something happened\nmore detail",
      },
    ]);
  });

  it("keeps an escaped pipe inside an attempts table cell", () => {
    const parsed = parseReviewReport(`# Autonomous Review Report

| Attempt | Driver/Model | 结果 | 耗时 | 工具调用 |
| --- | --- | --- | --- | --- |
| review\\|sec | claude \\| extra | ok | 1s | 2 |

---

## 结论

comment
`);
    expect(parsed?.attempts).toEqual([
      {
        name: "review|sec",
        driver: "claude | extra",
        result: "ok",
        duration: "1s",
        tools: "2",
      },
    ]);
  });
});
