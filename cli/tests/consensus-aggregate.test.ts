/**
 * No-spec majority rule (#377) and conclusion-first reports (#378).
 * The recorded three-seat toy is cli/tests/fixtures/toy-go-three-seat.json.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFindingBlocking } from "@shared/runtime/cli-ledger";
import { summarizeSeatOutput } from "@shared/runtime/seat-result";
import { describe, expect, it } from "vitest";
import {
  collectReportAbsences,
  failureAbsenceReason,
  formatAbsence,
  formatRequestedSeats,
} from "../src/auto/absences";
import { type ReviewReportInput, renderReviewReport } from "../src/auto/aggregate";
import { shapeAggregateDeliverable } from "../src/auto/consensus";
import { persistFindingsFromReport } from "../src/auto/ledger";
import type { AttemptResult } from "../src/auto/runner";

function seat(
  name: string,
  output: string,
  status: AttemptResult["status"] = "success",
): AttemptResult {
  return {
    attemptId: name,
    agentId: name,
    agentName: name,
    driverId: "kimi-stream-json",
    modelId: "m",
    status,
    output,
    exitCode: status === "success" ? 0 : 1,
    durationMs: 10,
    workspace: "/ws",
  };
}

function finding(title: string, severity = "major", extra = ""): string {
  return `## 发现\n- [${severity}] ${title}\n  位置：\`toy.go\`\n${extra}\n\n## 结论\nchanges-requested\n`;
}

const BAD_COMMENT = [
  "## 概览",
  "未绑定规格，默认不阻塞。",
  "## 共识发现",
  "无",
  "## 建议修订规格",
  "- [major][suggest-amend-spec] Add 把加法改成减法",
  "## 结论",
  "comment",
].join("\n");

function shape(
  markdown: string,
  attempts: AttemptResult[],
  specSource?: string,
  specText?: string,
): string {
  return shapeAggregateDeliverable({
    markdown,
    task: specSource ? { specSource, specText } : {},
    attempts,
  });
}

function firstH2(markdown: string): string | null {
  const match = markdown.match(/^## .+$/m);
  return match?.[0] ?? null;
}

describe("no-spec majority aggregation", () => {
  it("3/3 same high defect becomes changes-requested with the 依据 label", () => {
    const attempts = [
      seat("kimi", finding("Add 把 a + b 改成 a - b，减法替换加法")),
      seat("cursor", finding("Add 从 a + b 改为 a - b，加法被换成减法", "critical")),
      seat("codex", finding("函数 Add 的加法被改成减法 a - b")),
    ];
    const body = shape(BAD_COMMENT, attempts);
    expect(firstH2(body)).toBe("## 结论");
    expect(body).toMatch(/## 结论\n+changes-requested/);
    expect(body).toContain("无规格依据，依据是 3/3 席一致：kimi、cursor、codex");
    expect(body).toContain("[多席一致 3/3]");
    expect(body).toContain("阻塞 1 个问题");
    expect(summarizeSeatOutput(body).blockingCount).toBe(1);
    expect(body).not.toMatch(/## 结论\n+comment/);
  });

  it("2/3 same high defect blocks and the third seat is 待确认", () => {
    const attempts = [
      seat("kimi", finding("Add 把 a + b 改成 a - b，减法替换加法")),
      seat("cursor", finding("Add 从 a + b 改为 a - b，加法被换成减法", "major")),
      seat("codex", finding("注释过期无人维护", "minor")),
    ];
    const body = shape(BAD_COMMENT, attempts);
    expect(body).toMatch(/## 结论\n+changes-requested/);
    expect(body).toContain("无规格依据，依据是 2/3 席一致：kimi、cursor");
    expect(body).toContain("[多席一致 2/3]");
    expect(body).toContain("[待确认 · codex]");
    expect(body).toContain("阻塞 1 个问题");
    expect(summarizeSeatOutput(body).blockingCount).toBe(1);
  });

  it("does not treat a transitive token chain as one 3/3 defect", () => {
    const attempts = [
      seat("kimi", finding("timeout retry budget exhausted", "major")),
      seat("cursor", finding("timeout retry cache stampede", "critical")),
      seat("codex", finding("cache stampede queue backlog", "major")),
    ];
    const body = shape("## 结论\ncomment\n", attempts);
    expect(body).not.toContain("3/3");
    expect(body).toContain("无规格依据，依据是 2/3 席一致：kimi、cursor");
    expect(body).toContain("[待确认 · codex]");
    expect(body).not.toMatch(/席一致：[^\n]*codex/);
    expect(body).toMatch(/## 结论\n+changes-requested/);
  });

  it("1/3 does not block and names the seat under 待确认", () => {
    const attempts = [
      seat("kimi", finding("Add 把 a + b 改成 a - b，减法替换加法", "critical")),
      seat("cursor", "## 发现\n无\n\n## 结论\napprove\n"),
      seat("codex", "## 发现\n无\n\n## 结论\napprove\n"),
    ];
    const body = shape(BAD_COMMENT, attempts);
    expect(firstH2(body)).toBe("## 结论");
    expect(body).toMatch(/## 结论\n+comment/);
    expect(body).toContain("[待确认 · kimi]");
    expect(body).toContain("阻塞 0 个问题");
    expect(body).toContain("单席意见见「待确认」。");
    expect(body).not.toContain("多席一致");
    expect(summarizeSeatOutput(body).blockingCount).toBe(0);
  });

  it("does not merge unrelated defects just because they share a file", () => {
    const attempts = [
      seat("kimi", finding("Add 把 a + b 改成 a - b，减法替换加法")),
      seat("cursor", finding("日志时间戳丢了时区")),
      seat("codex", finding("配置热加载丢了锁")),
    ];
    const body = shape(BAD_COMMENT, attempts);
    expect(body).toMatch(/## 结论\n+comment/);
    expect(body).toContain("待确认 · kimi");
    expect(body).toContain("待确认 · cursor");
    expect(body).toContain("待确认 · codex");
    expect(summarizeSeatOutput(body).blockingCount).toBe(0);
  });

  it("keeps a spec-bound verdict and labels the acceptance id without the no-spec rule", () => {
    const specBody = [
      "## 概览",
      "合同内一项。",
      "## 共识发现",
      "- [major][act-on] 空串分支被删除",
      "  不变量：`AC-3`",
      '  反例：Greet("") 不再问候',
      "## 建议修订规格",
      "- [major][suggest-amend-spec] 缓存上限没写进规格",
      "## 结论",
      "changes-requested",
    ].join("\n");
    const attempts = [
      seat("kimi", finding("Add 把 a + b 改成 a - b，减法替换加法", "critical")),
      seat("cursor", finding("Add 从 a + b 改为 a - b，加法被换成减法", "critical")),
      seat("codex", finding("函数 Add 的加法被改成减法 a - b", "critical")),
    ];
    const body = shape(
      specBody,
      attempts,
      "docs/design/toy.md",
      "## 验收\n- AC-3：空串输入必须问候\n",
    );
    expect(firstH2(body)).toBe("## 结论");
    expect(body).toMatch(/## 结论\n+changes-requested/);
    expect(body).toContain("违反规格 · AC-3");
    expect(body).toContain("违反了规格里的 AC-3：空串输入必须问候");
    expect(body).not.toMatch(/^\s*不变量：/m);
    expect(body).not.toContain("规格合同减法");
    expect(body).not.toContain("合同内 Act On");
    expect(body).not.toContain("不变量 ID");
    expect(body).not.toContain("无规格依据，依据是");
    expect(body).toContain("[suggest-amend-spec]");
    const downgraded = [
      "## 共识发现",
      "- [major][suggest-amend-spec] 规格没写缓存",
      "## 结论",
      "comment",
    ].join("\n");
    const comment = shape(downgraded, attempts, "docs/design/toy.md");
    expect(comment).toMatch(/## 结论\n+comment/);
    expect(comment).not.toContain("无规格依据，依据是");
    expect(firstH2(comment)).toBe("## 结论");
  });

  it("drops the 待确认 sentence when that section is empty and states the scope once", () => {
    const attempts = [
      seat("kimi", finding("注释过期无人维护", "minor")),
      seat("cursor", finding("注释过期无人维护", "minor")),
      seat("codex", finding("注释过期无人维护", "minor")),
    ];
    const body = shapeAggregateDeliverable({
      markdown: BAD_COMMENT,
      task: {},
      attempts,
      scopeNote: "本次指定 3 席：kimi、cursor、codex",
    });
    expect(body).toContain("阻塞 0 个问题");
    expect(body).not.toContain("单席意见见");
    expect(body).not.toContain("无缺席");
    expect(body).not.toContain("缺席：");
    expect(body.split("本次指定").length - 1).toBe(1);
    expect(body).not.toContain("[suggest-amend-spec]");
    expect(body).not.toContain("[act-on]");
  });
});

describe("report structure", () => {
  it("puts 结论 first even when the aggregator wrote it last", () => {
    const md = renderReviewReport({
      runId: "ck-review-test",
      startedAt: "2026-10-17T00:00:00.000Z",
      endedAt: "2026-10-17T00:01:00.000Z",
      task: { pr: "https://github.com/acme/repo/pull/1", specSource: "docs/plans/x.md" },
      attempts: [seat("kimi", "## 发现\n- [nit] 命名")],
      aggregator: {
        attemptId: "aggregator",
        agentId: "agg",
        agentName: "Agg",
        driverId: "grok-stream-json",
        modelId: "m",
      },
      aggregation: seat("Agg", BAD_COMMENT),
      status: "completed",
      incomplete: false,
    } satisfies ReviewReportInput);
    const dash = md.indexOf("\n---\n");
    const after = md.slice(dash + 5);
    const stop = after.indexOf("\n## 过程对比");
    const main = stop >= 0 ? after.slice(0, stop) : after;
    expect(firstH2(main)).toBe("## 结论");
    expect(main.indexOf("## 结论")).toBeLessThan(main.indexOf("## 概览"));
    const titles = [...md.matchAll(/^## .+$/gm)].map((match) => match[0]);
    expect(titles.slice(0, 4)).toEqual(["## 结论", "## 阻塞问题", "## 需处理的问题", "## 待确认"]);
    expect(titles.at(-1)).toBe("## 附录:各审查者交付物");
  });

  it("strips spec-contract tags from a no-spec appendix and keeps them when a spec is bound", () => {
    const attempts = [
      seat("kimi", "## 发现\n- [major][act-on] 空串\n  [suggest-amend-spec]\n\n## 结论\ncomment\n"),
    ];
    const base = {
      runId: "ck-review-tags",
      startedAt: "2026-10-17T00:00:00.000Z",
      endedAt: "2026-10-17T00:01:00.000Z",
      attempts,
      aggregator: {
        attemptId: "aggregator",
        agentId: "agg",
        agentName: "Agg",
        driverId: "kimi-stream-json",
        modelId: "m",
      },
      aggregation: seat("Agg", "## 结论\ncomment\n"),
      status: "completed" as const,
      incomplete: false,
    };
    const unbound = renderReviewReport({ ...base, task: { task: "toy", requireSpec: false } });
    const appendix = unbound.slice(unbound.indexOf("## 附录"));
    expect(appendix).not.toContain("[act-on]");
    expect(appendix).not.toContain("[suggest-amend-spec]");
    const bound = renderReviewReport({
      ...base,
      task: { task: "toy", specSource: "docs/design/toy.md", specText: "AC-3 问候" },
    });
    expect(bound.slice(bound.indexOf("## 附录"))).toContain("[act-on]");
  });
});

describe("missing seats", () => {
  it("names an init-skipped seat and a runtime failure, and keeps a cfuse seat that ran", () => {
    const attempts = [
      {
        ...seat("review-security", "## 发现\n无\n\n## 结论\napprove\n"),
        driverId: "claude-stream-json",
      },
      seat("kimi", finding("Add 把 a + b 改成 a - b，减法替换加法")),
      {
        ...seat("review-cursor", "## 发现\n无\n\n## 结论\nchanges-requested\n", "failure"),
        driverId: "cursor-stream-json",
        failure: { code: "EXIT", message: "non-zero exit 1" },
      },
    ];
    const absences = collectReportAbsences(attempts, {
      skippedSeats: [
        {
          seat: "review-correctness",
          driver: "grok",
          reason: "missing",
          next: "Install grok, then run councilkit init.",
        },
      ],
      definedSeats: [
        { name: "review-security", tool: "cfuse" },
        { name: "kimi", tool: "kimi" },
        { name: "review-cursor", tool: "cursor-agent" },
      ],
    });
    expect(absences).toContainEqual({
      name: "review-correctness",
      tool: "grok",
      reason: "没有安装 grok",
    });
    expect(absences).toContainEqual({
      name: "review-cursor",
      tool: "cursor-agent",
      reason: "运行失败，退出码 1",
    });
    expect(absences.some((row) => row.name === "review-security")).toBe(false);
    expect(absences.some((row) => row.name === "kimi")).toBe(false);
    expect(collectReportAbsences([seat("kimi", "ok")])).toEqual([]);
    expect(
      failureAbsenceReason({ code: "EXIT", message: "please login", errorClass: "auth" }),
    ).toBe("未登录");
    expect(failureAbsenceReason({ code: "EXIT", message: "not logged in" })).toBe("未登录");
    expect(
      failureAbsenceReason({
        code: "EXIT",
        message: "non-zero exit 1\nerror: Cannot combine --prompt with --plan.",
      }),
    ).toBe("运行失败，退出码 1");
    expect(failureAbsenceReason({ code: "NOT_FOUND", message: "没有找到 cursor-agent" })).toBe(
      "没有找到 cursor-agent",
    );
    expect(
      failureAbsenceReason({
        code: "EXIT",
        message: 'executable "kimi" not found on PATH (review needs it installed)',
      }),
    ).toBe("没有找到 kimi");

    const md = renderReviewReport({
      runId: "ck-review-absent",
      startedAt: "2026-10-17T00:00:00.000Z",
      endedAt: "2026-10-17T00:02:00.000Z",
      task: { task: "toy go diff", requireSpec: false },
      attempts,
      aggregator: {
        attemptId: "aggregator",
        agentId: "agg",
        agentName: "Agg",
        driverId: "kimi-stream-json",
        modelId: "m",
      },
      aggregation: seat("Agg", BAD_COMMENT),
      status: "completed",
      incomplete: true,
      absences,
    });
    expect(md).toContain("- Status: partial");
    expect(md).not.toContain("- Status: failed");
    expect(md).toContain("failed:EXIT");
    const conclusion = md.slice(md.indexOf("## 结论"), md.indexOf("## 阻塞问题"));
    expect(conclusion).toContain("缺席：review-correctness（grok）：没有安装 grok。");
    expect(conclusion).toContain("缺席：review-cursor（cursor-agent）：运行失败，退出码 1。");
    expect(conclusion).toContain(
      "这份报告只汇总了其余 2 席的结果，缺席的这几席负责查的问题可能没被发现。",
    );
    expect(conclusion).not.toContain("review-security");
    expect(conclusion).not.toMatch(/未找到/);
    expect(conclusion).not.toMatch(/non-zero/i);
    const titles = [...md.matchAll(/^## .+$/gm)].map((match) => match[0]);
    expect(titles.slice(0, 4)).toEqual(["## 结论", "## 阻塞问题", "## 需处理的问题", "## 待确认"]);
    expect(titles.at(-1)).toBe("## 附录:各审查者交付物");
  });

  it("lists a defined seat whose reason was never recorded when skippedSeats is absent", () => {
    const attempts = [
      {
        ...seat("review-security", "## 发现\n无\n\n## 结论\napprove\n"),
        driverId: "claude-stream-json",
      },
    ];
    const absences = collectReportAbsences(attempts, {
      definedSeats: [
        { name: "review-security", tool: "cfuse" },
        { name: "review-maintainability", tool: "kimi" },
      ],
    });
    expect(absences).toEqual([
      {
        name: "review-maintainability",
        tool: "kimi",
        reason: "原因未记录，重新运行 `councilkit init` 可以看到原因",
      },
    ]);
    expect(formatAbsence(absences[0]!)).toBe(
      "缺席：review-maintainability（kimi）：原因未记录，重新运行 `councilkit init` 可以看到原因。",
    );
    expect(absences.some((row) => row.name === "review-security")).toBe(false);
  });

  it("uses the pr-jury template when an old config dropped a seat and has no skippedSeats", () => {
    const attempts = [
      "review-security",
      "review-maintainability",
      "review-adversarial",
      "review-cursor",
    ].map((name) => seat(name, "## 发现\n无\n\n## 结论\napprove\n"));
    const absences = collectReportAbsences(attempts, {
      councilName: "pr-jury",
      definedSeats: [
        { name: "review-security", tool: "cfuse" },
        { name: "review-maintainability", tool: "kimi" },
        { name: "review-adversarial", tool: "grok" },
        { name: "review-cursor", tool: "cursor-agent" },
      ],
    });
    expect(absences).toEqual([
      {
        name: "review-correctness",
        tool: "grok",
        reason: "原因未记录，重新运行 `councilkit init` 可以看到原因",
      },
    ]);
    expect(formatAbsence(absences[0]!)).toBe(
      "缺席：review-correctness（grok）：原因未记录，重新运行 `councilkit init` 可以看到原因。",
    );
  });

  it("does not invent template seats when skippedSeats is present", () => {
    const attempts = [seat("review-security", "## 发现\n无\n\n## 结论\napprove\n")];
    const absences = collectReportAbsences(attempts, {
      councilName: "pr-jury",
      skippedSeats: [],
      definedSeats: [{ name: "review-security", tool: "cfuse" }],
    });
    expect(absences).toEqual([]);
  });

  it("counts absences only among --agents seats", () => {
    const attempts = [
      seat("review-correctness", "## 发现\n无\n\n## 结论\napprove\n"),
      {
        ...seat("review-cursor", "", "failure"),
        driverId: "cursor-stream-json",
        failure: { code: "NOT_FOUND", message: "没有找到 cursor-agent" },
      },
    ];
    const absences = collectReportAbsences(attempts, {
      councilName: "pr-jury",
      explicitAgents: true,
      definedSeats: [
        { name: "review-correctness", tool: "grok" },
        { name: "review-cursor", tool: "cursor-agent" },
      ],
    });
    expect(absences).toEqual([
      {
        name: "review-cursor",
        tool: "cursor-agent",
        reason: "没有找到 cursor-agent",
      },
    ]);
    expect(formatRequestedSeats(["review-correctness", "review-cursor"])).toBe(
      "本次指定 2 席：review-correctness、review-cursor",
    );
  });
});

describe("recorded three-seat toy diff", () => {
  const recorded = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures/toy-go-three-seat.json"), "utf8"),
  ) as {
    badAggregate: string;
    seats: Array<{ name: string; output: string }>;
  };

  it("does not summarize three changes-requested seats as comment", () => {
    const attempts = recorded.seats.map((row) => seat(row.name, row.output));
    const before = recorded.badAggregate;
    expect(before).toMatch(/## 结论\n+comment/);
    expect(before).toContain("## 共识发现\n\n无");
    const body = shape(before, attempts);
    expect(firstH2(body)).toBe("## 结论");
    expect(body).toMatch(/## 结论\n+changes-requested/);
    expect(body).toContain("无规格依据，依据是 3/3 席一致：kimi、cursor、codex");
    expect(body).toContain("无规格依据，依据是 2/3 席一致：kimi、cursor");
    expect(body).toContain("[待确认 · codex]");
    expect(summarizeSeatOutput(body).blockingCount).toBe(2);
    expect(body).not.toMatch(/## 结论\n+comment/);

    const report = renderReviewReport({
      runId: "ck-review-toy",
      startedAt: "2026-10-17T00:00:00.000Z",
      endedAt: "2026-10-17T00:02:00.000Z",
      task: { task: "toy go diff", requireSpec: false },
      attempts,
      aggregator: {
        attemptId: "aggregator",
        agentId: "agg",
        agentName: "Agg",
        driverId: "kimi-stream-json",
        modelId: "m",
      },
      aggregation: seat("Agg", before),
      status: "completed",
      incomplete: false,
    });
    const dash = report.indexOf("\n---\n");
    const main = report.slice(dash + 5, report.indexOf("\n## 过程对比"));
    expect(firstH2(main)).toBe("## 结论");
    expect(main).toContain("changes-requested");
    expect(main).toContain("无规格依据，依据是 3/3 席一致：kimi、cursor、codex");

    const dir = mkdtempSync(join(tmpdir(), "ck-consensus-"));
    const file = persistFindingsFromReport({
      runDir: dir,
      runId: "ck-review-toy",
      markdown: report,
      attempts,
    });
    const blocking = file.findings.filter((row) => isFindingBlocking(row));
    expect(blocking.length).toBeGreaterThan(0);
    expect(file.findings.some((row) => row.title.includes("注释过期"))).toBe(false);
    expect(blocking.every((row) => row.contractClass !== "out_of_spec")).toBe(true);
  });
});
