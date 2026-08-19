import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { ReviewReportView } from "@/components/report/ReviewReportView";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { buildFixFromReviewPrompt } from "@/lib/fix-prompt";
import { parseReviewReport } from "@/lib/review-report";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import "@/styles/report.css";

type CopiedKind = "markdown" | "prompt" | null;

export function ReportDetailPage() {
  const { runId = "" } = useParams();
  const { client } = getAppRuntime();
  const [copied, setCopied] = useState<CopiedKind>(null);
  const query = useQuery({
    queryKey: ["cli-runs", runId],
    queryFn: () => client.getCliRun(runId),
    enabled: runId.length > 0,
    retry: false,
  });
  const parsed = useMemo(
    () => (query.data?.markdown ? parseReviewReport(query.data.markdown) : null),
    [query.data?.markdown],
  );

  const copyText = async (kind: Exclude<CopiedKind, null>, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const copyMarkdown = () => {
    if (!query.data) return;
    void copyText("markdown", query.data.markdown);
  };

  const copyFixPrompt = () => {
    if (!query.data) return;
    void copyText(
      "prompt",
      buildFixFromReviewPrompt({
        markdown: query.data.markdown,
        title: query.data.title,
        kind: query.data.kind,
        truncated: query.data.truncated,
        verdict: parsed?.verdict ?? null,
      }),
    );
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-8 sm:px-8">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          <Link to="/reports" className="text-accent hover:underline">
            ← CLI 报告
          </Link>
        </p>
        {query.data?.markdown ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={copyMarkdown}>
              {copied === "markdown" ? "已复制" : "复制 Markdown"}
            </Button>
            <Button onClick={copyFixPrompt}>
              {copied === "prompt" ? "已复制 Prompt" : "复制修复 Prompt"}
            </Button>
          </div>
        ) : null}
      </div>
      {query.isPending ? <p className="text-sm text-muted">正在打开报告…</p> : null}
      {query.isError ? (
        <EmptyState title="找不到这份报告" hint="run id 无效，或 report.md 尚未写入。" />
      ) : null}
      {query.data ? (
        <>
          {query.data.truncated ? (
            <p className="text-sm text-warn">报告超过 2MB，已截断显示。</p>
          ) : null}
          {!query.data.hasReport || query.data.markdown.trim().length === 0 ? (
            <EmptyState title="还没有 report.md" hint="这次 run 可能失败在写报告之前。" />
          ) : parsed ? (
            <ReviewReportView report={parsed} />
          ) : (
            <article className="border border-edge bg-surface px-5 py-5 sm:px-7 sm:py-6">
              <SafeMarkdown variant="document" content={query.data.markdown} />
            </article>
          )}
        </>
      ) : null}
    </div>
  );
}
