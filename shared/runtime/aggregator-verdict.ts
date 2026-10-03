export type AggregatorVerdict = "approve" | "changes-requested" | "comment" | null;

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const NEXT_HEADING = /^#{2,6} /;
const CONCLUSION = /^## 结论[^\S\n]*$/;
const APPENDIX = /^## (?:过程对比|附录:各审查者交付物)[^\S\n]*$/;

function fenceOpen(line: string): { char: string; length: number } | null {
  const open = FENCE_OPEN.exec(line);
  const marker = open?.[2];
  if (!marker) return null;
  const info = open?.[3] ?? "";
  // A backtick fence whose info contains a backtick is paragraph text.
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0] ?? "`", length: marker.length };
}

/** Last `## 结论` body. Fenced lines are not headings and not verdict text. */
export function conclusionWindow(markdown: string, stopAtAppendix: boolean): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let fence: { char: string; length: number } | null = null;
  let collecting = false;
  let sawConclusion = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open;
      continue;
    }
    if (stopAtAppendix && APPENDIX.test(line)) break;
    if (CONCLUSION.test(line)) {
      sawConclusion = true;
      collecting = true;
      kept.length = 0;
      continue;
    }
    if (NEXT_HEADING.test(line)) {
      collecting = false;
      continue;
    }
    if (collecting) kept.push(line);
  }
  if (!sawConclusion) return null;
  return kept.join("\n").replace(/^\n+/, "");
}

export function extractAggregatorVerdict(markdown: string | null | undefined): AggregatorVerdict {
  if (!markdown) return null;
  const body = conclusionWindow(markdown, true);
  if (body === null) return null;
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
