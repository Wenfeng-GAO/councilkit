import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  againstDiffRange,
  classifyAgainstPrior,
  extractFindingsFromReport,
  markFindingsClosed,
  parsePlanDocument,
  persistFindingsFromReport,
  resolveClusterCloses,
} from "../src/auto/ledger";
import type { LedgerFinding } from "../src/auto/ledger";

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
    ).toBe(
      "63d2f1a2d8ac73ca3e26176910a12d169a527a52...40bae4580ee5f2de7c2157b79780ab30ac2d5dbd",
    );
    expect(
      againstDiffRange({
        findingsSha: "abc",
        currentSha: "abc",
        fallback: "abc...def",
      }),
    ).toBe("abc...def");
    expect(
      againstDiffRange({ findingsSha: null, currentSha: "abc", fallback: "x...y" }),
    ).toBe("x...y");
  });
});

describe("ledger classify", () => {
  it("marks missing prior open findings closed and rediscovered closed as regress", () => {
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
    expect(classified.find((row) => row.id === "a--one")?.status).toBe("closed");
    expect(classified.find((row) => row.id === "b--two")?.status).toBe("regress");
    expect(classified.find((row) => row.id === "c--ok")?.status).toBe("accepted");
    expect(classified.find((row) => row.id === "d--new")?.status).toBe("open");
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
      ["critical:open", "major:regress", "minor:open"],
    );
  });

  it("marks claimed closes on apply", () => {
    const file = extractFindingsFromReport({
      markdown: SAMPLE,
      runId: "ck-review-34e2b26f-46c4-42c4-9336-b6e1ff6e7e8c",
      extractedAt: "2026-08-20T00:00:00.000Z",
    });
    const id = file.findings.find((row) => row.severity === "major")?.id ?? "";
    const marked = markFindingsClosed(file, [id]);
    expect(marked.findings.find((row) => row.id === id)?.status).toBe("closed");
    expect(marked.findings.filter((row) => row.status === "open")).toHaveLength(2);
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
});
