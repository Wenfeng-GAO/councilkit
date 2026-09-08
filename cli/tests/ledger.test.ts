import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFindingBlocking, isFindingVerifiedClosed } from "@shared/runtime/cli-ledger";
import { afterEach, describe, expect, it } from "vitest";
import { buildFindingGroups, hashFindingsBytes } from "../src/auto/finding-groups";
import {
  againstDiffRange,
  applyReviewerVerifications,
  classifyAgainstPrior,
  classifyAgainstPriorWithAliases,
  extractFindingsFromReport,
  formatLedgerForPrompt,
  markFindingsRepairClaimed,
  parsePlanDocument,
  persistFindingsFromReport,
  resolveClusterCloses,
} from "../src/auto/ledger";
import type { LedgerFinding } from "../src/auto/ledger";
import type { AttemptResult } from "../src/auto/runner";

const SAMPLE = `# Autonomous Review Report

- Run: ck-review-34e2b26f-46c4-42c4-9336-b6e1ff6e7e8c
- Task: review PR https://code.alipay.com/paas-core/agentrun/pull_requests/126

---

## 概览

四位成功审查者均给出 \`changes-requested\`。

## 共识发现

- [major][必现] pkg/eventlog/log.go: 非文本内容被错误转换为 live-only preview。
- [minor] Java SDK 将 seq 改为可空 Long。

## 独有发现

### review-security

- [critical] internal/foo.go: WaitGroup 在错误路径泄漏。

## 分歧

- **Verdict**：review-security 给 approve

## 结论

changes-requested
`;

const PLAN = `# 修复方案

## 不变量
1. JSONL 失败不得留下半行

## 落地顺序

### 集群 1: eventlog-short-write
- id: eventlog-short-write
- closes: pkg.eventlog.log.go--非文本内容被错误转换为-live-only-preview
- files: pkg/eventlog/log.go
- gates: go test ./pkg/eventlog -run TestShortWrite
- 不变量: JSONL 失败不得留下半行
- 对应发现: 非文本内容被错误转换为 live-only preview
- 方针: 删除
- 禁止: 对 Append 加重试循环
- 测试: 真文件短写

### 集群 2: waitgroup-leak
- 对应发现: WaitGroup 在错误路径泄漏
- files: internal/foo.go
- 方针: fail-closed

## 本轮不落地
- lastSeq > head: 产品合同

## 合并门槛
- 阻塞不变量有测试
`;

function finding(
  partial: Partial<LedgerFinding> & Pick<LedgerFinding, "id" | "title">,
): LedgerFinding {
  return {
    severity: "major",
    status: "open",
    text: partial.title,
    source: "consensus",
    reviewer: null,
    files: [],
    ...partial,
  };
}

describe("ledger extract", () => {
  it("pulls consensus and unique findings with stable ids", () => {
    const file = extractFindingsFromReport({
      markdown: SAMPLE,
      runId: "ck-review-34e2b26f-46c4-42c4-9336-b6e1ff6e7e8c",
      extractedAt: "2026-08-20T00:00:00.000Z",
      sha: "abc1234",
    });
    expect(file.findings.map((row) => row.severity)).toEqual(["critical", "major", "minor"]);
    const consensusMajor = file.findings.find((row) => row.source === "consensus");
    expect(consensusMajor?.files).toContain("pkg/eventlog/log.go");
    expect(consensusMajor?.id).toContain("pkg.eventlog.log.go--");
    expect(file.findings[0]?.source).toBe("unique");
    expect(file.findings[0]?.reviewer).toBe("review-security");
    expect(file.findings.some((row) => row.title.includes("Verdict"))).toBe(false);
  });
});

describe("againstDiffRange", () => {
  it("spans prior review SHA to current HEAD and falls back otherwise", () => {
    expect(
      againstDiffRange({
        findingsSha: "63d2f1a2d8ac73ca3e26176910a12d169a527a52",
        currentSha: "40bae4580ee5f2de7c2157b79780ab30ac2d5dbd",
        fallback: "63d2f1a...c4722e7",
      }),
    ).toBe("63d2f1a2d8ac73ca3e26176910a12d169a527a52...40bae4580ee5f2de7c2157b79780ab30ac2d5dbd");
    expect(
      againstDiffRange({
        findingsSha: "abc",
        currentSha: "abc",
        fallback: "abc...def",
      }),
    ).toBe("abc...def");
    expect(againstDiffRange({ findingsSha: null, currentSha: "abc", fallback: "x...y" })).toBe(
      "x...y",
    );
  });
});

