/**
 * QA black-box reports (#383 #384 #385) reshaped by the designer order.
 * Fixtures are the pre-fix Markdown from the 6867714 precheck.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReportAbsence } from "../src/auto/absences";
import { shapeAggregateDeliverable } from "../src/auto/consensus";

const LOCKED = ["## 结论", "## 阻塞问题", "## 需处理的问题", "## 待确认"] as const;

function load(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/qa-382", name), "utf8");
}

function absencesIn(markdown: string): ReportAbsence[] {
  const out: ReportAbsence[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    const modern = /^缺席：(.+?)（(.+?)）：(.+)。?$/.exec(trimmed);
    if (modern?.[1] && modern[2] && modern[3]) {
      out.push({ name: modern[1], tool: modern[2], reason: modern[3] });
      continue;
    }
    const legacy = /^缺席：(.+?)（(.+)）$/.exec(trimmed);
    if (legacy?.[1] && legacy[2]) {
      out.push({ name: legacy[1], tool: "工具", reason: legacy[2] });
    }
  }
  return out;
}

function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^## .+$/gm)].map((match) => match[0]);
}

function conclusionOf(markdown: string): string {
  const start = markdown.indexOf("## 结论");
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next);
}

function reshape(name: string, specSource?: string): string {
  const markdown = load(name);
  return shapeAggregateDeliverable({
    markdown,
    task: specSource ? { specSource, specText: "IN-1 余额不足必须失败\nAC-1 不得透支" } : {},
    attempts: [],
    absences: absencesIn(markdown),
  });
}

function assertReplaced(markdown: string): void {
  const titles = headings(markdown);
  for (const title of LOCKED) {
    expect(titles.filter((row) => row === title)).toEqual([title]);
  }
  expect(titles.slice(0, 4)).toEqual([...LOCKED]);
  expect(markdown).not.toContain("无缺席");
  expect(markdown).not.toMatch(/^阻塞数/m);
  expect(markdown).not.toMatch(/^阻塞 \d+。$/m);
  const blocking = conclusionOf(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^阻塞\s+\d+/.test(line));
  expect(blocking).toEqual([expect.stringMatching(/^阻塞 \d+ 个问题$/)]);
}

describe("QA report rewrite", () => {
  it("R3 and R3b keep each heading once and one blocking line", () => {
    for (const name of ["R3.md", "R3b.md"]) {
      const shaped = reshape(name, "docs/vibespec/wallet/VERIFY.md");
      assertReplaced(shaped);
      expect(shaped).toContain("[act-on]");
      expect(conclusionOf(shaped)).toContain("缺席：");
    }
  });

  it("R2b drops the empty 待确认 sentence", () => {
    const shaped = reshape("R2b.md");
    assertReplaced(shaped);
    expect(conclusionOf(shaped)).not.toContain("单席意见见");
    expect(shaped).toContain("## 需处理的问题");
    expect(shaped).not.toContain("[act-on]");
    expect(shaped).not.toContain("[suggest-amend-spec]");
  });

  it("R6clean has no duplicate sections and no spec tags", () => {
    const shaped = reshape("R6clean.md");
    assertReplaced(shaped);
    expect(shaped).not.toContain("[act-on]");
    expect(shaped).not.toContain("[suggest-amend-spec]");
    expect(shaped).not.toContain("合同内 Act On");
    expect(conclusionOf(shaped)).toContain("阻塞 0 个问题");
  });

  it("R6toy states each basis fact once in the conclusion and once per finding", () => {
    const shaped = reshape("R6toy.md");
    assertReplaced(shaped);
    const basis =
      "无规格依据，依据是 3/3 席一致：review-correctness、review-adversarial、review-third";
    const conclusionHits = conclusionOf(shaped)
      .split("\n")
      .filter((line) => line.trim() === basis);
    expect(conclusionHits).toHaveLength(1);
    const blocking = shaped.slice(shaped.indexOf("## 阻塞问题"), shaped.indexOf("## 需处理的问题"));
    expect(blocking.split("\n").filter((line) => line.includes(basis))).toHaveLength(2);
  });
});
