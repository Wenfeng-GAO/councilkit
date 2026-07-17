import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { useState } from "react";

interface SummaryBlockProps {
  /** Committed Summary content (untrusted markdown); null renders nothing. */
  content: string | null;
}

/** Collapsible Round Summary block (U6): content only via SafeMarkdown. */
export function SummaryBlock({ content }: SummaryBlockProps) {
  const [open, setOpen] = useState(false);
  if (!content) return null;
  return (
    <section className="py-2" aria-label="本轮总结">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mb-2 text-sm font-medium text-accent hover:underline"
      >
        {open ? "▾ 收起总结" : "▸ 展开本轮总结"}
      </button>
      {open ? (
        <div className="rounded border border-edge bg-surface p-4 text-sm text-fg">
          <SafeMarkdown content={content} />
        </div>
      ) : null}
    </section>
  );
}
