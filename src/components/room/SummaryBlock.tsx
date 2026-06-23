import { useState } from "react";
import ReactMarkdown from "react-markdown";

interface SummaryBlockProps {
  content: string | null;
}

export function SummaryBlock({ content }: SummaryBlockProps) {
  const [open, setOpen] = useState(false);
  if (!content) return null;
  return (
    <section className="mx-auto max-w-3xl px-6 py-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-2 text-sm font-medium text-accent hover:underline"
      >
        {open ? "▾ 收起总结" : "▸ 展开本轮总结"}
      </button>
      {open ? (
        <div className="rounded border border-edge bg-surface p-4 text-sm text-fg">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      ) : null}
    </section>
  );
}
