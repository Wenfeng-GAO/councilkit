/**
 * Spec-contract subtractive review policy (FINAL hard gate companions):
 * (c) Act On requires invariant + counterexample footing;
 * (d) out-of-spec is tagged and non-blocking;
 * nits never block; legacy rows without contractClass keep severity-based blocking.
 * Detection / refuse / auto-bind live in cli/tests/spec-detect.test.ts (a)(b).
 */
import {
  type LedgerFinding,
  hasActOnFooting,
  isFindingBlocking,
  parseFindingContractFields,
} from "@shared/runtime/cli-ledger";
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

describe("parseFindingContractFields", () => {
  it("classifies act-on with invariant and counterexample", () => {
    const parsed = parseFindingContractFields({
      qualifier: "act-on",
      text: [
        "取消路径泄漏 waiter",
        "不变量：`AC-12`",
        "反例：并发取消时 registry 仍持有回调",
        "建议：先 deregister 再 resolve",
      ].join("\n"),
    });
    expect(parsed).toEqual({
      contractClass: "in_contract",
      invariantId: "AC-12",
      counterexample: "并发取消时 registry 仍持有回调",
    });
  });

  it("classifies suggest-amend-spec as out_of_spec", () => {
    const parsed = parseFindingContractFields({
      qualifier: "suggest-amend-spec",
      text: "规格未写明超时上限\n建议：在规格中增加超时不变量",
    });
    expect(parsed.contractClass).toBe("out_of_spec");
  });

  it("honors sectionImpliesOutOfSpec", () => {
    const parsed = parseFindingContractFields({
      qualifier: null,
      text: "意外的全局副作用",
      sectionImpliesOutOfSpec: true,
    });
    expect(parsed.contractClass).toBe("out_of_spec");
  });
});

describe("hasActOnFooting / isFindingBlocking", () => {
  it("requires invariant + counterexample for in_contract Act On", () => {
    const footed = finding({
      id: "a",
      title: "leak",
      severity: "major",
      contractClass: "in_contract",
      invariantId: "INV-1",
      counterexample: "input X leaves waiter",
    });
    const unfooted = finding({
      id: "b",
      title: "leak",
      severity: "major",
      contractClass: "in_contract",
    });
    expect(hasActOnFooting(footed)).toBe(true);
    expect(hasActOnFooting(unfooted)).toBe(false);
    expect(isFindingBlocking(footed)).toBe(true);
    expect(isFindingBlocking(unfooted)).toBe(false);
  });

  it("tags out-of-spec as non-blocking even when major", () => {
    const row = finding({
      id: "c",
      title: "spec gap",
      severity: "critical",
      contractClass: "out_of_spec",
      invariantId: null,
      counterexample: "could still hurt",
    });
    expect(isFindingBlocking(row)).toBe(false);
  });

  it("never blocks nits or minors", () => {
    expect(
      isFindingBlocking(
        finding({
          id: "n",
          title: "style",
          severity: "nit",
          contractClass: "in_contract",
          invariantId: "AC-1",
          counterexample: "n/a",
        }),
      ),
    ).toBe(false);
    expect(
      isFindingBlocking(
        finding({
          id: "m",
          title: "minor",
          severity: "minor",
          contractClass: "in_contract",
          invariantId: "AC-1",
          counterexample: "n/a",
        }),
      ),
    ).toBe(false);
  });

  it("keeps legacy severity blocking when contractClass is absent", () => {
    const legacy = finding({ id: "legacy", title: "old major", severity: "major" });
    expect(legacy.contractClass).toBeUndefined();
    expect(isFindingBlocking(legacy)).toBe(true);
  });
});
