import { canvasModelSchema } from "./explanation-schema";
export function canvasFallbackText(input: unknown): string {
  const parsed = canvasModelSchema.safeParse(input);
  if (parsed.success)
    return parsed.data.nodes
      .map(
        (node, index) =>
          `${index + 1}. ${node.label}${node.evidence === "inference" ? "（条件推演）" : ""}`,
      )
      .join("\n");
  if (input && typeof input === "object" && "steps" in input && Array.isArray(input.steps))
    return input.steps
      .filter((step): step is string => typeof step === "string")
      .slice(0, 30)
      .join("\n")
      .replace(/<[^>]*>/g, "");
  return "图形暂不可用，请阅读问题说明与已有证据。";
}
export function renderCanvasModel(input: unknown) {
  const parsed = canvasModelSchema.safeParse(input);
  return {
    template: parsed.success ? parsed.data.template : "text",
    executable: false as const,
    fallbackText: canvasFallbackText(input),
    ...(parsed.success ? { model: parsed.data } : {}),
  };
}
