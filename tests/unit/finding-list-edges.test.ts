import { formatLedgerComparison, problemStatusLabel, projectFindingList } from "@/lib/finding-list";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import type { FindingGroupsFile } from "@shared/runtime/finding-groups";
import { describe, expect, it } from "vitest";

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

describe("finding list edges", () => {
  it("ignores a groups sidecar that throws outside FindingGroupsError", () => {
    const row = finding({
      id: "line-only",
      severity: "minor",
      title: "idle close drops the uuid",
      text: "see marker :42",
      files: ["pkg/handler.go", "README"],
    });
    const groups = {
      get groups(): never {
        throw new TypeError("groups exploded");
      },
    } as unknown as FindingGroupsFile;
    const problem = projectFindingList([row], { groups, sha: null }).problems[0];
    expect(problem).toMatchObject({
      key: "line-only",
      origin: "singleton",
      basis: null,
      location: "handler.go",
      severity: "minor",
      statusLabel: "待处理",
      blocking: false,
      pending: true,
      resolved: false,
      title: "see marker :42",
    });
  });

  it("labels an all-accepted group with the first accepted reason", () => {
    expect(
      problemStatusLabel(
        [
          finding({
            id: "a",
            title: "drop the checksum",
            severity: "major",
            status: "accepted",
            acceptedReason: "wontfix",
          }),
        ],
        null,
      ),
    ).toBe("接受不修 · wontfix");
  });

  it("collapses mixed non-blocking labels to 待处理", () => {
    expect(
      problemStatusLabel(
        [
          finding({ id: "a", title: "open item", severity: "minor", status: "open" }),
          finding({ id: "b", title: "regressed item", severity: "minor", status: "regress" }),
        ],
        null,
      ),
    ).toBe("待处理");
  });

  it("formats a compared ledger and returns null for status none", () => {
    expect(
      formatLedgerComparison({
        status: "compared",
        added: 1,
        remaining: 2,
        resolved: 3,
        accepted: 4,
        againstRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      }),
    ).toBe("对照关联账本：新增 1 · 仍存在 2 · 已解决 3 · 接受不修 4");
    expect(formatLedgerComparison({ status: "none" })).toBeNull();
  });
});
