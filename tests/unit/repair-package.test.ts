import { readFileSync } from "node:fs";
import type { FindingsFile, PlanLockFile } from "@shared/runtime/cli-ledger";
import {
  buildRepairPackage,
  repairExportCommand,
  repairPackageSchema,
} from "@shared/runtime/repair-package";
import { describe, expect, it } from "vitest";

const sha = "a".repeat(40);
const runId = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
function ledger(): FindingsFile {
  return {
    version: 1,
    runId,
    extractedAt: "2026-09-07",
    sha,
    againstRunId: null,
    againstRange: null,
    findings: [
      {
        id: "F-1",
        title: "取消后不派发",
        severity: "major",
        status: "closed",
        text: "cancel accepted then dispatch",
        source: "consensus",
        reviewer: "R",
        files: ["src/cancel.ts"],
      },
      {
        id: "F-2",
        title: "仍未关闭",
        severity: "critical",
        status: "open",
        text: "data loss",
        source: "unique",
        reviewer: "R",
        files: ["src/fs.ts"],
      },
    ],
  };
}
const lock: PlanLockFile = {
  version: 1,
  sourceRunId: runId,
  approvedAt: "2026-09-07",
  verdict: "approve",
  deferred: [],
  clusters: [
    {
      id: "C-1",
      title: "取消",
      closes: ["F-1"],
      files: ["src/cancel.ts"],
      gates: ["pnpm test cancel"],
      policy: "",
      invariants: "cancel prevents dispatch",
      forbidden: "不得修改 fs.ts",
      tests: "复现取消时序",
      mentions: "",
      body: "",
    },
  ],
};
const input = () => ({ runId, complete: true, prUrl: null, ledger: ledger(), planLock: lock });

describe("repair package", () => {
  it("validates the cross-language fixture and refuses unknown fields", () => {
    const value = JSON.parse(
      readFileSync(new URL("../fixtures/repair-package.json", import.meta.url), "utf8"),
    );
    expect(repairPackageSchema.parse(value).findings[0]?.id).toBe("F-STABLE-CANCEL");
    expect(repairPackageSchema.safeParse({ ...value, allowPush: true }).success).toBe(false);
  });
  it("matches intake rejections using the shared fixture", () => {
    const fixture = () =>
      JSON.parse(readFileSync(new URL("../fixtures/repair-package.json", import.meta.url), "utf8"));
    for (const path of [
      "/tmp/x",
      "../x",
      "src/../x",
      ".git/config",
      "src/.git/x",
      "src//x",
      "./x",
      "-flag",
      "C:x",
      "src\\x",
      "src/\nx",
    ]) {
      const value = fixture();
      value.findings[0].files = [path];
      expect(repairPackageSchema.safeParse(value).success, path).toBe(false);
    }
    for (const url of ["file:///tmp/a", "https://user:pass@example.com/pr", "bad"]) {
      const value = fixture();
      value.source.prUrl = url;
      expect(repairPackageSchema.safeParse(value).success, url).toBe(false);
    }
    const upper = fixture();
    upper.source.sha = "A".repeat(40);
    expect(repairPackageSchema.safeParse(upper).success).toBe(false);
    const empty = fixture();
    empty.findings = [];
    expect(repairPackageSchema.safeParse(empty).success).toBe(false);
    const duplicate = fixture();
    duplicate.constraints.deferred = [{ id: duplicate.findings[0].id, reason: "outside" }];
    expect(repairPackageSchema.safeParse(duplicate).success).toBe(false);
    const badText = fixture();
    badText.findings[0].evidence = "nul\0";
    expect(repairPackageSchema.safeParse(badText).success).toBe(false);
  });
  it("merges deferred reasons and gives selected scope priority over plan deferral", () => {
    const task = buildRepairPackage({
      ...input(),
      clusterId: "C-1",
      planLock: {
        ...lock,
        deferred: [
          { title: "F-1", reason: "stale deferral" },
          { title: "F-2", reason: "needs separate work" },
          { title: "F-2", reason: "keep scope" },
        ],
      },
    });
    expect(task.constraints.deferred).toHaveLength(1);
    expect(task.constraints.deferred[0]).toMatchObject({
      id: "F-2",
      reason: expect.stringContaining("needs separate work"),
    });
  });
  it("discloses accepted major risk without claiming verified repair", () => {
    const source = ledger();
    source.findings[1].status = "accepted";
    const task = buildRepairPackage({ ...input(), ledger: source });
    expect(task.constraints.deferred[0]?.reason).toContain("未表示已验证修复");
    expect(task.constraints.deferred[0]?.reason).toContain("critical");
  });
  it("keeps legacy closed major findings and conserves stable identities", () => {
    const task = buildRepairPackage(input());
    expect(task.findings.map((row) => row.id)).toEqual(["F-1", "F-2"]);
    expect(task.findings[0]).toMatchObject({
      rootCause: "F-1",
      invariant: "cancel prevents dispatch",
    });
    expect(task.constraints.acceptance).toContain("pnpm test cancel");
  });
  it("keeps out-of-cluster major items explicitly unresolved", () => {
    const task = buildRepairPackage({ ...input(), clusterId: "C-1" });
    expect(task.findings.map((row) => row.id)).toEqual(["F-1"]);
    expect(task.constraints.deferred).toEqual([
      { id: "F-2", reason: expect.stringContaining("不可据此批准 PR") },
    ]);
  });
  it("fails closed on incomplete, unknown SHA, mismatched or unapproved plans", () => {
    expect(() => buildRepairPackage({ ...input(), complete: false })).toThrow("完整");
    expect(() => buildRepairPackage({ ...input(), ledger: { ...ledger(), sha: "abc" } })).toThrow(
      "SHA",
    );
    expect(() =>
      buildRepairPackage({ ...input(), planLock: { ...lock, verdict: "changes-requested" } }),
    ).toThrow("获准");
    expect(() =>
      buildRepairPackage({ ...input(), ledger: { ...ledger(), runId: "other" } }),
    ).toThrow("SHA");
    expect(() => buildRepairPackage({ ...input(), clusterId: "missing" })).toThrow("cluster");
  });
  it("produces shell-literal export commands without injecting a cluster", () => {
    expect(repairExportCommand(runId, "a'b")).toContain("--cluster 'a'\\''b'");
  });
});
