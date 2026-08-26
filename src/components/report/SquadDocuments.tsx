import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { Button } from "@/components/ui/Button";
import type { CliRunDocumentDto } from "@shared/runtime/schemas";
import { useEffect, useMemo, useState } from "react";

type Doc = Pick<CliRunDocumentDto, "id" | "title" | "markdown" | "truncated">;

export function SquadDocuments({
  documents,
  reportMarkdown,
  reportTruncated,
}: {
  documents: readonly Doc[];
  reportMarkdown: string;
  reportTruncated: boolean;
}) {
  const items = useMemo(() => {
    const next = [...documents];
    if (reportMarkdown.trim().length > 0 && !next.some((doc) => doc.id === "observe")) {
      next.push({
        id: "observe",
        title: "纪要",
        markdown: reportMarkdown,
        truncated: reportTruncated,
      });
    }
    return next.filter((doc) => doc.markdown.trim().length > 0);
  }, [documents, reportMarkdown, reportTruncated]);
  const defaultId = items.find((doc) => doc.id === "brief")?.id ?? items[0]?.id ?? "";
  const [activeId, setActiveId] = useState(defaultId);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (items.some((doc) => doc.id === activeId)) return;
    setActiveId(defaultId);
  }, [activeId, defaultId, items]);
  const active = items.find((doc) => doc.id === activeId) ?? items[0] ?? null;

  if (items.length === 0 || active === null) return null;

  const copyActive = async () => {
    try {
      await navigator.clipboard.writeText(active.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="border border-edge bg-surface px-4 py-4 sm:px-5" aria-label="班组文档">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
          关键结果
        </p>
        <Button variant="ghost" onClick={() => void copyActive()}>
          {copied ? "已复制" : `复制${active.title}`}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="班组文档">
        {items.map((doc) => {
          const selected = doc.id === active.id;
          return (
            <button
              key={doc.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`rounded border px-2 py-1 font-command text-[0.68rem] ${
                selected ? "border-accent text-accent" : "border-edge text-muted hover:text-fg"
              }`}
              onClick={() => {
                setActiveId(doc.id);
                setCopied(false);
              }}
            >
              {doc.title}
            </button>
          );
        })}
      </div>
      {active.truncated ? <p className="mt-3 text-sm text-warn">超过 2MB，已截断显示。</p> : null}
      <article className="ck-doc mt-4" role="tabpanel">
        <SafeMarkdown variant="document" content={active.markdown} />
      </article>
    </section>
  );
}
