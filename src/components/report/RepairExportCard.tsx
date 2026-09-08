import { Button } from "@/components/ui/Button";
import { buildRepairPackage, repairExportCommand } from "@shared/runtime/repair-package";
import { canExportRepairPackage } from "@shared/runtime/review-case";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { useState } from "react";

export function RepairExportCard({ run }: { run: CliRunDetailResponse }) {
  const [clusterId, setClusterId] = useState("");
  const [message, setMessage] = useState("");
  if (run.kind !== "review") return null;
  let explanation = "";
  let count = 0;
  try {
    if (run.hasPlanLock && !run.planLock)
      throw new Error("plan.lock.json 无法读取，请先恢复完整方案。");
    const task = buildRepairPackage({
      runId: run.runId,
      complete: canExportRepairPackage(run),
      prUrl: run.reviewEvidence?.prUrl ?? null,
      ledger: { runId: run.runId, sha: run.reviewEvidence?.sha ?? null, findings: run.findings },
      planLock: run.planLock,
      clusterId: clusterId || undefined,
      findingGroups: run.findingGroups ?? null,
    });
    count = task.findings.length;
  } catch (error) {
    explanation = error instanceof Error ? error.message : "修复证据尚未就绪";
  }
  const command = repairExportCommand(run.runId, clusterId || undefined);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setMessage("已复制导出命令");
    } catch {
      setMessage("未能复制，请手动选择下方命令。");
    }
  };
  return (
    <section
      className="rounded border border-edge bg-surface px-4 py-3"
      aria-label="外部 Squad 修复任务"
    >
      <h2 className="text-sm font-semibold text-fg">交给外部 Squad 修复</h2>
      <p className="mt-1 text-xs text-muted">
        任务包保留问题身份、原始证据、范围和验收。执行导出命令后，将 JSON 文件交给 Squad。
      </p>
      {run.planLock?.clusters.length ? (
        <label className="mt-3 flex items-center gap-2 text-sm text-muted">
          范围
          <select
            className="rounded border border-edge bg-surface px-2 py-1 text-fg"
            value={clusterId}
            onChange={(event) => {
              setClusterId(event.target.value);
              setMessage("");
            }}
          >
            <option value="">全部未关闭问题</option>
            {run.planLock.clusters.map((cluster) => (
              <option key={cluster.id} value={cluster.id}>
                {cluster.id} · {cluster.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {explanation ? (
        <p className="mt-2 text-xs text-warn">{explanation}</p>
      ) : (
        <>
          <code className="mt-3 block overflow-x-auto whitespace-pre rounded bg-canvas px-3 py-2 text-xs text-fg">
            {command}
          </code>
          <div className="mt-2 flex items-center gap-3">
            <Button variant="ghost" onClick={() => void copy()}>
              复制导出命令（{count} 项）
            </Button>
            <output className="text-xs text-muted">{message}</output>
          </div>
        </>
      )}
    </section>
  );
}
