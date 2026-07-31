/**
 * Unit tests for the review report renderer (plan §测试 / §"报告重排"). Covers the
 * attempts summary table, the section ordering (table → five chapters → 过程对比
 * → 附录), fence-aware ATX heading demotion, proxy-prefix stripping with
 * adjacent ×N run-length encoding, and the transient-retry appendix mark.
 */
import { describe, expect, it } from "vitest";
import { type ReviewReportInput, renderReviewReport } from "../src/auto/aggregate";
import type { AttemptResult } from "../src/auto/runner";

function attempt(partial: Partial<AttemptResult> & { agentName: string }): AttemptResult {
  return {
    attemptId: partial.attemptId ?? "attempt-0",
    agentId: partial.agentId ?? "a",
    agentName: partial.agentName,
    driverId: partial.driverId ?? "claude-stream-json",
    modelId: partial.modelId ?? "m",
    status: partial.status ?? "success",
    output: partial.output ?? "",
    exitCode: partial.exitCode ?? 0,
    durationMs: partial.durationMs ?? 0,
    workspace: partial.workspace ?? "/ws",
    failure: partial.failure,
    activity: partial.activity,
    reused: partial.reused,
    attemptNumber: partial.attemptNumber,
    retryOf: partial.retryOf,
  };
}

const AGGREGATOR_BODY = [
  "## 概览",
  "summary",
  "## 共识发现",
  "- shared",
  "## 独有发现",
  "- unique",
  "## 分歧",
  "none",
  "## 结论",
  "approve",
].join("\n");

function buildInput(
  attempts: AttemptResult[],
  overrides: Partial<ReviewReportInput> = {},
): ReviewReportInput {
  return {
    runId: "ck-review-test",
    startedAt: "2026-07-31T00:00:00.000Z",
    endedAt: "2026-07-31T00:05:00.000Z",
    task: { pr: "https://github.com/a/b/pull/1" },
    attempts,
    aggregator: {
      attemptId: "aggregator",
      agentId: "agg",
      agentName: "Agg",
      driverId: "claude-stream-json",
      modelId: "m",
    },
    aggregation: attempt({ agentName: "Agg", output: AGGREGATOR_BODY }),
    status: "completed",
    incomplete: false,
    ...overrides,
  };
}

describe("cli auto aggregate — attempts table", () => {
  it("renders the fixed five-column header", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          durationMs: 48_000,
          activity: { toolCalls: 3, commands: [] },
        }),
      ]),
    );
    expect(md).toContain("| Attempt | Driver/Model | 结果 | 耗时 | 工具调用 |");
    expect(md).toContain("| Alice | claude-stream-json/m | ok | 48s | 3 |");
  });

  it("shows 无过程数据 in the 工具调用 column when activity is absent", () => {
    const md = renderReviewReport(buildInput([attempt({ agentName: "Bob", activity: undefined })]));
    expect(md).toContain("| Bob | claude-stream-json/m | ok | 0s | 无过程数据 |");
  });

  it("formats 耗时 via formatDurationMs and shows failed:code for failures", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "A",
          status: "failure",
          exitCode: 1,
          durationMs: 1_250_000,
          failure: { code: "EXIT", message: "non-zero exit 1" },
          activity: { toolCalls: 0, commands: [] },
        }),
      ]),
    );
    expect(md).toContain("| A | claude-stream-json/m | failed:EXIT | 20m50s | 0 |");
  });
});

