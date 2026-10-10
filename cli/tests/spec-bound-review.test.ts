/**
 * Spec-bound review: extraction classifies Act On vs suggest-amend-spec;
 * prompts bind a named spec and separate the two finding classes.
 */
import { describe, expect, it } from "vitest";
import { extractFindingsFromReport } from "../src/auto/ledger";
import { isFindingBlocking } from "@shared/runtime/cli-ledger";
import {
  AGGREGATE_PROMPT_BUDGET,
  AGGREGATE_PROMPT_RESERVED_OVERHEAD,
  MAX_SPEC_TEXT_IN_PROMPT,
  buildAggregatePrompt,
  buildAttemptPrompt,
} from "../src/auto/templates/review";

describe("spec-bound extraction", () => {
  const report = `# Autonomous Review Report

- Run: ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1
- Status: complete

---

## 概览

合同减法样例。

## 共识发现

- [major][act-on] 取消路径仍泄漏 waiter
  位置：\`src/wait.ts:10\`
  不变量：\`AC-12\`
  反例：并发 cancel 后 registry.size > 0
  触发与后果：回调仍被调用导致双重结算。
  建议：先 deregister。

- [major][act-on] 缺脚注的重大项不应阻塞
  位置：\`src/other.ts:1\`
  触发与后果：有 act-on 标签但没有不变量与反例。

## 建议修订规格

- [critical][suggest-amend-spec] 规格未覆盖全局缓存上限
  位置：\`src/cache.ts:3\`
  触发与后果：无界增长。
  建议：在规格中增加缓存上限不变量。

## 独有发现

- [nit][act-on] 注释行号风格
  位置：\`src/wait.ts:99\`
  不变量：\`STYLE-1\`
  反例：注释写成 // L99
  建议：忽略。

## 结论

changes-requested
`;

  it("extracts contract classes and gates Act On vs out-of-spec vs nit", () => {
    const file = extractFindingsFromReport({
      markdown: report,
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      extractedAt: "2026-10-10T00:00:00.000Z",
      sha: "a".repeat(40),
    });
    const byTitle = Object.fromEntries(file.findings.map((row) => [row.title, row]));
    const actOn = file.findings.find((row) => row.invariantId === "AC-12");
    expect(actOn?.contractClass).toBe("in_contract");
    expect(actOn?.counterexample).toContain("registry.size");
    expect(isFindingBlocking(actOn!)).toBe(true);

    const unfooted = file.findings.find((row) => row.title.includes("缺脚注"));
    expect(unfooted?.contractClass).toBe("in_contract");
    expect(isFindingBlocking(unfooted!)).toBe(false);

    const amend = file.findings.find((row) => row.title.includes("缓存上限"));
    expect(amend?.contractClass).toBe("out_of_spec");
    expect(isFindingBlocking(amend!)).toBe(false);

    const nit = file.findings.find((row) => row.severity === "nit");
    expect(isFindingBlocking(nit!)).toBe(false);
    expect(Object.keys(byTitle).length).toBeGreaterThanOrEqual(4);
  });
});

describe("spec-bound prompts", () => {
  it("binds an explicit spec source and distinguishes Act On vs suggest-amend-spec", () => {
    const prompt = buildAttemptPrompt({
      agentName: "review-adversarial",
      personaPrompt: "adversarial",
      task: {
        pr: "https://github.com/acme/repo/pull/1",
        specSource: "docs/plans/example.md",
        specText: "AC-12: cancel deregisters waiters",
      },
    });
    expect(prompt).toContain("## 绑定规格（审查合同）");
    expect(prompt).toContain("docs/plans/example.md");
    expect(prompt).toContain("AC-12: cancel deregisters waiters");
    expect(prompt).toContain("[act-on]");
    expect(prompt).toContain("[suggest-amend-spec]");
    expect(prompt).toContain("不变量");
    expect(prompt).toContain("反例");
  });

  it("aggregator requires dedupe and non-blocking out-of-spec / nits", () => {
    const prompt = buildAggregatePrompt({
      aggregatorName: "review-adversarial",
      task: { task: "review the change" },
      attempts: [
        {
          attemptId: "a1",
          name: "A",
          status: "success",
          output: "## 发现\n- [major][act-on] x\n  不变量：`AC-1`\n  反例：y\n\n## 结论\nchanges-requested\n",
        },
      ],
    });
    expect(prompt).toContain("## 建议修订规格");
    expect(prompt).toContain("去重");
    expect(prompt).toContain("suggest-amend-spec");
    expect(prompt).toContain("不得因规格外或 nit 阻塞合并");
  });
});

