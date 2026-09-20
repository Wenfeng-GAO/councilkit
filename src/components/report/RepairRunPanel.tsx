import { Button } from "@/components/ui/Button";
import { isRepairProfileName } from "@shared/runtime/repair-name";
import type { CliRunDetailResponse, CliRunSummaryDto } from "@shared/runtime/schemas";
import { useState } from "react";
import { Link } from "react-router-dom";

export interface RepairProfileSummary {
  name: string;
  prUrl: string;
  sourceBranch: string;
  base: string;
}

export function readRepairLaunchSummary(
  data: FormData,
): { ok: true; name: string; sourceBranch: string; base: string } | { ok: false; error: string } {
  const name = String(data.get("name") ?? "default").trim() || "default";
  const sourceBranch = String(data.get("sourceBranch") ?? "").trim();
  const base = String(data.get("base") ?? "").trim();
  if (!isRepairProfileName(name)) {
    return { ok: false, error: "profile 名必须是不含路径的短名" };
  }
  if (!sourceBranch) {
    return { ok: false, error: "请填写源分支（本 PR 的 head 分支）" };
  }
  if (!base) {
    return { ok: false, error: "请填写目标分支（本 PR 的 base 分支）" };
  }
  return { ok: true, name, sourceBranch, base };
}

function hintSourceLabel(source: "pr" | "review" | "worktree"): string {
  if (source === "pr") return "已从当前 PR 识别";
  if (source === "worktree") return "已从本地仓库 worktree 识别";
  return "已从本次审查冻结上下文识别";
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
  sourceBranchDefault = "",
  baseDefault = "",
  hintSource = null,
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
  sourceBranchDefault?: string;
  baseDefault?: string;
  hintSource?: "pr" | "review" | "worktree" | null;
  onStart?: (profile: string) => void;
  onStop?: () => void;
  onResume?: () => void;
  onSaveProfile?: (input: { name: string; sourceBranch: string; base: string }) => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
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
          key={`${sourceBranchDefault}|${baseDefault}`}
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = readRepairLaunchSummary(new FormData(event.currentTarget));
            if (!parsed.ok) {
              setFormError(parsed.error);
              return;
            }
            setFormError(null);
            onSaveProfile?.(parsed);
          }}
        >
          <p className="text-sm text-muted">
            还没有保存的修复授权。源分支和目标分支来自 PR 身份，不是 PR 地址。
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted">profile 名</span>
            <input
              name="name"
              defaultValue="default"
              aria-label="profile 名"
              autoComplete="off"
              className="rounded border border-edge bg-canvas px-2 py-1 text-sm"
            />
            <span className="text-xs text-muted">本机授权短名，一般保持 default。</span>
          </label>
          {sourceBranchDefault && baseDefault ? (
            <div className="rounded border border-edge bg-canvas px-3 py-2">
              <p className="text-sm text-fg">
                {hintSource ? `${hintSourceLabel(hintSource)}：` : "已识别："}源分支{" "}
                <code>{sourceBranchDefault}</code>，目标分支 <code>{baseDefault}</code>
              </p>
              <p className="mt-1 text-xs text-muted">保存后只允许快进推送到该源分支。</p>
              <input type="hidden" name="sourceBranch" value={sourceBranchDefault} />
              <input type="hidden" name="base" value={baseDefault} />
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-muted">源分支</span>
                <input
                  name="sourceBranch"
                  defaultValue={sourceBranchDefault}
                  placeholder="本 PR 的 head 分支"
                  aria-label="源分支"
                  required
                  autoComplete="off"
                  className="rounded border border-edge bg-canvas px-2 py-1 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-sm text-muted">目标分支</span>
                <input
                  name="base"
                  defaultValue={baseDefault}
                  placeholder="本 PR 的 base 分支"
                  aria-label="目标分支"
                  required
                  autoComplete="off"
                  className="rounded border border-edge bg-canvas px-2 py-1 text-sm"
                />
              </label>
            </>
          )}
          {formError ? <p className="text-sm text-error">{formError}</p> : null}
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
