/**
 * Unit tests for the review prompt templates (plan §测试). Verifies the
 * three-section soft contract in the Attempt prompt and the five-section
 * aggregation directive, plus the boundary rules: failed Attempts are named as
 * absent only, and no workspace path is ever injected into the aggregate prompt.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  AGGREGATE_PROMPT_BUDGET,
  MAX_ATTEMPT_OUTPUT_IN_PROMPT,
  buildAggregatePrompt,
  buildAttemptPrompt,
  truncateForPrompt,
} from "../src/auto/templates/review";

describe("cli auto templates — attempt prompt", () => {
  const task = { pr: "https://example.com/pr/1" };

  it("contains the three-section soft contract", () => {
    const prompt = buildAttemptPrompt({ agentName: "A", personaPrompt: "be thorough", task });
    expect(prompt).toContain("## Findings");
    expect(prompt).toContain("## Verification");
    expect(prompt).toContain("## Verdict");
  });

  it("states the PR task and that the final message is the deliverable", () => {
    const prompt = buildAttemptPrompt({ agentName: "A", personaPrompt: "", task });
    expect(prompt).toContain("https://example.com/pr/1");
    expect(prompt).toMatch(/最终消息即交付物/);
  });

  it("injects focus and council topic when provided", () => {
    const prompt = buildAttemptPrompt({
      agentName: "A",
      personaPrompt: "",
      task: { task: "do x", focus: "security", councilTopic: "auth redesign" },
    });
    expect(prompt).toContain("security");
    expect(prompt).toContain("auth redesign");
  });

  it("uses --task free text when no --pr", () => {
    const prompt = buildAttemptPrompt({
      agentName: "A",
      personaPrompt: "",
      task: { task: "audit deps" },
    });
    expect(prompt).toContain("audit deps");
  });

  it("describes full autonomy (fetch/clone/checkout/test/lint)", () => {
    const prompt = buildAttemptPrompt({ agentName: "A", personaPrompt: "", task });
    expect(prompt).toMatch(/完全自主/);
    expect(prompt).toMatch(/fetch\/clone\/checkout/);
  });
});

describe("cli auto templates — aggregate prompt", () => {
  const task = { pr: "https://example.com/pr/1" };

  it("contains the five aggregation sections and cites attempt names", () => {
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [
        { attemptId: "a", name: "A", status: "success", output: "## Findings\n- foo" },
        { attemptId: "b", name: "B", status: "success", output: "## Findings\n- bar" },
      ],
    });
    expect(prompt).toContain("## Overview");
    expect(prompt).toContain("## Consensus findings");
    expect(prompt).toContain("## Unique findings");
    expect(prompt).toContain("## Disagreements");
    expect(prompt).toContain("## Verdict");
    expect(prompt).toContain("A");
    expect(prompt).toContain("B");
  });

  it("names failed attempts as absent and forbids citing them as consensus", () => {
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [
        { attemptId: "a", name: "A", status: "success", output: "ok" },
        { attemptId: "b", name: "Broken", status: "failure", output: "" },
      ],
    });
    expect(prompt).toContain("Broken");
    expect(prompt).toMatch(/不可作为共识来源/);
    // The failed attempt's empty output must not be embedded as a deliverable.
    expect(prompt).not.toContain("### Broken\n");
  });

  it("never embeds a workspace path", () => {
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [
        {
          attemptId: "a",
          name: "A",
          status: "success",
          output: "finding",
        },
      ],
    });
    // The directive forbids paths, but no actual path token may be injected.
    expect(prompt).not.toMatch(/\/workspaces\//);
    expect(prompt).not.toMatch(/runs\/ck-review-/);
  });

  it("truncates a single attempt's output to the prompt cap with a marker", () => {
    const big = "x".repeat(MAX_ATTEMPT_OUTPUT_IN_PROMPT + 500);
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [{ attemptId: "a", name: "A", status: "success", output: big }],
    });
    expect(prompt).toContain("[truncated at");
    // The full oversized output must not appear verbatim.
    expect(prompt).not.toContain(big);
  });

  it("truncateForPrompt passes short text through unchanged", () => {
    expect(truncateForPrompt("short")).toBe("short");
  });

  it("enforces a total byte budget by proportionally truncating large outputs", () => {
    const big = "x".repeat(MAX_ATTEMPT_OUTPUT_IN_PROMPT);
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [
        { attemptId: "a", name: "A", status: "success", output: big },
        { attemptId: "b", name: "B", status: "success", output: big },
        { attemptId: "c", name: "C", status: "success", output: big },
      ],
    });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(AGGREGATE_PROMPT_BUDGET);
    // At least one retained output was shrunk (budget-driven, not just per-attempt cap).
    expect(prompt).toContain("[truncated at");
  });

  it("drops the oldest outputs (omitted) when the budget still cannot fit all", () => {
    const attempts = Array.from({ length: 400 }, (_, i) => ({
      attemptId: `a${i}`,
      name: `Agent${i}`,
      status: "success" as const,
      output: `${i}:`.padEnd(1024, "x"),
    }));
    const prompt = buildAggregatePrompt({ aggregatorName: "R", task, attempts });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(AGGREGATE_PROMPT_BUDGET);
    expect(prompt).toContain("因聚合预算省略");
    // Oldest dropped from the deliverables section ...
    expect(prompt).not.toContain("### Agent0\n");
    // ... while the newest is retained as a deliverable.
    expect(prompt).toContain("### Agent399");
  });
});
