import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

export function ReportDetailPage() {
  const { runId = "" } = useParams();
  const { client } = getAppRuntime();
  const query = useQuery({
    queryKey: ["cli-runs", runId],
    queryFn: () => client.getCliRun(runId),
    enabled: runId.length > 0,
    retry: false,
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
      <p className="text-sm text-muted">
        <Link to="/reports" className="text-accent hover:underline">
          ← CLI 报告
        </Link>
      </p>
      {query.isPending ? <p className="text-sm text-muted">正在打开报告…</p> : null}
      {query.isError ? (
        <EmptyState title="找不到这份报告" hint="run id 无效，或 report.md 尚未写入。" />
      ) : null}
      {query.data ? (
        <>
          <header className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-fg">{query.data.title}</h1>
              <p className="mt-1 font-mono text-xs text-muted">{query.data.runId}</p>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(query.data.markdown);
              }}
            >
              复制 Markdown
            </Button>
          </header>
          {query.data.truncated ? (
            <p className="text-sm text-warn">报告超过 2MB，已截断显示。</p>
          ) : null}
          {!query.data.hasReport || query.data.markdown.trim().length === 0 ? (
            <EmptyState title="还没有 report.md" hint="这次 run 可能失败在写报告之前。" />
          ) : (
            <article className="rounded border border-edge bg-surface px-4 py-3 text-sm leading-relaxed">
              <SafeMarkdown content={query.data.markdown} />
            </article>
          )}
        </>
      ) : null}
    </div>
  );
}
