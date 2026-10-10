/**
 * Spec-contract hard gate: no-spec refuse, with-spec auto-bind, verify schedule.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPEC_REFUSAL_MESSAGE,
  autoDetectSpec,
  bindVerifyFromSpec,
  extractAcceptanceIds,
  extractConventionalSpecRefs,
  formatSpecRefusal,
  isConventionalSpecPath,
  resolveSpecContract,
} from "../src/auto/spec-detect";

describe("conventional path detection", () => {
  it("recognizes docs/plans, design, vibespec, verification, acceptance", () => {
    expect(isConventionalSpecPath("docs/plans/feat-plan.md")).toBe(true);
    expect(isConventionalSpecPath("docs/design/2026-09-20-review-workspace/README.md")).toBe(true);
    expect(isConventionalSpecPath("docs/vibespec/councilkit/VERIFY.md")).toBe(true);
    expect(isConventionalSpecPath("docs/verification/2026-09-23-review-explainer-acceptance.md")).toBe(
      true,
    );
    expect(isConventionalSpecPath("src/foo.ts")).toBe(false);
    expect(isConventionalSpecPath("README.md")).toBe(false);
  });

  it("extracts path refs from PR/task prose", () => {
    const text = `
See docs/plans/2026-09-28-review-workspace-v2.md and \`docs/verification/foo-acceptance.md\`.
Also docs/vibespec/councilkit/PRD.md.
`;
    const refs = extractConventionalSpecRefs(text);
    expect(refs).toContain("docs/plans/2026-09-28-review-workspace-v2.md");
    expect(refs).toContain("docs/verification/foo-acceptance.md");
    expect(refs).toContain("docs/vibespec/councilkit/PRD.md");
  });
});

describe("no-spec hard refuse", () => {
  it("returns null when search text has no conventional contract", () => {
    expect(
      resolveSpecContract({
        searchText: "Please review this PR carefully for bugs.",
        repoRoot: null,
      }),
    ).toBeNull();
  });

  it("refusal copy names missing contract and where to put a spec", () => {
    const msg = formatSpecRefusal();
    expect(msg).toBe(SPEC_REFUSAL_MESSAGE);
    expect(msg).toContain("review refused: no boundable spec-contract found");
    expect(msg).toContain("docs/plans/");
    expect(msg).toContain("docs/vibespec/");
    expect(msg).toContain("docs/verification/");
    expect(msg).toContain("--spec <path>");
    expect(msg).toContain("PR description / --task text alone is not a contract");
  });
});

describe("with-spec auto-bind", () => {
  it("auto-detects and reads a conventional plan under repoRoot", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-spec-"));
    const dir = join(root, "docs", "plans");
    mkdirSync(dir, { recursive: true });
    const rel = "docs/plans/demo-plan.md";
    writeFileSync(
      join(root, rel),
      ["# Demo", "", "## 验收", "", "- [ ] AC-12 cancel deregisters waiters", ""].join("\n"),
      "utf8",
    );
    const detected = autoDetectSpec({
      searchText: `Implements ${rel} as the contract.`,
      repoRoot: root,
    });
    expect(detected).not.toBeNull();
    expect(detected!.origin).toBe("auto-detect");
    expect(detected!.source).toContain("docs/plans/demo-plan.md");
    expect(detected!.text).toContain("AC-12");
  });

  it("--spec explicit override binds file body", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-spec-"));
    const rel = "docs/verification/demo-acceptance.md";
    mkdirSync(join(root, "docs", "verification"), { recursive: true });
    writeFileSync(join(root, rel), "# Acc\n\nA01 and A02 must hold.\n", "utf8");
    const detected = resolveSpecContract({
      explicitSpec: rel,
      searchText: "ignored when --spec set",
      repoRoot: root,
    });
    expect(detected?.origin).toBe("explicit-flag");
    expect(detected?.text).toContain("A01");
  });
});

describe("verify binding from bound spec", () => {
  it("extracts AC/INV/A0x/VT/agentverify IDs", () => {
    const ids = extractAcceptanceIds(
      "AC-12 and INV-1; also A01, VT3, agentverify:cancel-path",
    );
    expect(ids).toEqual(
      expect.arrayContaining(["AC-12", "INV-1", "A01", "VT3", "agentverify:cancel-path"]),
    );
  });

  it("schedules verify or returns null when unbound", () => {
    const ok = bindVerifyFromSpec({
      specSource: "docs/plans/x.md",
      specText: "## 验收\n\n- AC-9 must hold\n",
    });
    expect(ok).not.toBeNull();
    expect(ok!.acceptanceIds).toContain("AC-9");
    expect(ok!.scheduleNote).toContain("Verify schedule");

    expect(
      bindVerifyFromSpec({
        specSource: "label-only",
        specText: null,
      }),
    ).toBeNull();
  });
});
