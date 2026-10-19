import type { ReactNode } from "react";

const INLINE_CODE = /`([^`]+)`/g;

/**
 * Turn markdown inline code into a monospace element and drop the backtick
 * characters. Report chrome that is not SafeMarkdown would otherwise show
 * the backticks as text. Same treatment as a path quoted in a report sentence.
 */
export function renderInlineCode(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0;
    const code = match[1];
    if (start > last) nodes.push(text.slice(last, start));
    if (code) {
      nodes.push(
        <code key={`code-${index}`} className="ck-inline-code">
          {code}
        </code>,
      );
      index += 1;
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  if (nodes.length === 0) nodes.push(text);
  return nodes;
}