describe("cli auto aggregate — section ordering", () => {
  it("renders table → five chapters → 过程对比 → 附录:各审查者交付物", () => {
    const md = renderReviewReport(
      buildInput([attempt({ agentName: "Alice", output: "## 发现\n- x" })]),
    );
    const tableIdx = md.indexOf("| Attempt | Driver/Model");
    const bodyIdx = md.indexOf("## 概览");
    const procIdx = md.indexOf("## 过程对比");
    const appIdx = md.indexOf("## 附录:各审查者交付物");
    expect(tableIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(tableIdx);
    expect(procIdx).toBeGreaterThan(bodyIdx);
    expect(appIdx).toBeGreaterThan(procIdx);
    expect(md).toContain("## 共识发现");
    expect(md).toContain("## 结论");
  });
});

describe("cli auto aggregate — fence-aware heading demotion", () => {
  it("demotes ATX H1–H6 by two levels outside a fence", () => {
    const output = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\nbody under the headings";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("## 附录:各审查者交付物"));
    // H1→### H1 … H6→######## H6 (two hashes added, under the `### Alice` heading).
    expect(appendix).toContain("### H1\n");
    expect(appendix).toContain("#### H2\n");
    expect(appendix).toContain("##### H3\n");
    expect(appendix).toContain("###### H4\n");
    expect(appendix).toContain("####### H5\n");
    expect(appendix).toContain("######## H6\n");
  });

  it("leaves `#` inside a backtick fence untouched", () => {
    const output = "# Outside\n```\n# not demoted\n## also inside\n```\n# After";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("### Outside\n");
    expect(appendix).toContain("\n# not demoted\n");
    expect(appendix).toContain("\n## also inside\n");
    expect(appendix).toContain("### After");
  });

  it("leaves `#` inside a tilde fence untouched", () => {
    const output = "# Outside\n~~~bash\n# inside tildes\n~~~\n# After";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("\n# inside tildes\n");
    expect(appendix).toContain("### After");
  });

  it("does not close a fence on a ``` line carrying info/text (only on a bare fence run)", () => {
    // Reviewer finding: the close-fence regex was not anchored to end-of-line,
    // so a same-character fence run WITH trailing info/text (e.g. ```text inside
    // a fenced block) was mistaken for a close, re-enabling heading demotion
    // mid-fence. A close must be the fence run alone on its line.
    const output = "# Outside\n```\n# inside\n```text\n# still inside\n```\n# After";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("### Outside\n");
    // The ```text line did NOT close the fence → the next line stays verbatim.
    expect(appendix).toContain("\n# still inside\n");
    expect(appendix).toContain("```text");
    // The bare ``` line DOES close → the trailing heading is demoted.
    expect(appendix).toContain("### After");
    // The line immediately after the opening fence stayed inside (not demoted).
    expect(appendix).toContain("\n# inside\n");
  });

  it("does not process Setext headings (left verbatim)", () => {
    const output = "A title\n======\n\nA section\n------\n";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("A title\n======");
    expect(appendix).toContain("A section\n------");
    // No `##` prefix was added before "A title".
    expect(appendix).not.toContain("##A title");
    expect(appendix).not.toContain("## A title");
  });

  it("does not open a backtick fence when the info string contains a backtick (CommonMark)", () => {
    // Reviewer finding: a backtick fence's info string must not contain a
    // backtick (CommonMark). A line like ``` `foo` ``` is paragraph text, NOT a
    // fence opening — so the H1 that follows must still be demoted. The old
    // open-fence rule accepted any line starting with ``` and swallowed the
    // rest of the deliverable as a fenced block, disabling demotion.
    const output = "``` `foo`\n# should be demoted\n```\n# after";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    // The ``` `foo` line did NOT open a fence → the next H1 is demoted.
    expect(appendix).toContain("### should be demoted\n");
    // The illegal-fence line is kept verbatim as paragraph text.
    expect(appendix).toContain("``` `foo`");
  });

  it("a tilde fence with a backtick in its info string DOES open (tilde is unrestricted)", () => {
    // CommonMark restriction is backtick-fence-only; a tilde fence's info string
    // may contain backticks. The H1 inside stays verbatim, the trailing H1 is
    // demoted after the fence closes.
    const output = "~~~ `foo`\n# inside tilde fence\n~~~\n# after";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("\n# inside tilde fence\n");
    expect(appendix).toContain("### after");
  });
});

describe("cli auto aggregate — process comparison command normalization", () => {
  it("strips the proxy env prefix and run-length encodes adjacent dupes as ×N", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          activity: {
            toolCalls: 5,
            commands: [
              "NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' git diff",
              "NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' git diff",
              "NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' git diff",
              "ls -la",
            ],
          },
        }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    expect(proc).toContain("已省略命令前的 NO_PROXY/HTTPS_PROXY/HTTP_PROXY 等代理前缀");
    expect(proc).toContain("`git diff ×3`");
    expect(proc).toContain("`ls -la`");
    // The raw proxy prefix never reaches the report.
    expect(proc).not.toContain("NO_PROXY='*'");
  });

  it("does NOT merge non-adjacent duplicates", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          activity: { toolCalls: 3, commands: ["git diff", "ls", "git diff"] },
        }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    expect(proc).not.toContain("git diff ×2");
    // Both occurrences are kept as separate command lines.
    const matches = proc.match(/`git diff`/g);
    expect(matches).toHaveLength(2);
  });

  it("omits the proxy note when no command carried a proxy prefix", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({ agentName: "Alice", activity: { toolCalls: 1, commands: ["make test"] } }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    expect(proc).not.toContain("已省略命令前的");
  });

  it("merges the stripped-proxy flag across ×N members (note fires if any member had a prefix)", () => {
    // Reviewer finding: when adjacent identical (post-strip) commands were
    // run-length encoded, the strippedProxy flag was taken only from the first
    // member. A group whose first member lacked the prefix (bare `git diff`)
    // but whose second had one (`NO_PROXY='*' git diff`) lost the flag, so the
    // 「已省略」note silently disappeared even though a proxy was stripped.
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          activity: {
            toolCalls: 2,
            commands: ["git diff", "NO_PROXY='*' git diff"],
          },
        }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    expect(proc).toContain("`git diff ×2`");
    expect(proc).toContain("已省略命令前的 NO_PROXY/HTTPS_PROXY/HTTP_PROXY 等代理前缀");
    expect(proc).not.toContain("NO_PROXY='*'");
  });
});

