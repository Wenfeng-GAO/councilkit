import { DiffDocument } from "@/components/report/explainer/DiffDocument";
import { explainerUi as UI } from "@/components/report/explainer/ui";
import { resolveFindingAnchor } from "@shared/runtime/review-explainer/anchors";
import type { ExplainerFinding, FindingDecision } from "@shared/runtime/review-explainer/contracts";
import { parseFrozenDiff } from "@shared/runtime/review-explainer/diff";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const oldPath = "src/old-name.ts";
const newPath = "src/new-name.ts";
const renamedDiff = [
  `diff --git a/${oldPath} b/${newPath}`,
  "similarity index 50%",
  `rename from ${oldPath}`,
  `rename to ${newPath}`,
  `--- a/${oldPath}`,
  `+++ b/${newPath}`,
  "@@ -1 +1 @@",
  "-releaseLease();",
  "+return;",
  "",
].join("\n");
const noop = () => undefined;

describe("A02 renamed file comments retain their frozen side and path", () => {
  for (const layout of ["split", "unified"] as const) {
    for (const side of ["old", "new"] as const) {
      it(`${layout}: renders a ${side}-side finding inline at that side's original file identity`, () => {
        const parsed = parseFrozenDiff(renamedDiff);
        const path = side === "old" ? oldPath : newPath;
        const anchor = resolveFindingAnchor({ parsedDiff: parsed, side, path, line: 1 });
        expect(anchor).toMatchObject({ status: "resolved", path, side, line: 1 });
        const finding: ExplainerFinding = {
          id: `h-renamed-${side}`,
          title:
            side === "old"
              ? "Renaming removes lease cleanup"
              : "The replacement returns without cleanup",
          text: `${side}-side ${path}:1 must remain inspectable after a rename.`,
          files: [path],
          severity: "major",
          status: "open",
          source: "consensus",
          reviewer: null,
          decision: "undecided",
          anchors: [anchor],
        };
        const html = renderToStaticMarkup(
          createElement(DiffDocument, {
            files: parsed.files,
            findings: [finding],
            layout,
            selectedId: finding.id,
            focus: { path, side, line: 1 },
            contexts: [],
            collapsed: new Set<string>(),
            saving: false,
            contextPending: false,
            decision: (): FindingDecision => "undecided",
            onToggleFile: noop,
            onSelect: noop,
            onDecide: noop,
            onContext: noop,
          }),
        );
        const commentMarker = `data-testid="${UI.comment(finding.id)}"`;
        const oldLineMarker = `data-testid="${UI.line("old", oldPath, 1)}"`;
        const newLineMarker = `data-testid="${UI.line("new", newPath, 1)}"`;
        expect(html).toContain(`data-file-path="${newPath}"`);
        expect(html).toContain("releaseLease();");
        expect(html).toContain("return;");
        expect(html).toContain(commentMarker);
        expect(html.split(commentMarker)).toHaveLength(2);
        expect(html).toContain(finding.text);
        expect(html).toContain("1 条评审意见");
        expect(html).toContain(oldLineMarker);
        expect(html).toContain(newLineMarker);
        expect(html.indexOf(commentMarker)).toBeGreaterThan(
          html.indexOf(side === "old" ? oldLineMarker : newLineMarker),
        );
        expect(html).not.toContain(`data-testid="${UI.unanchored}"`);
        expect(html).not.toContain(`data-testid="${UI.line("old", newPath, 1)}"`);
        expect(html).not.toContain(`data-testid="${UI.line("new", oldPath, 1)}"`);
        // Rendering must not rewrite the persisted source reference to the new file name.
        expect(finding.anchors[0]).toMatchObject({ path, side, line: 1 });
      });
    }
  }
});
