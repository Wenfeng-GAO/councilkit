import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FINDING_TITLE_DISPLAY_LIMIT,
  againstLedgerFromDetail,
  compareFindingLedgers,
  defaultFindingListFilter,
  displayStatusLabel,
  filterFindingProblems,
  formatFindingCountNote,
  isProvenDuplicate,
  projectFindingList,
  readableFindingTitle,
  reviewCoverageLabel,
  reviewRelationLabel,
} from "@/lib/finding-list";
import { parseFindingsFile } from "@shared/runtime/cli-ledger";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import { FINDING_GROUPS_KIND, type FindingGroupsFile } from "@shared/runtime/finding-groups";
import { describe, expect, it } from "vitest";

const SHA = "9".repeat(40);
const OTHER_SHA = "a".repeat(40);

function finding(
  partial: Partial<LedgerFinding> & Pick<LedgerFinding, "id" | "title" | "severity">,
): LedgerFinding {
  return {
    status: "open",
    text: partial.title,
    source: "unique",
    reviewer: null,
    files: [],
    ...partial,
  };
}

function verification(
  outcome: "verified_closed" | "still_open" | "not_evaluated",
  sha = SHA,
): NonNullable<LedgerFinding["verification"]> {
  return {
    outcome,
    candidateSha: sha,
    runId: "review-prior",
    attemptId: "attempt-0",
    reviewer: "review-correctness",
    method: outcome === "not_evaluated" ? "not_evaluated" : "code_trace",
    reason: "trace",
    evidence: "code path",
    locations: ["recovery.go:10"],
    runComplete: true,
  };
}

