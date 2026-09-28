import { ExplainerError } from "@shared/runtime/review-explainer/io";

/** Decode one model response; schema and frozen-source validation happen next. */
export function decodeExplanationOutput(output: string): {
  value: unknown;
  normalization: "none" | "single-trailing-closing-brace";
} {
  const trimmed = output.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  if (Buffer.byteLength(body) > 256000) throw new ExplainerError("模型输出超过解读大小限制", 502);
  try {
    return { value: JSON.parse(body), normalization: "none" };
  } catch {
    // Observed Grok response: a complete JSON object followed by one extra `}`.
    // Only recover that exact shape. Quoted braces and escaped quotes cannot
    // terminate the object, and a second object or prose must never be ignored.
    if (body.startsWith("{")) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth !== 0) continue;
          if (body.slice(index + 1).trim() === "}") {
            try {
              return {
                value: JSON.parse(body.slice(0, index + 1)),
                normalization: "single-trailing-closing-brace",
              };
            } catch {
              // The object itself is invalid; do not attempt further repairs.
            }
          }
          break;
        }
      }
    }
    throw new ExplainerError("模型返回无效解释 JSON，请重试", 502);
  }
}
