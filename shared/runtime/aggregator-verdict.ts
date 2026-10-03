export type AggregatorVerdict = "approve" | "changes-requested" | "comment" | null;

export function extractAggregatorVerdict(markdown: string | null | undefined): AggregatorVerdict {
  if (!markdown) return null;
  const normalized = markdown.replace(/\r\n/g, "\n");
  const cut = normalized.search(/^## (?:过程对比|附录:各审查者交付物)[^\S\n]*$/m);
  const text = cut < 0 ? normalized : normalized.slice(0, cut);
  const heading = [...text.matchAll(/^## 结论[^\S\n]*$/gm)].at(-1);
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
  /(?:(?:不会|不再|不能|不要|不可|不应|不是|并非|并未|并不|没有|未)[^\n。！？!?，,；;、]{0,6}|不|(?:^|[^A-Za-z])(?:not|never|no|cannot|(?:ca|do|wo|should|would|could|does|did|must|is|are|was|were|has|have|had)n['\u2019]?t)(?:\s+[A-Za-z]+){0,2})\s*$/i;

function verdictInProse(body: string): AggregatorVerdict {
  for (const match of body.matchAll(/\b(approve|changes-requested|comment)\b/gi)) {
    const index = match.index ?? 0;
    const before = body.slice(Math.max(0, index - 16), index).replace(/[`"*]/g, "");
    if (NEGATION_BEFORE.test(before)) continue;
    return asVerdict(match[1]);
  }
  return null;
}

export function isBareVerdictLine(line: string): boolean {
  return asVerdict(line.trim()) !== null;
}

function asVerdict(value: string | undefined): AggregatorVerdict {
  const token = value?.toLowerCase();
  if (token === "approve" || token === "changes-requested" || token === "comment") return token;
  return null;
}
