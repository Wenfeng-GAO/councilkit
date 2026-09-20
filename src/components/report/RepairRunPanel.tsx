import { Button } from "@/components/ui/Button";
import type { CliRunDetailResponse, CliRunSummaryDto } from "@shared/runtime/schemas";
import { Link } from "react-router-dom";

export interface RepairProfileSummary {
  name: string;
  prUrl: string;
  sourceBranch: string;
  base: string;
}

export function RepairRunPanel({
  run,
  profiles = [],
  activeRepair = null,
  bridgeAvailable = true,
  error = null,
  pending = false,
  outerUsed = 0,
  outerMax = 10,
  onStart,
  onStop,
  onResume,
  onSaveProfile,
}: {
  run: Pick<
    CliRunDetailResponse,
    "runId" | "kind" | "status" | "progress" | "businessResult" | "reasonCode" | "sourceRunId"
  >;
  profiles?: RepairProfileSummary[];
  activeRepair?: Pick<
    CliRunSummaryDto,
    "runId" | "status" | "progress" | "businessResult" | "reasonCode"
  > | null;
  bridgeAvailable?: boolean;
  error?: string | null;
  pending?: boolean;
  outerUsed?: number;
  outerMax?: number;
  onStart?: (profile: string) => void;
  onStop?: () => void;
  onResume?: () => void;
  onSaveProfile?: (input: { name: string; sourceBranch: string; base: string }) => void;
}) {
  if (run.kind === "repair") {
    const used = `第 ${outerUsed} / ${outerMax} 次外循环`;
    const budgetOut = run.businessResult === "needs_attention" && outerUsed >= outerMax;
    return (
      <section className="border border-edge bg-surface px-4 py-4" aria-label="Squad 自动修复">
        <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
          Squad 自动修复
        </p>
        <p className="mt-2 text-sm text-fg">{used}</p>
        <p className="mt-1 text-sm text-muted">
          {run.businessResult === "approved"
            ? "已准出"
            : run.businessResult === "stopped"
              ? "已停止"
              : run.businessResult === "needs_attention"
                ? `需要处理${run.reasonCode ? ` · ${run.reasonCode}` : ""}`
                : "进行中"}
        </p>
        {run.status === "running" ? (
          <Button className="mt-3" variant="ghost" onClick={() => onStop?.()} disabled={pending}>
            停止
          </Button>
        ) : null}
        {run.businessResult === "needs_attention" && run.reasonCode && !budgetOut ? (
          <Button className="mt-3" onClick={() => onResume?.()} disabled={pending}>
            从 {run.reasonCode} 恢复
          </Button>
        ) : null}
        {budgetOut ? <p className="mt-3 text-sm text-muted">预算已用尽，不能再修一次。</p> : null}
      </section>
    );
  }

  if (run.kind !== "review") return null;

  if (activeRepair) {
    return (
      <section className="border border-edge bg-surface px-4 py-4" aria-label="Squad 自动修复">
        <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
          Squad 自动修复
        </p>
        <Link
          className="mt-3 inline-flex text-sm text-accent hover:underline"
          to={`/reports/${activeRepair.runId}`}
        >
          查看自动修复
        </Link>
      </section>
    );
  }

  return (
    <section className="border border-edge bg-surface px-4 py-4" aria-label="Squad 自动修复">
      <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
        Squad 自动修复
      </p>
      {!bridgeAvailable ? (
        <p className="mt-2 text-sm text-warn">Squad 桥不可用，无法启动自动修复。</p>
      ) : null}
      {bridgeAvailable && profiles.length === 0 ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            onSaveProfile?.({
              name: String(data.get("name") ?? "default"),
              sourceBranch: String(data.get("sourceBranch") ?? ""),
              base: String(data.get("base") ?? "main"),
            });
          }}
        >
          <p className="text-sm text-muted">还没有保存的修复授权，先填启动摘要。</p>
          <input
            name="name"
            defaultValue="default"
            aria-label="profile 名"
            className="rounded border border-edge bg-canvas px-2 py-1 text-sm"
          />
          <input
            name="sourceBranch"
            placeholder="源分支"
            aria-label="源分支"
            className="rounded border border-edge bg-canvas px-2 py-1 text-sm"
          />
          <input
            name="base"
            defaultValue="main"
            aria-label="base"
            className="rounded border border-edge bg-canvas px-2 py-1 text-sm"
          />
          <Button type="submit" disabled={pending}>
            保存授权并启动
          </Button>
        </form>
      ) : null}
      {bridgeAvailable && profiles.length > 0 ? (
        <Button
          className="mt-3"
          disabled={pending}
          onClick={() => onStart?.(profiles[0]?.name ?? "default")}
        >
          Squad 自动修复
        </Button>
      ) : null}
      {error ? <p className="mt-2 text-sm text-error">{error}</p> : null}
    </section>
  );
}