describe("conservative display grouping", () => {
  it("merges the same cited line when paths are suffix-compatible and identity matches", () => {
    const a = finding({
      id: "recovery.go--357-uuid-close",
      severity: "major",
      title:
        "`recovery.go:357` — Resume 成功、提交 idle 遇到临时存储错误时 `closeOpenedOn` + `markRecoveryFailed`（UUID 仍在）。最小改动：该分支改 `forgetOpenedOn`。",
      files: ["recovery.go"],
      reviewer: "review-correctness",
    });
    const b = finding({
      id: "pkg.runtime.recovery.go--357-uuid",
      severity: "major",
      title:
        "pkg/runtime/recovery.go:357 — 原 UUID Resume 成功、提交 idle 遇到临时存储错误时，必现向原会话发送 Close，却保留该 UUID 为 error → 改用 `forgetOpenedOn`。",
      files: ["pkg/runtime/recovery.go"],
      reviewer: "review-correctness",
    });
    const fence = finding({
      id: "recovery.go--311-362-fence",
      severity: "major",
      title:
        "`recovery.go:311-362` — fence 在 `UpdateSession` 回调内；commit idle 后不再复核 occupancy。",
      files: ["recovery.go"],
      reviewer: "review-adversarial",
    });
    const ctx = finding({
      id: "recovery.go--266-271-ctx",
      severity: "major",
      title: "`recovery.go:266-271` — Resume 失败只看 `ctx.Err()`，不看 `flightCurrent`。",
      files: ["recovery.go"],
      reviewer: "review-adversarial",
    });
    expect(isProvenDuplicate(a, b)).toBe(true);
    expect(isProvenDuplicate(a, fence)).toBe(false);
    expect(isProvenDuplicate(b, fence)).toBe(false);
    const projection = projectFindingList([a, b, fence, ctx], { sha: SHA });
    expect(projection.originalCount).toBe(4);
    expect(projection.displayCount).toBe(3);
    expect(projection.blockingCount).toBe(3);
    const uuid = projection.problems.find((row) => row.members.length === 2);
    expect(uuid?.members.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
    expect(uuid?.location).toContain("357");
  });

  it("keeps same-basename files in different directories independent", () => {
    const left = finding({
      id: "a-util",
      severity: "minor",
      title: "pkg/a/util.go:10 — `encodeFrame` 丢弃校验和。",
      files: ["pkg/a/util.go"],
    });
    const right = finding({
      id: "b-util",
      severity: "minor",
      title: "pkg/b/util.go:10 — `encodeFrame` 丢弃校验和。",
      files: ["pkg/b/util.go"],
    });
    expect(isProvenDuplicate(left, right)).toBe(false);
    expect(projectFindingList([left, right]).displayCount).toBe(2);
  });

  it("does not merge the same location when root causes differ", () => {
    const close = finding({
      id: "close",
      severity: "major",
      title: "recovery.go:40 — 提交失败仍 `closeOpenedOn`，UUID 留在 error。",
      files: ["recovery.go"],
    });
    const fence = finding({
      id: "fence",
      severity: "major",
      title: "recovery.go:40 — generation `fence` 不复核 occupancy，`finishRecovery` 未调用。",
      files: ["recovery.go"],
    });
    expect(isProvenDuplicate(close, fence)).toBe(false);
    expect(projectFindingList([close, fence]).displayCount).toBe(2);
  });

  it("does not chain weak similarity across an intermediate finding", () => {
    const first = finding({
      id: "one",
      severity: "minor",
      title: "alpha.go:3 — `tokenAlpha` 泄漏到日志。",
      files: ["alpha.go"],
    });
    const mixed = finding({
      id: "two",
      severity: "minor",
      title: "beta.go:8 — `tokenBeta` 与别处无关。",
      files: ["beta.go"],
    });
    const third = finding({
      id: "three",
      severity: "minor",
      title: "gamma.go:9 — `tokenGamma` 未校验长度。",
      files: ["gamma.go"],
    });
    expect(projectFindingList([first, mixed, third]).displayCount).toBe(3);
  });

  it("merges sidecar records that share the same rootCauseId", () => {
    const mutex = finding({
      id: "a",
      severity: "major",
      title: "cache.ts:42 — resolveCache 调用 readEntry 时丢失互斥锁，可能破坏缓存数据。",
      files: ["cache.ts"],
    });
    const auth = finding({
      id: "b",
      severity: "major",
      title: "cache.ts:42 — resolveCache 调用 readEntry 时缺少权限校验，可能泄露其他租户数据。",
      files: ["cache.ts"],
    });
    const groups: FindingGroupsFile = {
      version: 1,
      kind: FINDING_GROUPS_KIND,
      source: {
        runId: "old",
        sha: "a".repeat(40),
        findingsSha256: "b".repeat(64),
        againstRunId: null,
      },
      groups: [
        { rootCauseId: "root", findingIds: ["a"], aliases: [], basis: "same root" },
        { rootCauseId: "root", findingIds: ["b"], aliases: [], basis: "same root" },
      ],
    };
    expect(projectFindingList([mutex, auth]).displayCount).toBe(2);
    expect(projectFindingList([mutex, auth], { groups }).displayCount).toBe(1);
  });

  it("prefers a valid sidecar group over inferred merging", () => {
    const a = finding({
      id: "F-1",
      severity: "major",
      title: "alpha.go:1 — 甲问题 `tokenAlpha`。",
      files: ["alpha.go"],
    });
    const b = finding({
      id: "F-2",
      severity: "minor",
      title: "beta.go:2 — 乙问题 `tokenBeta`。",
      files: ["beta.go"],
    });
    const groups: FindingGroupsFile = {
      version: 1,
      kind: FINDING_GROUPS_KIND,
      source: {
        runId: "run",
        sha: SHA,
        findingsSha256: "b".repeat(64),
        againstRunId: null,
      },
      groups: [
        {
          rootCauseId: "RC-1",
          findingIds: ["F-1", "F-2"],
          aliases: [],
          basis: "sidecar duplicate",
        },
      ],
    };
    const projection = projectFindingList([a, b], { sha: SHA, groups });
    expect(projection.displayCount).toBe(1);
    expect(projection.problems[0]?.origin).toBe("sidecar");
    expect(projection.problems[0]?.severity).toBe("major");
    expect(projection.problems[0]?.blocking).toBe(true);
  });

  it("ignores an invalid sidecar and falls back to inferred groups", () => {
    const a = finding({
      id: "F-1",
      severity: "major",
      title:
        "`recovery.go:357` — 提交 idle 遇到临时存储错误时 `closeOpenedOn` 留下 UUID，应改 `forgetOpenedOn`。",
      files: ["recovery.go"],
    });
    const b = finding({
      id: "F-2",
      severity: "major",
      title:
        "pkg/runtime/recovery.go:357 — 临时存储错误后 Close 仍保留 UUID 为 error，改用 `forgetOpenedOn`。",
      files: ["pkg/runtime/recovery.go"],
    });
    const groups = {
      version: 1,
      kind: FINDING_GROUPS_KIND,
      source: {
        runId: "run",
        sha: SHA,
        findingsSha256: "b".repeat(64),
        againstRunId: null,
      },
      groups: [
        {
          rootCauseId: "RC-missing",
          findingIds: ["missing"],
          aliases: [],
          basis: "bad",
        },
      ],
    } as FindingGroupsFile;
    const projection = projectFindingList([a, b], { sha: SHA, groups });
    expect(projection.displayCount).toBe(1);
    expect(projection.problems[0]?.origin).toBe("inferred");
  });
});

const COPIED_CONSEQUENCE =
  "恢复流程先提交空闲记录，随后补偿写在盖章前把刚提交的记录覆写回创建中，调用方仍收到成功。";

function withLocation(
  partial: Partial<LedgerFinding> & Pick<LedgerFinding, "id" | "title">,
  location: string,
  extraLines: string[] = [],
): LedgerFinding {
  return finding({
    severity: "major",
    files: [location.split(":")[0] ?? ""],
    ...partial,
    text: [partial.title, `位置：\`${location}\``, ...extraLines].join("\n"),
  });
}

describe("paraphrased findings that cite the same location", () => {
  it("merges titles that differ by one word when the location is only on the 位置 line", () => {
    const seat = withLocation(
      {
        id: "seat-restart",
        title: "恢复成功后并发重启会漏恢复会话并误报可用",
        reviewer: "review-correctness",
      },
      "pkg/runtime/manager/session_recovery.go:1265-1272",
    );
    const aggregated = withLocation(
      {
        id: "agg-restart",
        title: "恢复成功后并发重启会漏恢复并误报可用",
        reviewer: null,
      },
      "pkg/runtime/manager/session_recovery.go:1265-1272",
    );
    expect(isProvenDuplicate(seat, aggregated)).toBe(true);
    const projection = projectFindingList([seat, aggregated]);
    expect(projection.displayCount).toBe(1);
    expect(projection.blockingCount).toBe(1);
    expect(projection.problems[0]?.members.map((row) => row.id).sort()).toEqual([
      "agg-restart",
      "seat-restart",
    ]);
    expect(projection.problems[0]?.origin).toBe("inferred");
  });

  it("merges a paraphrased title when the 触发与后果 text is the same defect", () => {
    const seat = withLocation(
      {
        id: "seat-stamp",
        title: "补偿重试写落在提交与盖章之间，恢复报成功但记录回退 creating",
        reviewer: "review-cursor",
      },
      "pkg/runtime/manager/session_recovery.go:767-848",
      [`触发与后果：${COPIED_CONSEQUENCE}`],
    );
    const aggregated = withLocation(
      {
        id: "agg-stamp",
        title: "补偿写夹在提交与盖章之间会回退已恢复记录",
        reviewer: null,
      },
      "pkg/runtime/manager/session_recovery.go:767-848",
      [`触发与后果：${COPIED_CONSEQUENCE}`],
    );
    expect(isProvenDuplicate(seat, aggregated)).toBe(true);
    const projection = projectFindingList([seat, aggregated]);
    expect(projection.blockingCount).toBe(1);
    expect(projection.problems[0]?.members).toHaveLength(2);
    expect(projection.problems[0]?.sourceTags).toEqual(["独有"]);
  });

  it("does not merge the same location when the 触发与后果 names different defects", () => {
    const mutex = withLocation(
      { id: "mutex", title: "丢失互斥锁会破坏缓存" },
      "pkg/cache/store.ts:42",
      [
        "触发与后果：当缓存未命中时调用方丢失互斥锁，造成并发写入互相覆盖并破坏已经持久化的缓存数据。",
      ],
    );
    const auth = withLocation(
      { id: "auth", title: "缺少鉴权会泄露租户" },
      "pkg/cache/store.ts:42",
      [
        "触发与后果：当缓存未命中时调用方缺少鉴权检查，造成其他租户的缓存记录被读出并写回错误的命名空间。",
      ],
    );
    expect(isProvenDuplicate(mutex, auth)).toBe(false);
    expect(projectFindingList([mutex, auth]).displayCount).toBe(2);
  });

  it("does not merge a copied 触发与后果 when only the 证据 line cites the same file", () => {
    const evidence =
      "证据：临时测试 `pkg/runtime/manager/session_recovery_contract_test.go:30-42`。";
    const stamp = withLocation(
      { id: "stamp", title: "补偿写夹在提交与盖章之间会回退已恢复记录" },
      "pkg/runtime/manager/session_recovery.go:767-848",
      [`触发与后果：${COPIED_CONSEQUENCE}`, evidence],
    );
    const restart = withLocation(
      { id: "restart", title: "恢复成功后并发重启会漏恢复并误报可用" },
      "pkg/runtime/manager/session_recovery.go:1265-1272",
      [`触发与后果：${COPIED_CONSEQUENCE}`, evidence],
    );
    expect(isProvenDuplicate(stamp, restart)).toBe(false);
    expect(projectFindingList([stamp, restart]).blockingCount).toBe(2);
  });

  it("does not treat a short shared 触发与后果 as the same defect", () => {
    const left = withLocation(
      { id: "left", title: "甲路径返回错误" },
      "pkg/runtime/manager/session_recovery.go:10-12",
      ["触发与后果：调用返回错误。"],
    );
    const right = withLocation(
      { id: "right", title: "乙路径中断恢复" },
      "pkg/runtime/manager/session_recovery.go:10-12",
      ["触发与后果：调用返回错误。"],
    );
    expect(isProvenDuplicate(left, right)).toBe(false);
  });

  it("keeps overlapping but unequal line ranges apart", () => {
    const wide = withLocation(
      { id: "wide", title: "重试等锁时会话名被复用会交出会话", source: "consensus" },
      "pkg/runtime/manager/session_recovery.go:1117-1183",
      [`触发与后果：${COPIED_CONSEQUENCE}`],
    );
    const narrow = withLocation(
      {
        id: "narrow",
        title: "重试遇到跨命名空间同名重建会返回其他会话",
        reviewer: "review-correctness",
      },
      "pkg/runtime/manager/session_recovery.go:1150-1163",
      [`触发与后果：${COPIED_CONSEQUENCE}`],
    );
    expect(isProvenDuplicate(wide, narrow)).toBe(false);
    expect(projectFindingList([wide, narrow]).displayCount).toBe(2);
  });
});

describe("group status is not contagious", () => {
  it("keeps a group blocking when one member is verified closed and another is open", () => {
    const closed = finding({
      id: "closed",
      severity: "major",
      title:
        "`recovery.go:357` — 提交 idle 遇到临时存储错误时 `closeOpenedOn` 留下 UUID，应改 `forgetOpenedOn`。",
      status: "closed",
      verification: verification("verified_closed"),
    });
    const open = finding({
      id: "open",
      severity: "major",
      title:
        "pkg/runtime/recovery.go:357 — 临时存储错误后 Close 仍保留 UUID 为 error，改用 `forgetOpenedOn`。",
    });
    const problem = projectFindingList([closed, open], { sha: SHA }).problems[0];
    expect(problem?.blocking).toBe(true);
    expect(problem?.resolved).toBe(false);
    expect(problem?.statusLabel).toBe("待处理");
  });

  it("does not treat open + accepted as resolved", () => {
    const accepted = finding({
      id: "accepted",
      severity: "major",
      title:
        "`recovery.go:357` — 提交 idle 遇到临时存储错误时 `closeOpenedOn` 留下 UUID，应改 `forgetOpenedOn`。",
      status: "accepted",
      acceptedReason: "wontfix",
    });
    const open = finding({
      id: "open",
      severity: "major",
      title:
        "pkg/runtime/recovery.go:357 — 临时存储错误后 Close 仍保留 UUID 为 error，改用 `forgetOpenedOn`。",
    });
    const problem = projectFindingList([accepted, open], { sha: SHA }).problems[0];
    expect(problem?.blocking).toBe(true);
    expect(problem?.resolved).toBe(false);
  });

  it("does not treat stale SHA, not_evaluated, or still_open as solved", () => {
    const stale = finding({
      id: "stale",
      severity: "major",
      title: "alpha.go:1 — `tokenAlpha` 泄漏。",
      status: "closed",
      verification: verification("verified_closed", OTHER_SHA),
    });
    const unevaluated = finding({
      id: "skip",
      severity: "major",
      title: "beta.go:2 — `tokenBeta` 未校验。",
      status: "closed",
      verification: verification("not_evaluated"),
    });
    const still = finding({
      id: "still",
      severity: "major",
      title: "gamma.go:3 — `tokenGamma` 仍成立。",
      verification: verification("still_open"),
    });
    const projection = projectFindingList([stale, unevaluated, still], { sha: SHA });
    expect(projection.blockingCount).toBe(3);
    expect(projection.problems.every((row) => row.statusLabel !== "已验证解决")).toBe(true);
  });

  it("keeps a unique major as blocking as a consensus major", () => {
    const unique = finding({
      id: "u",
      severity: "major",
      title: "a.go:1 — unique `tokenAlpha`。",
      source: "unique",
    });
    const consensus = finding({
      id: "c",
      severity: "major",
      title: "b.go:2 — consensus `tokenBeta`。",
      source: "consensus",
    });
    const projection = projectFindingList([unique, consensus], { sha: SHA });
    expect(projection.problems.every((row) => row.blocking)).toBe(true);
    expect(projection.problems.flatMap((row) => row.sourceTags)).toEqual(
      expect.arrayContaining(["共识", "独有"]),
    );
  });
});

describe("filters and copy", () => {
  it("defaults to blocking, then pending", () => {
    const blocking = finding({
      id: "b",
      severity: "major",
      title: "a.go:1 — `tokenAlpha`。",
    });
    const nit = finding({
      id: "n",
      severity: "nit",
      title: "b.go:2 — `tokenBeta`。",
    });
    const closed = finding({
      id: "c",
      severity: "major",
      title: "c.go:3 — `tokenGamma`。",
      status: "closed",
      verification: verification("verified_closed"),
    });
    const withBlocking = projectFindingList([blocking, nit, closed], { sha: SHA });
    expect(defaultFindingListFilter(withBlocking)).toBe("blocking");
    expect(filterFindingProblems(withBlocking.problems, "blocking")).toHaveLength(1);
    expect(filterFindingProblems(withBlocking.problems, "pending")).toHaveLength(2);
    expect(filterFindingProblems(withBlocking.problems, "resolved")).toHaveLength(1);
    const withoutBlocking = projectFindingList([nit, closed], { sha: SHA });
    expect(defaultFindingListFilter(withoutBlocking)).toBe("pending");
    expect(formatFindingCountNote(withBlocking)).toBeNull();
  });

  it("explains when display count differs from ledger count", () => {
    const a = finding({
      id: "a",
      severity: "major",
      title:
        "`recovery.go:357` — 提交 idle 遇到临时存储错误时 `closeOpenedOn` 留下 UUID，应改 `forgetOpenedOn`。",
    });
    const b = finding({
      id: "b",
      severity: "major",
      title:
        "pkg/runtime/recovery.go:357 — 临时存储错误后 Close 仍保留 UUID 为 error，改用 `forgetOpenedOn`。",
    });
    const note = formatFindingCountNote(projectFindingList([a, b]));
    expect(note).toContain("展示 1 个问题");
    expect(note).toContain("账本 2 条");
  });

  it("labels ordinary open as 待处理, not 未解决", () => {
    const row = finding({ id: "o", severity: "minor", title: "open" });
    expect(displayStatusLabel(row, SHA)).toBe("待处理");
  });
});

describe("coverage and against comparison", () => {
  it("does not claim coverage on a first review", () => {
    expect(
      reviewCoverageLabel({
        kind: "review",
        againstRunId: null,
        evidenceComplete: true,
        uncoveredIds: [],
      }),
    ).toBeNull();
    expect(reviewRelationLabel("review", null)).toBe("本轮新审查，未关联历史修复记录");
  });

  it("describes historical coverage only on a linked re-review", () => {
    expect(
      reviewCoverageLabel({
        kind: "review",
        againstRunId: "ck-review-prior",
        evidenceComplete: true,
      }),
    ).toBe("历史问题评估覆盖完整");
    expect(
      reviewCoverageLabel({
        kind: "review",
        againstRunId: "ck-review-prior",
        evidenceComplete: false,
        uncoveredIds: ["F-1"],
      }),
    ).toBe("历史问题评估覆盖不完整，缺 F-1");
  });

  it("compares only when the against ledger was actually read", () => {
    const current = [
      finding({ id: "keep", severity: "major", title: "still" }),
      finding({ id: "fresh", severity: "minor", title: "new" }),
      finding({
        id: "done",
        severity: "major",
        title: "fixed",
        status: "closed",
        verification: verification("verified_closed"),
      }),
    ];
    expect(
      compareFindingLedgers({
        current,
        currentSha: SHA,
        against: { status: "none" },
      }).status,
    ).toBe("none");
    expect(
      compareFindingLedgers({
        current,
        currentSha: SHA,
        against: { status: "unavailable" },
      }).status,
    ).toBe("unavailable");
    const compared = compareFindingLedgers({
      current,
      currentSha: SHA,
      against: {
        status: "ready",
        runId: "ck-review-prior",
        sha: SHA,
        findings: [
          finding({ id: "keep", severity: "major", title: "still" }),
          finding({ id: "done", severity: "major", title: "fixed" }),
        ],
      },
    });
    expect(compared).toMatchObject({
      status: "compared",
      added: 1,
      remaining: 1,
      resolved: 1,
      accepted: 0,
      againstRunId: "ck-review-prior",
    });
  });

  it("does not count accepted as 本轮解决", () => {
    const prior = finding({
      id: "a",
      severity: "major",
      title: "cache.ts:42 — resolveCache 调用 readEntry 时丢失互斥锁，可能破坏缓存数据。",
    });
    const compared = compareFindingLedgers({
      current: [{ ...prior, status: "accepted", acceptedReason: "用户接受风险" }],
      currentSha: SHA,
      against: { status: "ready", runId: "old", sha: SHA, findings: [prior] },
    });
    expect(compared).toMatchObject({
      status: "compared",
      resolved: 0,
      accepted: 1,
      remaining: 0,
      added: 0,
    });
  });

  it("treats HTTP success without a usable ledger as 无法比较", () => {
    expect(
      againstLedgerFromDetail({
        runId: "ck-review-prior",
        hasFindings: false,
        findings: [],
        reviewEvidence: { sha: SHA },
      }).status,
    ).toBe("unavailable");
    expect(
      againstLedgerFromDetail({
        runId: "ck-review-prior",
        hasFindings: true,
        findings: [],
        reviewEvidence: { sha: SHA },
      }).status,
    ).toBe("ready");
  });
});

describe("acceptance probe counterexamples", () => {
  it("does not merge same-location different causal failures that only share function names", () => {
    const mutex = finding({
      id: "a",
      severity: "major",
      title: "cache.ts:42 — resolveCache 调用 readEntry 时丢失互斥锁，可能破坏缓存数据。",
      files: ["cache.ts"],
    });
    const auth = finding({
      id: "b",
      severity: "major",
      title: "cache.ts:42 — resolveCache 调用 readEntry 时缺少权限校验，可能泄露其他租户数据。",
      files: ["cache.ts"],
    });
    expect(isProvenDuplicate(mutex, auth)).toBe(false);
    expect(projectFindingList([mutex, auth]).displayCount).toBe(2);
  });

  it("does not merge a shared trigger with distinct defects and consequences", () => {
    const missedLock = finding({
      id: "trigger-a",
      severity: "major",
      title:
        "cache.ts:42 — 当缓存未命中时，resolveCache 调用 readEntry 丢失互斥锁，造成并发数据破坏。",
      files: ["cache.ts"],
    });
    const missedAuth = finding({
      id: "trigger-b",
      severity: "major",
      title:
        "cache.ts:42 — 当缓存未命中时，resolveCache 调用 readEntry 缺少鉴权，造成跨租户数据泄露。",
      files: ["cache.ts"],
    });
    expect(isProvenDuplicate(missedLock, missedAuth)).toBe(false);
    expect(projectFindingList([missedLock, missedAuth]).displayCount).toBe(2);
  });

  it("does not merge a shared long prefix with different consequences", () => {
    const stuck = finding({
      id: "prefix-a",
      severity: "major",
      title: "worker.ts:8 — 在重试循环退出之前未保存游标，造成状态机卡住。",
      files: ["worker.ts"],
    });
    const lost = finding({
      id: "prefix-b",
      severity: "major",
      title: "worker.ts:8 — 在重试循环退出之前未保存游标，造成审计日志丢失。",
      files: ["worker.ts"],
    });
    expect(projectFindingList([stuck, lost]).displayCount).toBe(2);
  });

  it("does not merge a shared generic narrative with different defects", () => {
    const leak = finding({
      id: "narr-a",
      severity: "major",
      title: "guard.ts:3 — 在错误处理路径上，未释放资源，导致泄漏。",
      files: ["guard.ts"],
    });
    const authz = finding({
      id: "narr-b",
      severity: "major",
      title: "guard.ts:3 — 在错误处理路径上，未校验调用方，导致越权。",
      files: ["guard.ts"],
    });
    expect(projectFindingList([leak, authz]).displayCount).toBe(2);
  });

  it("does not transitively merge A~B and B~C when A does not match C", () => {
    const x = finding({
      id: "x",
      severity: "major",
      title: "cache.ts:42 — alphaToken betaToken 导致线程竞争。",
      files: ["cache.ts"],
    });
    const y = finding({
      id: "y",
      severity: "major",
      title: "cache.ts:42 — alphaToken betaToken gammaToken deltaToken 存在相关问题。",
      files: ["cache.ts"],
    });
    const z = finding({
      id: "z",
      severity: "major",
      title: "cache.ts:42 — gammaToken deltaToken 导致鉴权绕过。",
      files: ["cache.ts"],
    });
    expect(projectFindingList([x, y, z]).displayCount).not.toBe(1);
  });
});

describe("settled mixed status", () => {
  it("labels verified + accepted as 已处理（含接受不修） and keeps it in the settled filter", () => {
    const closed = finding({
      id: "closed",
      severity: "major",
      title:
        "`recovery.go:357` — 提交 idle 遇到临时存储错误时 `closeOpenedOn` 留下 UUID，应改 `forgetOpenedOn`。",
      status: "closed",
      verification: verification("verified_closed"),
    });
    const accepted = finding({
      id: "accepted",
      severity: "major",
      title:
        "pkg/runtime/recovery.go:357 — 临时存储错误后 Close 仍保留 UUID 为 error，改用 `forgetOpenedOn`。",
      status: "accepted",
      acceptedReason: "wontfix",
    });
    const projection = projectFindingList([closed, accepted], { sha: SHA });
    const problem = projection.problems[0];
    expect(problem?.statusLabel).toBe("已处理（含接受不修）");
    expect(problem?.pending).toBe(false);
    expect(filterFindingProblems(projection.problems, "pending")).toHaveLength(0);
    expect(filterFindingProblems(projection.problems, "resolved")).toHaveLength(1);
  });
});

describe("readable titles", () => {
  it("strips location and truncates long representative titles", () => {
    const title = `recovery.go:357 — ${"很长的问题描述".repeat(40)}`;
    const readable = readableFindingTitle(title);
    expect(readable).not.toContain("recovery.go:357");
    expect(readable).toContain("很长的问题描述");
    expect(Array.from(readable).length).toBeLessThanOrEqual(FINDING_TITLE_DISPLAY_LIMIT);
    expect(readable.endsWith("…")).toBe(true);
  });

  it("strips cited location and does not leave empty ticks", () => {
    const readable = readableFindingTitle(
      "`session_recovery.go:266-271` — Resume 失败只看 `ctx.Err()`，不看 `flightCurrent`。",
    );
    expect(readable).not.toContain("session_recovery.go:266-271");
    expect(readable).toContain("Resume 失败只看 ctx.Err()");
    expect(readable).not.toMatch(/`\s*`/);
  });
});

describe("incremental review identity and titles", () => {
  const mapperId =
    "app.dal.....pistonsessiondoextendmapper.java--app-dal-...-pistonsessiondoextendmapper.java-67-75";
  const mapper = finding({
    id: mapperId,
    severity: "major",
    title:
      "app/dal/.../PistonSessionDOExtendMapper.java:67-75 — 公开名 `sessionID` 与 GET `/{sessionNameOrID}` 共用 AI Vision id 语义但非等价合同。",
    verification: {
      ...verification("still_open"),
      reason:
        "公开名 sessionID 与 GET /{sessionNameOrID} 仍非等价合同；selectBySessionNameOrSessionID 未改。",
    },
  });
  const repeated = finding({
    id: "h-48d359829697",
    severity: "major",
    title: `${mapperId}** — 四席按行为 \`still_open\`（cursor 关闭见分歧）。公开名 \`sessionID\` 与 GET 仍非等价合同。`,
    text: `${mapperId}** — 四席按行为 \`still_open\`（cursor 关闭见分歧）。公开名 \`sessionID\` 与 GET 仍非等价合同；\`selectBySessionNameOrSessionID\` 未改。反例：\`session_name='av-1'\` 且 \`agentrun_session_id\` 为其它值时 GET 命中、\`filter=sessionID = 'av-1'\` 不命中。`,
    source: "consensus",
  });
  const archived = finding({
    id: "h-052309e7be19",
    severity: "major",
    title:
      "h-052309e7be19** — 五席 `still_open`。GET `/{sessionNameOrID}` 仍是 `session_name = ? OR agentrun_session_id = ?` 且无 `status`。",
    text: "h-052309e7be19** — 五席 `still_open`。GET `/{sessionNameOrID}` 仍是 `session_name = ? OR agentrun_session_id = ?` 且无 `status`；list 的 `sessionID` 只等值 `agentrun_session_id`，默认 `STATUS NOT IN (archived)`。反例：archived 行 GET `/{av-1}` 命中，默认 `filter=sessionID = 'av-1'` 被 policy 滤空。本轮只文档化不等价，不构成落地偏离。",
    source: "consensus",
  });

  it("merges an exact leading ledger reference even when its target has a singleton sidecar", () => {
    const groups: FindingGroupsFile = {
      version: 1,
      kind: FINDING_GROUPS_KIND,
      source: {
        runId: "run",
        sha: SHA,
        findingsSha256: "b".repeat(64),
        againstRunId: "prior",
      },
      groups: [
        { rootCauseId: mapperId, findingIds: [mapperId], aliases: [], basis: "stable root" },
      ],
    };
    const input = [repeated, archived, mapper];
    const snapshot = JSON.stringify(input);
    const projection = projectFindingList(input, { sha: SHA, groups });
    expect(projection.originalCount).toBe(3);
    expect(projection.displayCount).toBe(2);
    expect(projection.blockingCount).toBe(2);
    const merged = projection.problems.find((problem) => problem.members.length === 2);
    expect(merged?.members.map((row) => row.id)).toEqual(
      expect.arrayContaining([mapperId, repeated.id]),
    );
    expect(merged?.basis).toContain("明确引用");
    expect(
      projection.problems.find((row) => row.members[0]?.id === archived.id)?.members,
    ).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it.each([
    `prefix-${mapperId} — 另一问题`,
    `${mapperId}-extra — 另一问题`,
    `无关问题，背景引用 ${mapperId} — 不是同一根因`,
    `另一问题。\n${mapperId} — 背景引用`,
  ])("does not treat a partial ID or an incidental body mention as identity: %s", (text) => {
    const unrelated = finding({
      id: "unrelated",
      severity: "minor",
      title: "缓存更新漏掉权限校验",
      text,
    });
    expect(isProvenDuplicate(mapper, unrelated)).toBe(false);
    expect(projectFindingList([mapper, unrelated]).displayCount).toBe(2);
  });

  it("puts the cause before locations and replaces opaque headings with substantive body text", () => {
    const projection = projectFindingList([repeated, archived, mapper]);
    const merged = projection.problems.find((row) => row.members.length === 2);
    const history = projection.problems.find((row) => row.members[0]?.id === archived.id);
    expect(merged?.title).toContain("session_name");
    expect(merged?.title).toContain("GET 命中");
    expect(merged?.title).toContain("不命中");
    expect(merged?.location).toBe("PistonSessionDOExtendMapper.java:67-75");
    expect(history?.title).toContain("archived");
    expect(history?.title).toContain("滤空");
    for (const row of projection.problems) {
      expect(row.title).not.toMatch(/h-[a-f\d]{12}|still_open|四席|五席|app\.dal|\*\*/);
      expect(Array.from(row.title).length).toBeLessThanOrEqual(FINDING_TITLE_DISPLAY_LIMIT);
    }
  });

  it("falls back to verification reason when the title and body contain only bookkeeping", () => {
    const row = finding({
      id: "h-123456abcdef",
      severity: "minor",
      title: "h-123456abcdef — 五席 still_open",
      verification: { ...verification("still_open"), reason: "字段操作符缺失时契约测试仍会通过。" },
    });
    expect(projectFindingList([row]).problems[0]?.title).toBe("字段操作符缺失时契约测试仍会通过");
  });

  it.each([
    "F-12",
    "h-123456abcdef",
    "session.java--missing-status",
    "app.service.session.provider",
  ])("does not present a bare identity as a cause: %s", (id) => {
    const row = finding({ id, title: id, severity: "minor" });
    expect(projectFindingList([row]).problems[0]?.title).toBe("问题原因待补充（展开查看原始记录）");
    row.verification = { ...verification("still_open"), reason: "请求缺少权限校验。" };
    expect(projectFindingList([row]).problems[0]?.title).toBe("请求缺少权限校验");
    row.title = `${id} — 五席 still_open`;
    row.text = row.title;
    expect(projectFindingList([row]).problems[0]?.title).toBe("请求缺少权限校验");
  });

  it("shows the test failure instead of spending the title on a long filename and test name", () => {
    const row = finding({
      id: "contract-test",
      severity: "minor",
      title:
        "`test/openapi/test_pma_openapi_contract.py` 新增 `test_session_list_filter_matrix_declares_session_id`：只断言整段 description 含操作符，字段缺项时测试仍通过。",
      files: ["test/openapi/test_pma_openapi_contract.py"],
    });
    const problem = projectFindingList([row]).problems[0];
    expect(problem?.title).toBe("只断言整段 description 含操作符，字段缺项时测试仍通过");
    expect(problem?.location).toBe("test_pma_openapi_contract.py");
  });

  it("keeps wildcard syntax and tolerates verification without locations", () => {
    const row = finding({
      id: "indexes",
      severity: "minor",
      title: "`idx_tenant_*` 不能支持按外部 ID 查找。",
      verification: { ...verification("still_open"), locations: undefined },
    });
    const problem = projectFindingList([row]).problems[0];
    expect(problem?.title).toContain("idx_tenant_*");
    expect(problem?.location).toBeNull();
  });
});

describe("local review paraphrase sample", () => {
  it("collapses the two blocking paraphrase pairs in ck-review-c608e4b3 when that run exists", () => {
    const path = join(
      homedir(),
      ".config/councilkit/runs/ck-review-c608e4b3-0447-4049-8b8e-7a7606bf0a3b/findings.json",
    );
    if (!existsSync(path)) return;
    const file = parseFindingsFile(readFileSync(path, "utf8"));
    expect(file).not.toBeNull();
    const projection = projectFindingList(file?.findings ?? [], { sha: file?.sha });
    const restart = projection.problems.filter((row) =>
      row.members.some((member) => member.title.includes("恢复成功后并发重启会漏恢复")),
    );
    const stamp = projection.problems.filter((row) =>
      row.members.some((member) => member.title.includes("提交与盖章之间")),
    );
    expect(restart).toHaveLength(1);
    expect(restart[0]?.members).toHaveLength(2);
    expect(restart[0]?.blocking).toBe(true);
    expect(stamp).toHaveLength(1);
    expect(stamp[0]?.members).toHaveLength(2);
    expect(stamp[0]?.blocking).toBe(true);
    expect(projection.blockingCount).toBe(7);
    const namespace = projection.problems.filter((row) =>
      row.members.some(
        (member) => member.title.includes("会话名被复用") || member.title.includes("跨命名空间"),
      ),
    );
    expect(namespace).toHaveLength(2);
  });
});

describe("local 24-finding sample", () => {
  it("still has three blocking problems when the read-only sample exists", () => {
    const path = join(
      homedir(),
      ".config/councilkit/runs/ck-review-bf9ea27c-aac2-48c3-bd8a-177fd641158c/findings.json",
    );
    if (!existsSync(path)) return;
    const file = parseFindingsFile(readFileSync(path, "utf8"));
    expect(file).not.toBeNull();
    const projection = projectFindingList(file?.findings ?? [], { sha: file?.sha });
    expect(projection.blockingCount).toBe(3);
    const uuid = projection.problems.find((row) =>
      row.members.some((member) => member.id.includes("357")),
    );
    expect(uuid?.members).toHaveLength(2);
  });
});
