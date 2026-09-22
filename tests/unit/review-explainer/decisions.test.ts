import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DECISION, FINDING, MODULES } from "../../review-explainer/contract";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

describe("A04 applyFindingDecision", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function api() {
    const mod = await importFeature<Record<string, unknown>>(MODULES.decisions);
    return {
      apply: requireExport<
        (input: Record<string, unknown>) => {
          revision: number;
          items: Record<string, { decision: string }>;
        }
      >(mod, "applyFindingDecision", MODULES.decisions),
      read: requireExport<
        (path: string) => { revision: number; items: Record<string, { decision: string }> }
      >(mod, "readFindingDecisions", MODULES.decisions),
    };
  }

  it("atomically records will_fix / wont_fix / undecided without a reason form", async () => {
    const { apply, read } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-dec-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const first = apply({
      file,
      findingId: FINDING.busy,
      decision: DECISION.willFix,
      expectedRevision: 0,
    });
    expect(first.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
    const second = apply({
      file,
      findingId: FINDING.stale,
      decision: DECISION.wontFix,
      expectedRevision: first.revision,
    });
    expect(second.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
    expect(second.items[FINDING.stale]?.decision).toBe(DECISION.wontFix);
    const withdrawn = apply({
      file,
      findingId: FINDING.stale,
      decision: DECISION.undecided,
      expectedRevision: second.revision,
    });
    expect(withdrawn.items[FINDING.stale]?.decision).toBe(DECISION.undecided);
    const disk = JSON.parse(readFileSync(file, "utf8")) as {
      items: Record<string, { decision: string }>;
    };
    expect(disk.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
    expect(read(file).revision).toBe(withdrawn.revision);
    expect(JSON.stringify(disk)).not.toMatch(/questionnaire|reasonRequired|认可度/);
  });

  it("rejects a stale revision instead of clobbering a concurrent sibling update", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-rev-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const first = apply({
      file,
      findingId: FINDING.busy,
      decision: DECISION.willFix,
      expectedRevision: 0,
    });
    apply({
      file,
      findingId: FINDING.dup,
      decision: DECISION.wontFix,
      expectedRevision: first.revision,
    });
    expect(() =>
      apply({
        file,
        findingId: FINDING.stale,
        decision: DECISION.willFix,
        expectedRevision: first.revision,
      }),
    ).toThrow(/revision|conflict|stale/i);
    const disk = JSON.parse(readFileSync(file, "utf8")) as {
      items: Record<string, { decision: string }>;
    };
    expect(disk.items[FINDING.dup]?.decision).toBe(DECISION.wontFix);
    expect(disk.items[FINDING.stale]).toBeUndefined();
  });

  it("does not leave a truncated file when the write cannot complete", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-fail-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    apply({ file, findingId: FINDING.busy, decision: DECISION.willFix, expectedRevision: 0 });
    const before = readFileSync(file, "utf8");
    // An ordinary file in a parent segment forces an actual ENOTDIR, independent of uid.
    writeFileSync(join(root, "blocked"), "not-a-directory");
    expect(() =>
      apply({
        file: join(root, "blocked", "decisions.json"),
        findingId: FINDING.stale,
        decision: DECISION.willFix,
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