describe("ledger classify", () => {
  it("preserves missing coverage and treats rediscovered historical closes as open", () => {
    const prior = [
      finding({ id: "a--one", title: "one", status: "open" }),
      finding({ id: "b--two", title: "two", status: "closed" }),
      finding({ id: "c--ok", title: "ok", status: "accepted" }),
    ];
    const next = [
      finding({ id: "b--two", title: "two again", status: "open" }),
      finding({ id: "d--new", title: "brand new", status: "open" }),
    ];
    const classified = classifyAgainstPrior(prior, next);
    expect(classified.find((row) => row.id === "a--one")?.status).toBe("open");
    expect(classified.find((row) => row.id === "b--two")?.status).toBe("open");
    expect(classified.find((row) => row.id === "c--ok")?.status).toBe("accepted");
    expect(classified.find((row) => row.id === "d--new")?.status).toBe("open");
  });

  it("records against-chain aliases without letting a shared root close either original ID", () => {
    const prior = [
      finding({ id: "F-ORIG", title: "cancel dispatch", status: "open", severity: "major" }),
    ];
    const next = [
      finding({
        id: "misc--cancel-again",
        title: "wording changed",
        text: "`F-ORIG` still fires after cancel",
        status: "open",
        severity: "major",
      }),
    ];
    const classified = classifyAgainstPriorWithAliases(prior, next);
    expect(classified.findings[0]?.id).toBe("F-ORIG");
    expect(classified.aliases).toEqual([
      expect.objectContaining({ originalId: "F-ORIG", aliasId: "misc--cancel-again" }),
    ]);
    expect(classified.findings[0]?.status).toBe("open");
  });

  it("sorts classified findings by severity then status", () => {
    const prior = [
      finding({ id: "a--minor", title: "small", severity: "minor", status: "open" }),
      finding({ id: "b--major", title: "big", severity: "major", status: "closed" }),
    ];
    const next = [
      finding({ id: "a--minor", title: "small again", severity: "minor" }),
      finding({ id: "b--major", title: "big again", severity: "major" }),
      finding({ id: "c--crit", title: "new leak", severity: "critical" }),
    ];
    expect(classifyAgainstPrior(prior, next).map((row) => `${row.severity}:${row.status}`)).toEqual(
      ["critical:open", "major:open", "minor:open"],
    );
  });

  it("records apply claims without resolving the finding", () => {
    const file = extractFindingsFromReport({
      markdown: SAMPLE,
      runId: "ck-review-34e2b26f-46c4-42c4-9336-b6e1ff6e7e8c",
      extractedAt: "2026-08-20T00:00:00.000Z",
    });
    const id = file.findings.find((row) => row.severity === "major")?.id ?? "";
    const marked = markFindingsRepairClaimed(file, [id], {
      candidateSha: "a".repeat(40),
      runId: file.runId,
      at: file.extractedAt,
    });
    const row = marked.findings.find((row) => row.id === id);
    if (!row) throw new Error("Expected claimed finding");
    expect(row.status).toBe("open");
    expect(row.repairClaim?.candidateSha).toBe("a".repeat(40));
    expect(isFindingBlocking(row)).toBe(true);
    expect(marked.findings.filter((row) => row.status === "open")).toHaveLength(3);
  });

  it.each(["misc--completed-eventlog", "F-1"])(
    "reuses explicit ID %s without prefix growth or closure inference",
    (id) => {
      const prior = finding({
        id,
        title: "completed snapshot lost",
        severity: "critical",
      });
      const next = finding({
        id: "misc--misc-completed-eventlog",
        title: "Changed phrasing entirely",
        text: `\`${id}\` 仍成立，磁盘故障仍丢失正文`,
        severity: "critical",
      });
      const rows = classifyAgainstPrior([prior], [next]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(prior.id);
      expect(rows[0]?.status).toBe("open");
    },
  );
});

const CANDIDATE_SHA = "a".repeat(40);
const assessment = (overrides: Record<string, unknown> = {}) => ({
  findingId: "persist--lost",
  candidateSha: CANDIDATE_SHA,
  outcome: "verified_closed",
  method: "regression_test",
  command: "go test ./eventlog -run TestShortWrite",
  reason: "短写反例现在返回错误且保留正文",
  evidence: "TestShortWrite PASS; injected ENOSPC retains pending text",
  ...overrides,
});
function reviewer(rows: unknown[], overrides: Partial<AttemptResult> = {}): AttemptResult {
  return {
    attemptId: "attempt-0",
    agentId: "reviewer",
    agentName: "independent reviewer",
    driverId: "grok-stream-json",
    modelId: "configured",
    status: "success",
    exitCode: 0,
    output: `\`\`\`councilkit-findings\n${JSON.stringify(rows)}\n\`\`\``,
    durationMs: 10,
    workspace: "/isolated/reviewer",
    ...overrides,
  };
}
function verify(rows: unknown[], overrides: Record<string, unknown> = {}) {
  const row = applyReviewerVerifications(
    [finding({ id: "persist--lost", title: "Short write loses text" })],
    {
      sha: CANDIDATE_SHA,
      runId: "ck-review-current",
      complete: true,
      attempts: [reviewer(rows)],
      reportedFindings: [],
      verifiedAttemptShas: { "attempt-0": CANDIDATE_SHA },
      ...overrides,
    },
  )[0];
  if (!row) throw new Error("Expected verified finding");
  return row;
}

describe("independent finding verification", () => {
  it("closes only an exact-ID, exact-SHA finding with independent complete evidence", () => {
    const row = verify([assessment()]);
    expect(isFindingVerifiedClosed(row, CANDIDATE_SHA)).toBe(true);
    expect(row.verification?.attemptId).toBe("attempt-0");
    expect(isFindingBlocking(row, "b".repeat(40))).toBe(true);
  });
  it("applying a previously verified finding invalidates the old proof even on its source review", () => {
    const resolved = verify([assessment()]);
    const file = {
      version: 1 as const,
      runId: "review",
      extractedAt: "now",
      sha: CANDIDATE_SHA,
      againstRunId: null,
      againstRange: null,
      findings: [resolved],
    };
    const next = markFindingsRepairClaimed(file, [resolved.id], {
      candidateSha: "b".repeat(40),
      runId: "apply",
      at: "later",
    }).findings[0];
    if (!next) throw new Error("Expected reapplied finding");
    expect(formatLedgerForPrompt({ ...file, sha: "b".repeat(40) }, null)).toContain(
      "待验证当前提交",
    );
    expect(formatLedgerForPrompt({ ...file, sha: null }, null)).toContain("待验证当前提交");
    expect(next.verification).toBeUndefined();
    expect(isFindingBlocking(next, file.sha)).toBe(true);
    expect(isFindingVerifiedClosed(next, CANDIDATE_SHA)).toBe(false);
  });
  it.each([
    { complete: false },
    { sha: null },
    { sha: "abc123" },
    { verifiedAttemptShas: {} },
    { attempts: [reviewer([assessment()], { status: "failure" })] },
    { attempts: [reviewer([assessment()], { attemptId: "aggregator" })] },
  ])("does not close on incomplete, unbound, failed or aggregator evidence: %j", (overrides) => {
    expect(isFindingBlocking(verify([assessment()], overrides), CANDIDATE_SHA)).toBe(true);
  });
  it.each([
    { candidateSha: "b".repeat(40) },
    { findingId: "misc--persist--lost" },
    { method: "not_evaluated" },
    { command: "" },
    { reason: "" },
    { method: "code_trace", command: undefined },
  ])("rejects mismatched or unqualified close: %j", (overrides) => {
    expect(isFindingBlocking(verify([assessment(overrides)]), CANDIDATE_SHA)).toBe(true);
  });
  it("does not close on verifiedAt extras or locations ranges", () => {
    expect(
      isFindingBlocking(verify([assessment({ verifiedAt: "2026-09-07T00:00:00.000Z" })])),
    ).toBe(true);
    expect(
      isFindingBlocking(
        verify([
          assessment({
            method: "code_trace",
            command: undefined,
            locations: ["pkg/eventlog/log.go:1-20"],
          }),
        ]),
      ),
    ).toBe(true);
  });
  it("accepts an explicit source trace and records not_evaluated without closing", () => {
    expect(
      isFindingVerifiedClosed(
        verify([
          assessment({
            method: "code_trace",
            command: undefined,
            locations: ["pkg/eventlog/log.go:42"],
          }),
        ]),
      ),
    ).toBe(true);
    const row = verify([assessment({ outcome: "not_evaluated", method: "not_evaluated" })]);
    expect(row.verification?.outcome).toBe("not_evaluated");
    expect(isFindingBlocking(row)).toBe(true);
  });
  it("a still-open minority or current finding defeats closure", () => {
    const contradicted = verify([assessment()], {
      attempts: [
        reviewer([assessment()]),
        reviewer([assessment({ outcome: "still_open" })], { attemptId: "attempt-1" }),
      ],
    });
    expect(contradicted.verification?.outcome).toBe("still_open");
    expect(isFindingBlocking(contradicted)).toBe(true);
    expect(
      isFindingBlocking(
        verify([assessment()], {
          reportedFindings: [
            finding({
              id: "persist--lost",
              title: "still loses text",
              source: "unique",
            }),
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("plan.lock parse", () => {
  it("reads cluster machine fields and deferred items", () => {
    const lock = parsePlanDocument(PLAN, {
      sourceRunId: "ck-review-34e2b26f-46c4-42c4-9336-b6e1ff6e7e8c",
      approvedAt: "2026-08-20T00:00:00.000Z",
      verdict: "approve",
    });
    expect(lock.clusters.map((cluster) => cluster.id)).toEqual([
      "eventlog-short-write",
      "waitgroup-leak",
    ]);
    expect(lock.clusters[0]?.files).toContain("pkg/eventlog/log.go");
    expect(lock.clusters[0]?.gates[0]).toContain("TestShortWrite");
    expect(lock.deferred[0]?.title).toContain("lastSeq");
    const extracted = extractFindingsFromReport({
      markdown: SAMPLE,
      runId: lock.sourceRunId,
      extractedAt: lock.approvedAt,
    });
    const closes = resolveClusterCloses(
      lock.clusters[1] as (typeof lock.clusters)[number],
      extracted.findings,
    );
    expect(closes.length).toBeGreaterThan(0);
  });
});

describe("ledger persist", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("writes findings.json from a report", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-ledger-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const file = persistFindingsFromReport({
      runDir: dir,
      runId: "ck-review-34e2b26f-46c4-42c4-9336-b6e1ff6e7e8c",
      markdown: SAMPLE,
      sha: "deadbeef",
    });
    const disk = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as typeof file;
    expect(disk.findings).toHaveLength(file.findings.length);
    expect(disk.sha).toBe("deadbeef");
  });

  it("a failed incremental review with no SHA or findings preserves every old blocker", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-ledger-failed-"));
    dirs.push(dir);
    const prior = extractFindingsFromReport({
      markdown: SAMPLE,
      runId: "prior",
      extractedAt: "now",
    });
    const file = persistFindingsFromReport({
      runDir: dir,
      runId: "failed",
      sha: null,
      markdown: "# Autonomous Review Report\n\n- Status: failed\n\n---\n\nINCOMPLETE",
      againstRunId: prior.runId,
      prior,
      attempts: [],
      reviewComplete: false,
    });
    expect(file.findings).toEqual(prior.findings);
    expect(file.findings.filter((row) => isFindingBlocking(row))).toHaveLength(2);
  });

  it("keeps serious independent findings omitted by an approving aggregator", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-ledger-minority-"));
    dirs.push(dir);
    const file = persistFindingsFromReport({
      runDir: dir,
      runId: "minority",
      sha: CANDIDATE_SHA,
      markdown: "# Autonomous Review Report\n\n---\n\n## 结论\napprove",
      attempts: [
        reviewer([], {
          output:
            "## Findings\n- [critical] pkg/log.go:42 — short write loses text\n\n## Verdict\nchanges-requested",
        }),
      ],
      reviewComplete: true,
    });
    expect(file.findings).toHaveLength(1);
    expect(file.findings[0]?.source).toBe("unique");
    expect(file.findings[0]?.reviewer).toBe("independent reviewer");
    const row = file.findings[0];
    if (!row) throw new Error("Expected independent finding");
    expect(isFindingBlocking(row)).toBe(true);
  });

  it("keeps the strongest independent severity and evidence when aggregation downgrades the same ID", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-ledger-downgrade-"));
    dirs.push(dir);
    const file = persistFindingsFromReport({
      runDir: dir,
      runId: "downgrade",
      sha: CANDIDATE_SHA,
      markdown:
        "# Autonomous Review Report\n\n---\n\n## 共识发现\n- [minor] pkg/log.go:42 — short write loses text\n\n## 结论\napprove",
      attempts: [
        reviewer([], {
          output:
            "## Findings\n- [critical] pkg/log.go:42 — short write loses text\n  Injected ENOSPC destroys the only copy.\n\n## Verdict\nchanges-requested",
        }),
      ],
      reviewComplete: true,
    });
    expect(file.findings).toHaveLength(1);
    const row = file.findings[0];
    if (!row) throw new Error("Expected independent finding");
    expect(row.severity).toBe("critical");
    expect(row.source).toBe("unique");
    expect(row.reviewer).toBe("independent reviewer");
    expect(row.text).toContain("ENOSPC destroys the only copy");
    expect(isFindingBlocking(row, CANDIDATE_SHA)).toBe(true);
  });

  it("uses extraAssessments for both close projection and coverage diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-ledger-extra-"));
    dirs.push(dir);
    const original = {
      findingId: "F-1",
      candidateSha: CANDIDATE_SHA,
      outcome: "still_open",
      method: "code_trace",
      reason: "still reproduces",
      evidence: "same call path",
      locations: ["src/a.ts:1"],
      verifiedAt: "x",
    };
    const extra = {
      assessment: {
        findingId: "F-1",
        candidateSha: CANDIDATE_SHA,
        outcome: "still_open" as const,
        method: "code_trace" as const,
        reason: "still reproduces",
        evidence: "same call path",
        locations: ["src/a.ts:1"],
      },
      attemptId: "attempt-0",
      reviewer: "independent reviewer",
    };
    persistFindingsFromReport({
      runDir: dir,
      runId: "ck-review-current",
      sha: CANDIDATE_SHA,
      markdown: "# Autonomous Review Report\n\n---\n\n## 结论\ncomment",
      againstRunId: "prior",
      prior: {
        version: 1,
        runId: "prior",
        extractedAt: "t",
        sha: CANDIDATE_SHA,
        againstRunId: null,
        againstRange: null,
        findings: [finding({ id: "F-1", title: "open hole" })],
      },
      attempts: [reviewer([original])],
      extraAssessments: [extra],
      reviewComplete: true,
    });
    const diagnostics = JSON.parse(
      readFileSync(join(dir, "assessment-diagnostics.v1.json"), "utf8"),
    ) as { coverageComplete: boolean };
    expect(diagnostics.coverageComplete).toBe(true);
  });

  it("inherits a stable against finding-groups root without new aliases", () => {
    const inherited = buildFindingGroups({
      runId: "ck-review-current",
      sha: CANDIDATE_SHA,
      findings: [finding({ id: "F-1", title: "one" }), finding({ id: "F-2", title: "two" })],
      againstRunId: "prior",
      findingsSha256: "b".repeat(64),
      matches: [],
      priorGroups: {
        version: 1,
        kind: "councilkit-finding-groups",
        source: {
          runId: "prior",
          sha: CANDIDATE_SHA,
          findingsSha256: "b".repeat(64),
          againstRunId: null,
        },
        groups: [
          {
            rootCauseId: "RC-STABLE",
            findingIds: ["F-1", "F-2"],
            aliases: [],
            basis: "same hole",
          },
        ],
      },
    });
    expect(inherited.groups.map((row) => row.rootCauseId)).toEqual(["RC-STABLE"]);

    const root = mkdtempSync(join(tmpdir(), "ck-ledger-groups-"));
    dirs.push(root);
    const priorId = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
    const currentId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";
    const priorDir = join(root, priorId);
    const currentDir = join(root, currentId);
    mkdirSync(priorDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    const priorFindings = {
      version: 1 as const,
      runId: priorId,
      extractedAt: "t",
      sha: CANDIDATE_SHA,
      againstRunId: null,
      againstRange: null,
      findings: [finding({ id: "F-1", title: "one" }), finding({ id: "F-2", title: "two" })],
    };
    writeFileSync(join(priorDir, "findings.json"), `${JSON.stringify(priorFindings, null, 2)}\n`);
    const priorBytes = `${JSON.stringify(priorFindings, null, 2)}\n`;
    writeFileSync(
      join(priorDir, "finding-groups.v1.json"),
      JSON.stringify({
        version: 1,
        kind: "councilkit-finding-groups",
        source: {
          runId: priorId,
          sha: CANDIDATE_SHA,
          findingsSha256: hashFindingsBytes(priorBytes),
          againstRunId: null,
        },
        groups: [
          {
            rootCauseId: "RC-STABLE",
            findingIds: ["F-1", "F-2"],
            aliases: [],
            basis: "same hole",
          },
        ],
      }),
    );
    persistFindingsFromReport({
      runDir: currentDir,
      runId: currentId,
      sha: CANDIDATE_SHA,
      markdown:
        "# Autonomous Review Report\n\n---\n\n## 共识发现\n- [major] one\n- [major] two\n\n## 结论\ncomment",
      againstRunId: priorId,
      prior: priorFindings,
      attempts: [],
      reviewComplete: true,
    });
    const groups = JSON.parse(readFileSync(join(currentDir, "finding-groups.v1.json"), "utf8")) as {
      groups: Array<{ rootCauseId: string }>;
    };
    expect(groups.groups.map((row) => row.rootCauseId)).toContain("RC-STABLE");
  });
});
