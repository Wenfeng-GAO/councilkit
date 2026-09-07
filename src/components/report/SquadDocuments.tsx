import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { Button } from "@/components/ui/Button";
import type { CliRunDocumentDto } from "@shared/runtime/schemas";
import { useEffect, useId, useMemo, useState } from "react";

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
  const defaultId =
    items.find((doc) => doc.id === "final")?.id ??
    items.find((doc) => doc.id === "reviews")?.id ??
    items.find((doc) => doc.id === "brief")?.id ??
    items[0]?.id ??
    "";
  const [activeId, setActiveId] = useState(defaultId);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const sectionId = useId();
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
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  return (
    <section className="ck-squad-documents" aria-label="班组文档">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="ck-squad-doc-title">任务文档</h2>
          <p className="mt-1 text-xs text-muted">需求、方案与验收的原始依据</p>
        </div>
        <Button variant="ghost" onClick={() => void copyActive()}>
          {copied ? "已复制" : `复制${active.title}`}
        </Button>
      </div>
      {copyError ? (
        <output className="text-sm text-warn">复制失败，请从文档中选择需要的内容。</output>
      ) : null}
      <div className="ck-squad-doc-tabs" role="tablist" aria-label="班组文档">
        {items.map((doc) => {
          const selected = doc.id === active.id;
          return (
            <button
              key={doc.id}
              type="button"
              role="tab"
              id={`${sectionId}-${doc.id}`}
              aria-controls={`${sectionId}-panel`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className="ck-squad-doc-tab"
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = items.findIndex((item) => item.id === doc.id);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) %
                        items.length;
                const target = items[next];
                if (target) {
                  setActiveId(target.id);
                  setCopied(false);
                  setCopyError(false);
                  document.getElementById(`${sectionId}-${target.id}`)?.focus();
                }
              }}
              onClick={() => {
                setActiveId(doc.id);
                setCopied(false);
                setCopyError(false);
              }}
            >
              {doc.title}
            </button>
          );
        })}
      </div>
      {active.truncated ? <p className="mt-3 text-sm text-warn">超过 2MB，已截断显示。</p> : null}
      <div
        className="ck-doc ck-squad-doc-body"
        id={`${sectionId}-panel`}
        role="tabpanel"
        aria-labelledby={`${sectionId}-${active.id}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tab panels need keyboard focus for reading.
        tabIndex={0}
        key={active.id}
      >
        <SafeMarkdown variant="document" content={active.markdown} />
      </div>
    </section>
  );
}
