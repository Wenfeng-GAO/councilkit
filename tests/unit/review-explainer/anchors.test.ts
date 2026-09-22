import { describe, expect, it } from "vitest";
import { FINDING, MODULES } from "../../review-explainer/contract";
import {
  BUSY_SNIPPET,
  DELETED_SNIPPET,
  SAMPLE_DIFF,
} from "../../review-explainer/fixtures/sample-diff";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

interface Anchor {
  status: string;
  side?: "old" | "new";
  path?: string;
  line?: number;
  snippet?: string;
}

describe("A02 resolveFindingAnchor", () => {
  async function resolve() {
    const diffMod = await importFeature<Record<string, unknown>>(MODULES.diff);
    const parseFrozenDiff = requireExport<(diff: string) => unknown>(
      diffMod,
      "parseFrozenDiff",
      MODULES.diff,
    );
    const anchorMod = await importFeature<Record<string, unknown>>(MODULES.anchors);
    const resolveFindingAnchor = requireExport<
      (input: Record<string, unknown>) => Anchor | Anchor[]
    >(anchorMod, "resolveFindingAnchor", MODULES.anchors);
    return { parsed: parseFrozenDiff(SAMPLE_DIFF), resolveFindingAnchor };
  }

  it("pins a new-side comment to the frozen snippet, not a nearby context line", async () => {
    const { parsed, resolveFindingAnchor } = await resolve();
    const result = resolveFindingAnchor({
      findingId: FINDING.busy,
      parsedDiff: parsed,
      side: "new",
      path: "src/busy.go",
      line: 7,
      snippet: BUSY_SNIPPET,
    });
    const anchor = Array.isArray(result) ? result[0] : result;
    expect(anchor.status).toMatch(/ok|resolved|exact/);
    expect(anchor.side).toBe("new");
    expect(anchor.path).toBe("src/busy.go");
    expect(anchor.line).toBe(7);
    expect(anchor.snippet).toContain(BUSY_SNIPPET);
  });

  it("places a deleted-line finding on the old side", async () => {
    const { parsed, resolveFindingAnchor } = await resolve();
    const result = resolveFindingAnchor({
      findingId: FINDING.deleted,
      parsedDiff: parsed,
      side: "old",
      path: "src/deleted.go",
      line: 3,
      snippet: DELETED_SNIPPET,
    });
    const anchor = Array.isArray(result) ? result[0] : result;
    expect(anchor.side).toBe("old");
    expect(anchor.path).toBe("src/deleted.go");
    expect(anchor.line).toBe(3);
  });

  it("returns 待定位 for missing, out-of-range, and rename-without-map cases", async () => {
    const { parsed, resolveFindingAnchor } = await resolve();
    const missing = resolveFindingAnchor({
      findingId: FINDING.unanchored,
      parsedDiff: parsed,
      side: "new",
      path: "src/missing.go",
      line: 999,
      snippet: "no such line",
    });
    const miss = Array.isArray(missing) ? missing[0] : missing;
    expect(miss.status).toMatch(/unanchored|pending|unresolved|待定位/);
    expect(miss.line === 999).toBe(false);

    const overflow = resolveFindingAnchor({
      findingId: "F-overflow",
      parsedDiff: parsed,
      side: "new",
      path: "src/busy.go",
      line: 9999,
    });
    const over = Array.isArray(overflow) ? overflow[0] : overflow;
    expect(over.status).toMatch(/unanchored|pending|unresolved|待定位/);

    const staleRename = resolveFindingAnchor({
      findingId: "F-old-name",
      parsedDiff: parsed,
      side: "new",
      path: "src/old_name.go",
      line: 1,
    });
    const renamed = Array.isArray(staleRename) ? staleRename[0] : staleRename;
    expect(renamed.path === "src/old_name.go" && renamed.status === "ok").toBe(false);
  });
});
