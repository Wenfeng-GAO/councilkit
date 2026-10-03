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

const CHINESE_NEGATION =
  "(?:不会|不再|不能|不要|不可|不应|不是|并非|并未|并不|没有|未)[^\\n。！？!?，,；;、]{0,6}|不";
const ENGLISH_GAP = "(?:\\s+(?!and\\b|but\\b)[A-Za-z]+){0,2}";
const N_T_CONTRACTION =
  "(?:ca|do|wo|should|would|could|does|did|must|is|are|was|were|has|have|had)n['’]?t";
const VERBAL_NEGATION = `(?:^|[^A-Za-z])(?:not|never|cannot|${N_T_CONTRACTION})${ENGLISH_GAP}`;
const WILLING_NOUN =
  "hesitation|reservations|reservation|qualms|objection|objections|scruple|scruples|reluctance";
const NO_NEGATION = `(?:^|[^A-Za-z])no(?!\\s+(?:${WILLING_NOUN})\\b)${ENGLISH_GAP}`;
const NEGATION_BEFORE = new RegExp(
  `(?:${CHINESE_NEGATION}|${VERBAL_NEGATION}|${NO_NEGATION})\\s*$`,
  "i",
);

function lastNegationContext(before: string): string {
  let index = before.length;
  while (index > 0 && /\s/.test(before[index - 1] ?? "")) index -= 1;
  let start = index;
  let seen = 0;
  while (start > 0 && seen < 3) {
    while (start > 0 && !/\s/.test(before[start - 1] ?? "")) start -= 1;
    seen += 1;
    if (seen === 3 || start === 0) break;
    while (start > 0 && /\s/.test(before[start - 1] ?? "")) start -= 1;
  }
  return before.slice(start);
}

function verdictInProse(body: string): AggregatorVerdict {
  for (const match of body.matchAll(/\b(approve|changes-requested|comment)\b/gi)) {
    const index = match.index ?? 0;
    const before = lastNegationContext(body.slice(0, index).replace(/[`"*]/g, ""));
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
