import { describe, expect, it } from "vitest";
import { MODULES } from "../../review-explainer/contract";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

const malicious = {
  kind: "flow",
  assertion: "busy after accept",
  evidence: ["one request returned busy"],
  inference: ["a second retry might double-run"],
  suggestedCode: { before: "return nil", after: "return ErrBusy", verifiedFixed: false },
  canvas: {
    template: "flow",
    nodes: [
      { id: "n1", label: "<script>alert(1)</script>", evidence: "assertion" },
      { id: "n2", label: "busy", evidence: "evidence" },
    ],
    edges: [{ from: "n1", to: "n2" }],
    html: "<img src=x onerror=alert(1)>",
    javascript: "window.exploit=1",
  },
};

describe("A07/A08 explanation schema and canvas", () => {
  async function api() {
    const schemaMod = await importFeature<Record<string, unknown>>(MODULES.explanationSchema);
    const canvasMod = await importFeature<Record<string, unknown>>(MODULES.canvas);
    return {
      parse: requireExport<(input: unknown) => { ok: boolean; value?: unknown; error?: string }>(
        schemaMod,
        "parseExplanationPayload",
        MODULES.explanationSchema,
      ),
      render: requireExport<
        (input: unknown) => { template: string; executable: boolean; fallbackText: string }
      >(canvasMod, "renderCanvasModel", MODULES.canvas),
      fallback: requireExport<(input: unknown) => string>(
        canvasMod,
        "canvasFallbackText",
        MODULES.canvas,
      ),
    };
  }

  it("keeps assertion / evidence / inference distinct and refuses unverified 'already fixed'", async () => {
    const { parse } = await api();
    const parsed = parse({
      ...malicious,
      canvas: {
        template: "flow",
        nodes: [{ id: "n1", label: "accept", evidence: "assertion" }],
        edges: [],
      },
      suggestedCode: { before: "a", after: "b", verifiedFixed: true },
    });
    expect(parsed.ok).toBe(false);
    const good = parse({
      kind: "code",
      assertion: "duplicate string",
      evidence: ["same literal twice"],
      inference: [],
      suggestedCode: { before: "errors.New(x)", after: "errDup", verifiedFixed: false },
    });
    expect(good.ok).toBe(true);
    expect(JSON.stringify(good.value)).toContain("assertion");
    expect(JSON.stringify(good.value)).not.toMatch(/已修好|verified_closed|already fixed/i);
  });

  it("renders only fixed templates and falls back to text when the graph is unusable", async () => {
    const { parse, render, fallback } = await api();
    const rejected = parse(malicious);
    expect(rejected.ok).toBe(false);
    const model = {
      template: "sequence",
      participants: [
        { id: "c", label: "client" },
        { id: "s", label: "store" },
      ],
      nodes: [
        { id: "a", label: "check", evidence: "assertion", actor: "c" },
        { id: "b", label: "commit", evidence: "inference", actor: "s" },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const drawn = render(model);
    expect(drawn.executable).toBe(false);
    expect(drawn.template).toMatch(/sequence|flow/);
    expect(drawn.fallbackText.length).toBeGreaterThan(8);
    const text = fallback({
      error: "bad graph",
      steps: ["check was true", "commit used stale check"],
    });
    expect(text).toContain("check was true");
    expect(text).not.toContain("<script>");
  });
});
