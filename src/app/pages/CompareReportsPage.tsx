import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import { HOST_DOWN_HINT, HOST_DOWN_TITLE, isHostUnreachableError } from "@/lib/host-status";
import { diffFindings, flattenFindings } from "@/lib/report-groups";
import { parseReviewReport } from "@/lib/review-report";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

export function CompareReportsPage() {
  const { leftId = "", rightId = "" } = useParams();
  const { client } = getAppRuntime();
  const leftQuery = useQuery({
    queryKey: ["cli-runs", leftId],
    queryFn: () => client.getCliRun(leftId),
    enabled: leftId.length > 0,
    retry: false,
  });
  const rightQuery = useQuery({
    queryKey: ["cli-runs", rightId],
    queryFn: () => client.getCliRun(rightId),
    enabled: rightId.length > 0,
    retry: false,
  });

  if (leftQuery.isPending || rightQuery.isPending) {
    return <p className="px-6 py-8 text-sm text-muted">正在对比两份报告…</p>;
  }
  if (leftQuery.isError || rightQuery.isError || !leftQuery.data || !rightQuery.data) {
    const down =
      isHostUnreachableError(leftQuery.error) || isHostUnreachableError(rightQuery.error);
    return (
      <div className="px-6 py-8">
        <EmptyState
          title={down ? HOST_DOWN_TITLE : "无法对比这两份报告"}
          hint={down ? HOST_DOWN_HINT : "确认两条 run 都还在本机 CLI 库里。"}
        />
      </div>
    );
  }

  const leftParsed = parseReviewReport(leftQuery.data.markdown);
  const rightParsed = parseReviewReport(rightQuery.data.markdown);
  if (!leftParsed || !rightParsed) {
    return (
      <div className="px-6 py-8">
        <EmptyState title="其中一份不是审查报告" hint="对比只支持 Autonomous Review Report。" />
      </div>
    );
  }

  const diff = diffFindings(flattenFindings(leftParsed), flattenFindings(rightParsed));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8 sm:px-8">
      <p className="text-sm text-muted">
        <Link to="/reports" className="text-accent hover:underline">
          ← CLI 报告
        </Link>
      </p>
      <header>
        <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
          Same PR · Jury diff
        </p>
        <h1 className="font-display mt-2 text-2xl text-parchment">同 PR 审查对比</h1>
        <p className="mt-2 text-sm text-muted">{leftQuery.data.title}</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        <RunCard
          label="A"
          runId={leftQuery.data.runId}
          startedAt={leftQuery.data.startedAt}
          verdict={leftParsed.verdict}
        />
        <RunCard
          label="B"
          runId={rightQuery.data.runId}
          startedAt={rightQuery.data.startedAt}
          verdict={rightParsed.verdict}
        />
      </div>
      <DiffBlock
        title={`只在 A（${diff.onlyA.length}）`}
        items={diff.onlyA}
        empty="没有只属于 A 的发现。"
      />
      <DiffBlock
        title={`只在 B（${diff.onlyB.length}）`}
        items={diff.onlyB}
        empty="没有只属于 B 的发现。"
      />
      <DiffBlock
        title={`两边都有（${diff.both.length}）`}
        items={diff.both.map((pair) => pair.a)}
        empty="没有相同指纹的发现。"
      />
    </div>
  );
}

function RunCard({
  label,
  runId,
  startedAt,
  verdict,
}: {
  label: string;
  runId: string;
  startedAt: string | null;
  verdict: string | null;
}) {
  return (
    <Link
      to={`/reports/${runId}`}
      className="block border border-edge bg-surface px-4 py-3 hover:border-accent"
    >
      <p className="font-command text-[0.62rem] text-brass">{label}</p>
      <p className="mt-1 font-mono text-xs text-fg">{runId}</p>
      <p className="mt-1 text-xs text-muted">
        {startedAt ? new Date(startedAt).toLocaleString() : "—"}
      </p>
      {verdict ? <p className="mt-2 font-command text-xs text-parchment">{verdict}</p> : null}
    </Link>
  );
}

function DiffBlock({
  title,
  items,
  empty,
}: {
  title: string;
  items: Array<{ severity: string; qualifier: string; text: string; section: string }>;
  empty: string;
}) {
  return (
    <section>
      <h2 className="font-display text-xl text-parchment">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={`${item.section}-${item.severity}-${item.text.slice(0, 48)}`}
              className="border border-edge bg-surface px-4 py-3"
            >
              <div className="mb-1 flex flex-wrap gap-1.5">
                <StatusPill tone="muted" text={item.section} />
                {item.severity ? (
                  <StatusPill
                    tone={
                      item.severity === "major" || item.severity === "critical" ? "error" : "warn"
                    }
                    text={item.severity}
                  />
                ) : null}
                {item.qualifier ? <StatusPill tone="muted" text={item.qualifier} /> : null}
              </div>
              <SafeMarkdown className="text-sm" variant="document" content={item.text} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