describe("cli auto aggregate — process comparison single-line shape", () => {
  it("renders ONE line per final Attempt (no multi-line command list)", () => {
    // Reviewer finding: the plan asked for a single line per final Attempt, but
    // the renderer emitted a multi-line bullet (耗时 / 工具调用 / one line per
    // command). The single line is:
    //   - <name> (<driver/model>) — <耗时> — 工具调用 N 次 — `cmd1`; `cmd2 ×3`
    // with the command segment omitted when empty and 「无过程数据」 when no
    // activity was captured.
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          durationMs: 48_000,
          activity: { toolCalls: 3, commands: ["git diff", "ls", "git diff"] },
        }),
        attempt({ agentName: "Bob", activity: undefined }),
        attempt({
          agentName: "Carol",
          durationMs: 1_000,
          activity: { toolCalls: 1, commands: [] },
        }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    // Alice: one line, non-adjacent dupes kept separately, joined by "; ".
    expect(proc).toContain(
      "- Alice (claude-stream-json/m) — 48s — 工具调用 3 次 — `git diff`; `ls`; `git diff`",
    );
    // Bob: no activity → 无过程数据, single line.
    expect(proc).toContain("- Bob (claude-stream-json/m) — 0s — 无过程数据");
    // Carol: no commands → trailing command segment omitted.
    expect(proc).toContain("- Carol (claude-stream-json/m) — 1s — 工具调用 1 次");
    // No indented per-command bullets remain.
    expect(proc).not.toMatch(/\n {2}- `/);
    // Exactly one "- " bullet per Attempt (3 attempts → 3 bullets).
    const bullets = proc.match(/^- /gm);
    expect(bullets).toHaveLength(3);
  });

  it("joins adjacent run-length-encoded commands on the single line", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          durationMs: 5_000,
          activity: {
            toolCalls: 2,
            commands: ["NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' git diff", "git diff"],
          },
        }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    expect(proc).toContain("- Alice (claude-stream-json/m) — 5s — 工具调用 2 次 — `git diff ×2`");
    expect(proc).toContain("已省略命令前的 NO_PROXY/HTTPS_PROXY/HTTP_PROXY 等代理前缀");
    // Still a single bullet for the attempt.
    const bullets = proc.match(/^- /gm);
    expect(bullets).toHaveLength(1);
  });
});

describe("cli auto aggregate — transient retry mark", () => {
  it("marks a retried attempt in the appendix and keeps only the final result", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({ agentName: "Alice", output: "## 发现\n- x", attemptNumber: 2, retryOf: 1 }),
      ]),
    );
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("第 1 次尝试（失败，已重试）");
  });

  it("does not mark a non-retried attempt", () => {
    const md = renderReviewReport(
      buildInput([attempt({ agentName: "Alice", output: "## 发现\n- x", attemptNumber: 1 })]),
    );
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).not.toContain("第 1 次尝试");
  });
});
