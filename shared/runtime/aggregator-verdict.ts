export type AggregatorVerdict = "approve" | "changes-requested" | "comment" | null;

export function extractAggregatorVerdict(markdown: string | null | undefined): AggregatorVerdict {
  if (!markdown) return null;
  const text = markdown.replace(/\r\n/g, "\n");
  const heading = /^## 结论[^\S\n]*$/m.exec(text);
  if (heading?.index === undefined) return null;
  const after = text.slice(heading.index + heading[0].length).replace(/^\n+/, "");
  const next = /^## /m.exec(after);
  const body = next?.index === undefined ? after : after.slice(0, next.index);
  for (const line of body.split("\n")) {
    const bare = asVerdict(line.trim());
    if (bare) return bare;
  }
  return verdictInProse(body);
}

const NEGATION_BEFORE =
  /(?:(?:不会|不再|不能|不要|不可|不应|不是|并非|并未|并不|没有|未)[^\n。！？!?，,；;、]{0,6}|不|(?:^|[^A-Za-z])(?:not|never|no|don'?t|won'?t|cannot|can'?t)(?:\s+[A-Za-z]+){0,2})\s*$/i;

function verdictInProse(body: string): AggregatorVerdict {
  for (const match of body.matchAll(/\b(approve|changes-requested|comment)\b/g)) {
    const index = match.index ?? 0;
    const before = body.slice(Math.max(0, index - 16), index).replace(/[`"*]/g, "");
    if (NEGATION_BEFORE.test(before)) continue;
    return asVerdict(match[1]);
  }
  return null;
}

function asVerdict(value: string | undefined): AggregatorVerdict {
  if (value === "approve" || value === "changes-requested" || value === "comment") return value;
  return null;
}
