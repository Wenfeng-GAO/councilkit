/**
 * Seat drivers sometimes prepend status chatter to the final deliverable
 * (`正在读取规格文件…`). That text is process, not the review. Drop a leading
 * run of narration lines when a deliverable heading follows; leave the rest
 * of the message alone so a real introduction is not eaten.
 */

// `\b` does not fire after a CJK heading: those characters are non-word, so
// `## 发现` never matched and the narration prefix was kept.
const DELIVERABLE_HEADING =
  /^#{1,3}\s+(?:发现|验证|结论|概览|共识发现|独有发现|分歧|待确认|建议修订规格|findings|verification|verdict|summary)(?![A-Za-z0-9_])/i;

const NARRATION_LINE =
  /^(?:正在[^\n]{0,80}(?:…|\.{3})?|(?:让我|我先|我来|我将|接下来我|现在我|先读|先看|先看一下|先读一下)[^\n]{0,80}|(?:let me|i'll|i will|i am going to|reading|looking at|checking)\b[^\n]{0,80})\s*$/i;

const DECORATIVE_LINE = /^[\s•·…\.。]+$/u;

export function isProcessNarrationLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (DECORATIVE_LINE.test(trimmed)) return true;
  return NARRATION_LINE.test(trimmed);
}

/** Strip leading process narration. Returns the original text when unsure. */
export function stripProcessNarration(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const headIdx = lines.findIndex((line) => DELIVERABLE_HEADING.test(line.trim()));
  if (headIdx < 0) return text;
  if (headIdx === 0) {
    const first = lines[0] ?? "";
    const stripped = stripNarrationPrefix(first);
    if (stripped === first) return text;
    lines[0] = stripped;
    return lines.join("\n").replace(/^\n+/, "");
  }
  const lead = lines.slice(0, headIdx);
  const nonempty = lead.filter((line) => line.trim().length > 0);
  if (nonempty.length === 0) return lines.slice(headIdx).join("\n").replace(/^\n+/, "");
  if (!nonempty.every((line) => isProcessNarrationLine(line))) return text;
  return lines.slice(headIdx).join("\n").replace(/^\n+/, "");
}

function stripNarrationPrefix(line: string): string {
  return line.replace(
    /^(?:正在[^\n#]{0,80}(?:…|\.{3})?\s+|(?:让我|我先|我来|我将)[^\n#]{0,40}\s+)/,
    "",
  );
}
