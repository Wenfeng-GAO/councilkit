/**
 * Three completed reviews for the locked label screenshots.
 * Seeded only when CK_E2E_TAG_CASES=1 so the default reports-list counts stay put.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SPEC_TAG_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000377";
export const CONSENSUS_TAG_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000378";
export const PENDING_TAG_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000379";
export const ABSENT_TAG_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000380";
export const SKIPPED_TAG_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000381";
export const UNRECORDED_TAG_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000382";
export const LEGACY_TAG_RUN_ID = "ck-review-00000000-0000-4000-8000-000000000383";

export const SPEC_TAG_TITLE = "规格违反 AC-3";
export const CONSENSUS_TAG_TITLE = "多席一致加法";
export const PENDING_TAG_TITLE = "待确认单席";
export const ABSENT_TAG_TITLE = "缺席席位";
export const SKIPPED_TAG_TITLE = "未安装跳过席";
export const UNRECORDED_TAG_TITLE = "原因未记录席";
export const LEGACY_TAG_TITLE = "旧配置缺席";

const BASIS = "无规格依据，依据是 2/3 席一致：kimi、cursor";

function writeRun(
  home: string,
  runId: string,
  title: string,
  markdown: string,
  findings: unknown[] | null,
): void {
  const dir = join(home, "runs", runId);
  mkdirSync(dir, { recursive: true });
  const started = {
    kind: "review.started",
    version: 1,
    runId,
    startedAt: "2026-10-17T07:40:00.000Z",
    task: { task: title },
    attempts: [],
  };
  const finished = {
    kind: "review.finished",
    version: 1,
    status: "completed",
    endedAt: "2026-10-17T07:48:00.000Z",
    incomplete: false,
    failure: null,
  };
  writeFileSync(
    join(dir, "transcript.jsonl"),
    `${JSON.stringify(started)}\n${JSON.stringify(finished)}\n`,
  );
  writeFileSync(join(dir, "report.md"), markdown);
  if (findings) {
    writeFileSync(
      join(dir, "findings.json"),
      `${JSON.stringify({
        version: 1,
        runId,
        extractedAt: "2026-10-17T07:48:00.000Z",
        sha: null,
        againstRunId: null,
        againstRange: null,
        findings,
      })}\n`,
    );
  }
}

function report(body: string): string {
  return `# Autonomous Review Report\n\n- Status: completed\n\n---\n\n${body}`;
}

export function seedConsensusTagFixtures(home: string): void {
  writeRun(
    home,
    SPEC_TAG_RUN_ID,
    SPEC_TAG_TITLE,
    report(
      [
        "## 结论",
        "",
        "changes-requested",
        "",
        "空串分支被删。违反了规格里的 AC-3：空串输入必须问候。",
        "",
        "阻塞 1 个问题",
        "",
        "## 阻塞问题",
        "",
        "- [major][act-on] 空串分支被删除",
        "  违反了规格里的 AC-3：空串输入必须问候",
        "  违反规格 · AC-3",
        '  反例：Greet("") 不再问候',
        "",
      ].join("\n"),
    ),
    [
      {
        id: "f-ac-3",
        severity: "major",
        status: "open",
        title: "空串分支被删除",
        text: '空串分支被删除\n违反了规格里的 AC-3：空串输入必须问候\n违反规格 · AC-3\n反例：Greet("") 不再问候',
        source: "consensus",
        reviewer: "kimi",
        files: ["toy.go"],
        contractClass: "in_contract",
        invariantId: "AC-3",
        counterexample: 'Greet("") 不再问候',
      },
    ],
  );
  writeRun(
    home,
    CONSENSUS_TAG_RUN_ID,
    CONSENSUS_TAG_TITLE,
    report(
      [
        "## 结论",
        "",
        "changes-requested",
        "",
        BASIS,
        "",
        "阻塞 1 个问题",
        "",
        "## 共识发现",
        "",
        "- [major][多席一致 2/3] Add 把加法改成减法",
        `  ${BASIS}`,
        "",
      ].join("\n"),
    ),
    [
      {
        id: "f-add",
        severity: "major",
        status: "open",
        title: "Add 把加法改成减法",
        text: `Add 把加法改成减法\n${BASIS}`,
        source: "consensus",
        reviewer: null,
        files: ["toy.go"],
      },
    ],
  );
  writeRun(
    home,
    PENDING_TAG_RUN_ID,
    PENDING_TAG_TITLE,
    report(
      [
        "## 结论",
        "",
        "comment",
        "",
        "无规格依据。没有多数席位一致的高严重度缺陷。单席意见见「待确认」。",
        "",
        "阻塞 0 个问题",
        "",
        "## 待确认",
        "",
        "- [major][待确认 · kimi] Add 把加法改成减法",
        "  位置：`toy.go`",
        "",
      ].join("\n"),
    ),
    null,
  );
  writeRun(
    home,
    ABSENT_TAG_RUN_ID,
    ABSENT_TAG_TITLE,
    report(
      [
        "## 结论",
        "",
        "comment",
        "",
        "缺席：review-cursor（cursor-agent）：运行失败，退出码 1。",
        "这份报告只汇总了其余 2 席的结果，缺席的这几席负责查的问题可能没被发现。",
        "",
        "阻塞 0 个问题",
        "",
      ].join("\n"),
    ),
    null,
  );
  writeRun(
    home,
    SKIPPED_TAG_RUN_ID,
    SKIPPED_TAG_TITLE,
    report(
      [
        "## 结论",
        "",
        "comment",
        "",
        "缺席：review-correctness（grok）：没有安装 grok。",
        "这份报告只汇总了其余 3 席的结果，缺席的这几席负责查的问题可能没被发现。",
        "",
        "阻塞 0 个问题",
        "",
      ].join("\n"),
    ),
    null,
  );
  writeRun(
    home,
    UNRECORDED_TAG_RUN_ID,
    UNRECORDED_TAG_TITLE,
    report(
      [
        "## 结论",
        "",
        "comment",
        "",
        "缺席：review-maintainability（kimi）：原因未记录，重新运行 `councilkit init` 可以看到原因。",
        "这份报告只汇总了其余 2 席的结果，缺席的这几席负责查的问题可能没被发现。",
        "",
        "阻塞 0 个问题",
        "",
      ].join("\n"),
    ),
    null,
  );
  writeRun(
    home,
    LEGACY_TAG_RUN_ID,
    LEGACY_TAG_TITLE,
    report(
      [
        "## 结论",
        "",
        "comment",
        "",
        "缺席：review-correctness（grok）：原因未记录，重新运行 `councilkit init` 可以看到原因。",
        "这份报告只汇总了其余 4 席的结果，缺席的这几席负责查的问题可能没被发现。",
        "",
        "阻塞 0 个问题",
        "",
      ].join("\n"),
    ),
    null,
  );
}
