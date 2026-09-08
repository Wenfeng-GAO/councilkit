import { StartIdeateForm } from "@/components/report/StartIdeateForm";
import { cliRunNeedsPoll, cliRunStatusPill } from "@/lib/cli-run-status";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import "@/styles/reports-workspace.css";

export function IdeatePage() {
  const { client } = getAppRuntime();
  const query = useQuery({
    queryKey: ["cli-runs"],
    queryFn: () => client.listCliRuns(),
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.runs.some(
        (run) => run.kind === "ideate" && cliRunNeedsPoll(run.status, run.pipeline),
      )
        ? 2000
        : false,
  });
  const recent = (query.data?.runs ?? []).filter((run) => run.kind === "ideate").slice(0, 5);
  return (
    <div className="ck-reports-workspace">
      <header className="ck-reports-header">
        <div>
          <p className="ck-eyebrow">COUNCILKIT / IDEATE</p>
          <h1>产品创意</h1>
          <p className="ck-reports-description">
            从一个想法开始，让产品、工程与质疑席共同明确方向、范围和验证计划。
          </p>
        </div>
        <a className="ck-header-link" href="#ideate-history">
          最近讨论 <span aria-hidden>↓</span>
        </a>
      </header>
      <StartIdeateForm />
      <section
        id="ideate-history"
        className="ck-report-library"
        aria-labelledby="ideate-history-heading"
      >
        <div className="ck-library-heading">
          <h2 id="ideate-history-heading">最近的创意讨论</h2>
          <Link to="/reports" className="ck-text-button">
            全部报告 ↗
          </Link>
        </div>
        {query.isPending ? (
          <p className="text-sm text-muted">正在读取讨论记录…</p>
        ) : query.isError ? (
          <p className="text-sm text-warn">
            讨论记录读取失败。
            <button type="button" className="ml-2 underline" onClick={() => void query.refetch()}>
              重新读取
            </button>
          </p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-muted">还没有创意讨论。填写上面的想法，开始第一次讨论。</p>
        ) : (
          <ul className="ck-run-list">
            {recent.map((run) => (
              <li key={run.runId}>
                <Link to={`/reports/${run.runId}`} className="ck-run-row">
                  <div className="ck-run-row-top">
                    <p className="min-w-0 break-words text-fg">{run.title}</p>
                    <span className="shrink-0 text-xs text-muted">
                      {cliRunStatusPill(run.kind, run.status).text}
                    </span>
                  </div>
                  <div className="ck-run-meta">
                    <code>{run.runId}</code>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
