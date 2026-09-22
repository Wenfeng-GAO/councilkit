import { z } from "zod";
import type { ExplanationPayload } from "./contracts";
const text = z.string().trim().min(1).max(8000);
const id = z.string().min(1).max(100);
const location = z
  .object({
    path: z.string().min(1).max(1000),
    side: z.enum(["old", "new"]),
    line: z.number().int().positive().max(10_000_000),
  })
  .strict();
export const canvasModelSchema = z
  .object({
    template: z.enum(["flow", "sequence"]),
    nodes: z
      .array(
        z
          .object({
            id,
            label: text,
            evidence: z.enum(["assertion", "evidence", "inference"]),
            actor: id.optional(),
            location: location.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    edges: z.array(z.object({ from: id, to: id, label: text.optional() }).strict()).max(60),
    participants: z
      .array(z.object({ id, label: text }).strict())
      .max(10)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.nodes.map((node) => node.id));
    const actors = new Set(value.participants?.map((actor) => actor.id));
    if (
      ids.size !== value.nodes.length ||
      value.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to)) ||
      value.nodes.some((node) => node.actor && !actors.has(node.actor))
    )
      ctx.addIssue({ code: "custom", message: "Invalid diagram references" });
  });
export const explanationPayloadSchema = z
  .object({
    kind: z.enum(["code", "flow", "sequence", "text"]),
    assertion: text,
    evidence: z.array(text).max(30),
    inference: z.array(text).max(30),
    preconditions: z.array(text).max(20).optional(),
    steps: z.array(text).max(30).optional(),
    suggestedCode: z
      .object({
        before: z.string().max(32000),
        after: z.string().max(32000),
        verifiedFixed: z.literal(false),
      })
      .strict()
      .optional(),
    canvas: canvasModelSchema.optional(),
    modelId: z.string().max(200).optional(),
  })
  .strict();
export function parseExplanationPayload(
  input: unknown,
): { ok: true; value: ExplanationPayload } | { ok: false; error: string } {
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).length > 256000)
      return { ok: false, error: "解释内容超过大小限制" };
  } catch {
    return { ok: false, error: "无效解释内容" };
  }
  const result = explanationPayloadSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: "无效解释内容：结构、图引用或证据标识不符合要求" };
}