describe("spec hard-gate prompt posture", () => {
  it("does not claim PR body alone is the default contract", () => {
    const prompt = buildAttemptPrompt({
      agentName: "review-adversarial",
      personaPrompt: "adversarial",
      task: {
        pr: "https://github.com/acme/repo/pull/1",
        specSource: "docs/plans/example.md",
        specText: "AC-12: cancel deregisters waiters",
        acceptanceIds: ["AC-12"],
        verifyScheduleNote: "Verify schedule: after/with contract review, verify against AC-12",
      },
    });
    expect(prompt).not.toContain("规格来源（默认）：本任务的 PR 描述");
    expect(prompt).toMatch(/不得把 PR 描述单独当作合同|硬拒绝|审查阶段会拒绝/);
    expect(prompt).toContain("## 验收点（verify）");
    expect(prompt).toContain("AC-12");
  });
});

describe("spec size vs aggregate budget", () => {
  it("documents reserved overhead so MAX_SPEC_TEXT_IN_PROMPT leaves room", () => {
    expect(AGGREGATE_PROMPT_RESERVED_OVERHEAD).toBe(48 * 1024);
    expect(MAX_SPEC_TEXT_IN_PROMPT).toBe(
      AGGREGATE_PROMPT_BUDGET - AGGREGATE_PROMPT_RESERVED_OVERHEAD,
    );
    expect(MAX_SPEC_TEXT_IN_PROMPT).toBeLessThan(AGGREGATE_PROMPT_BUDGET);
  });

  it("near-max spec still leaves room for Attempt content in aggregate", () => {
    const nearMaxSpec = "S".repeat(MAX_SPEC_TEXT_IN_PROMPT);
    const attemptMarker = "UNIQUE_ATTEMPT_EVIDENCE_xyz";
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task: {
        task: "review the change",
        specSource: "docs/plans/near-max.md",
        specText: nearMaxSpec,
      },
      attempts: [
        {
          attemptId: "a1",
          name: "ReviewerA",
          status: "success",
          output: `## 发现\n- [major][act-on] ${attemptMarker}\n  不变量：\`AC-1\`\n  反例：y\n\n## 结论\nchanges-requested\n`,
        },
      ],
    });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(AGGREGATE_PROMPT_BUDGET);
    expect(prompt).toContain("### ReviewerA");
    expect(prompt).toContain(attemptMarker);
    expect(prompt).not.toContain("（无成功的审查者交付物可供对比。）");
  });

  it("a formerly near-200KiB spec is truncated so Attempt outputs are kept", () => {
    const formerNearMax = "S".repeat(200 * 1024 - 64);
    const attemptMarker = "KEPT_AFTER_SPEC_TRUNCATION";
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task: {
        task: "review the change",
        specSource: "docs/plans/huge.md",
        specText: formerNearMax,
      },
      attempts: [
        {
          attemptId: "a1",
          name: "ReviewerB",
          status: "success",
          output: `## 发现\n- [major][act-on] ${attemptMarker}\n`,
        },
      ],
    });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(AGGREGATE_PROMPT_BUDGET);
    expect(prompt).toContain("### ReviewerB");
    expect(prompt).toContain(attemptMarker);
    expect(prompt).toContain("[truncated at");
    expect(prompt).toContain(String(MAX_SPEC_TEXT_IN_PROMPT));
  });
});
