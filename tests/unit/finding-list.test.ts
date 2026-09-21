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
    expect(uuid?.title).toContain("357");
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
  it("keeps location and truncates long representative titles", () => {
    const title = `recovery.go:357 — ${"很长的问题描述".repeat(40)}`;
    const readable = readableFindingTitle(title);
    expect(readable).toContain("recovery.go:357");
    expect(Array.from(readable).length).toBeLessThanOrEqual(FINDING_TITLE_DISPLAY_LIMIT);
    expect(readable.endsWith("…")).toBe(true);
  });

  it("does not leave empty ticks after stripping a cited location", () => {
    const readable = readableFindingTitle(
      "`session_recovery.go:266-271` — Resume 失败只看 `ctx.Err()`，不看 `flightCurrent`。",
    );
    expect(readable).toContain("session_recovery.go:266-271");
    expect(readable).not.toMatch(/`\s*`/);
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
