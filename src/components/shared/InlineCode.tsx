import type { ReactNode } from "react";

/**
 * Render UI copy that marks commands with backticks (「运行 `councilkit init`」)
 * so the command shows in code style and the backticks themselves never reach
 * the screen (#318). An unpaired backtick is dropped rather than shown.
 */
export function renderInlineCode(text: string): ReactNode {
  if (!text.includes("`")) return text;
  const parts = text.split("`");
  const closed = parts.length % 2 === 1;
  return parts.map((part, index) => {
    const isCode = index % 2 === 1 && (closed || index < parts.length - 1);
    if (part === "") return null;
    return isCode ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static copy, order never changes
      <code key={index} className="font-command whitespace-nowrap">
        {part}
      </code>
    ) : (
      part
    );
  });
}
