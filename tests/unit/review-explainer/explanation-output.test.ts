import { parseExplanationPayload } from "@shared/runtime/review-explainer/explanation-schema";
import { describe, expect, it } from "vitest";
import { decodeExplanationOutput } from "../../../runtime-host/review-explainer/explanation-output";

const payload = {
  kind: "text",
  title: "重复请求可能导致同一任务执行两次",
  assertion: '请求中包含 }、{、转义引号"和反斜线\\，仍需保留。',
  evidence: ["已有证据"],
  inference: [],
  canvas: {
    template: "flow",
    nodes: [{ id: "n1", label: "嵌套对象中的 }", evidence: "assertion" }],
    edges: [],
  },
};

describe("bounded explanation output decoding", () => {
  it.each(["", "\n}", "  \n } \t\n"])(
    "reads strict JSON or exactly one trailing closing brace (%j)",
    (suffix) => {
      const decoded = decodeExplanationOutput(`${JSON.stringify(payload)}${suffix}`);
      expect(decoded.value).toEqual(payload);
      expect(decoded.normalization).toBe(suffix ? "single-trailing-closing-brace" : "none");
    },
  );

  it("preserves supported complete JSON fences", () => {
    expect(
      decodeExplanationOutput(`\n\`\`\`json\n${JSON.stringify(payload)}\n}\n\`\`\`\n`).value,
    ).toEqual(payload);
  });

  it.each([
    `${JSON.stringify(payload)}\n{ "other": true }`,
    `${JSON.stringify(payload)}\n} trailing text`,
    `${JSON.stringify(payload)}\n}}`,
    `prefix ${JSON.stringify(payload)}\n}`,
    '{"a": [1,]}\n}',
    '{"a": "unterminated}\n}',
    '{"a": "bad\\q"}\n}',
    '{"a": {"b": true}',
    '[{"a": true}]\n}',
    `\`\`\`json\n${JSON.stringify(payload)}\n}`,
  ])("rejects ambiguous, internally invalid or incomplete output: %s", (raw) => {
    expect(() => decodeExplanationOutput(raw)).toThrow("模型返回无效解释 JSON");
  });

  it("does not relax the size bound or the following explanation schema validation", () => {
    expect(() =>
      decodeExplanationOutput(JSON.stringify({ assertion: "a".repeat(256000) })),
    ).toThrow("大小限制");
    expect(
      parseExplanationPayload(decodeExplanationOutput('{"unexpected":true}\n}').value).ok,
    ).toBe(false);
  });
});
