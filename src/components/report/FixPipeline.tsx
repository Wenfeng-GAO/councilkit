import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { Button } from "@/components/ui/Button";
import { RuntimeClientError } from "@/runtime/client";
import type { CliRunDetailResponse, CliRunPipelineDto } from "@shared/runtime/schemas";
import { Link } from "react-router-dom";

const STEPS: Array<{ phase: CliRunPipelineDto["phase"]; label: string }> = [
  { phase: "planning", label: "起草方案" },
  { phase: "plan-review", label: "方案陪审" },
  { phase: "plan-aggregating", label: "锁定共识" },
  { phase: "applying", label: "落地" },
  { phase: "re-reviewing", label: "复审" },
  { phase: "done", label: "完成" },
];

const PHASE_HINT: Record<CliRunPipelineDto["phase"], string> = {
  planning: "正在起草修复方案",
  "plan-review": "陪审团正在审查方案（不改代码）",
  "plan-aggregating": "正在汇总成共识方案",
  applying: "正在按共识方案改代码并 push",
  "re-reviewing": "正在复审改完后的 PR",
  done: "修复流程已结束",
};

export function FixPipeline({
  run,
  busy,
  pendingAction,
  error,
  onFix,
  onReReview,
}: {
  run: CliRunDetailResponse;
  busy: boolean;
  pendingAction: "fix" | "re-review" | null;
  error: string | null;
  onFix: () => void;
  onReReview: () => void;
}) {
  const pipeline = run.pipeline;
  const inFlight =
    busy || run.status === "running" || (pipeline !== null && pipeline.phase !== "done");
  const canAct = run.kind === "review" && run.hasReport && !inFlight;
  const followUp = pipeline?.followUpRunId ?? null;
  const failed =
    pipeline?.applyStatus === "failure" ||
    (pipeline?.phase === "done" && Boolean(pipeline.summary?.includes("failed")));
  const liveHint = liveStatusText({
    busy,
    pendingAction,
    pipeline,
    error,
    failed,
  });

  return (
    <section className="border border-edge bg-surface px-4 py-4">
      <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">修复闭环</p>
      <dl className="mt-3 grid gap-3 text-sm leading-6 text-muted sm:grid-cols-2">
        <div>
          <dt className="font-command text-[0.62rem] uppercase tracking-[0.12em] text-brass">
            立即修复
          </dt>
          <dd className="mt-1">
            按这份报告起草方案 → 陪审团审方案 → 达成一致后只落地第一个未落地集群（一刀一 SHA）并
            push → 对照账本增量复审。全程可能要几十分钟，请留在此页。
          </dd>
        </div>
        <div>
          <dt className="font-command text-[0.62rem] uppercase tracking-[0.12em] text-brass">
            只再审一遍
          </dt>
          <dd className="mt-1">
            不再改代码，对照这份报告的 Finding 账本重新审查当前 PR（closed / 回归 /
            新洞）。用来确认上次落地是否真把洞堵住了。「立即修复」成功后会自动做这一步。
          </dd>
        </div>
      </dl>
      {pipeline ? <PipelineSteps pipeline={pipeline} /> : null}
      {liveHint ? (
        <p
          className={`mt-3 text-sm ${
            liveHint.tone === "error"
              ? "text-error"
              : liveHint.tone === "success"
                ? "text-success"
                : "text-info"
          }`}
        >
          {liveHint.text}
        </p>
      ) : null}
      {pipeline?.planVerdict === "changes-requested" && pipeline.phase === "done" ? (
        <p className="mt-2 text-sm text-warn">
          方案未达成一致，没有改代码。可以改完方案后再点「立即修复」。
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onFix} disabled={!canAct}>
          {inFlight && pendingAction !== "re-review" ? "修复进行中…" : "立即修复"}
        </Button>
        <Button variant="ghost" onClick={onReReview} disabled={!canAct}>
          {inFlight && pendingAction === "re-review" ? "复审启动中…" : "只再审一遍（不改代码）"}
        </Button>
        {followUp ? (
          <Link
            to={`/reports/${followUp}`}
            className="inline-flex items-center rounded px-3 py-2 text-sm text-accent hover:underline"
          >
            打开复审报告
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function liveStatusText(input: {
  busy: boolean;
  pendingAction: "fix" | "re-review" | null;
  pipeline: CliRunPipelineDto | null;
  error: string | null;
  failed: boolean;
}): { tone: "info" | "error" | "success"; text: string } | null {
  if (input.error) return { tone: "error", text: input.error };
  if (input.busy) {
    return {
      tone: "info",
      text:
        input.pendingAction === "re-review"
          ? "已接到指令，正在启动复审…"
          : "已接到指令，正在启动修复。先探测模型，大约一分钟内会看到步骤往前走。",
    };
  }
  const pipeline = input.pipeline;
  if (pipeline && pipeline.phase !== "done") {
    return {
      tone: "info",
      text: `${PHASE_HINT[pipeline.phase]}${pipeline.summary ? ` · ${pipeline.summary}` : ""}。进度每 2 秒刷新。`,
    };
  }
  if (input.failed) {
    return {
      tone: "error",
      text: pipeline?.summary
        ? `修复没有完成：${pipeline.summary}`
        : "修复没有完成。可以再点一次「立即修复」。",
    };
  }
  if (pipeline?.applyStatus === "success") {
    return { tone: "success", text: pipeline.summary ?? "已按共识方案落地。" };
  }
  if (pipeline?.summary) return { tone: "info", text: pipeline.summary };
  return null;
}

export function FixPlanDocument({
  markdown,
  truncated,
}: {
  markdown: string;
  truncated: boolean;
}) {
  if (markdown.trim().length === 0) return null;
  return (
    <section className="border border-edge bg-surface px-5 py-5 sm:px-7 sm:py-6">
      <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
        共识修复方案
      </p>
      {truncated ? <p className="mt-2 text-sm text-warn">方案超过 2MB，已截断显示。</p> : null}
      <article className="ck-doc mt-4">
        <SafeMarkdown variant="document" content={markdown} />
      </article>
    </section>
  );
}

function PipelineSteps({ pipeline }: { pipeline: CliRunPipelineDto }) {
  const current = stepIndex(pipeline.phase);
  return (
    <ol className="mt-4 flex flex-wrap gap-2">
      {STEPS.map((step, index) => {
        const reached = current >= index;
        const active =
          step.phase === pipeline.phase || (pipeline.phase === "done" && step.phase === "done");
        return (
          <li
            key={step.phase}
            className={`rounded border px-2 py-1 font-command text-[0.68rem] ${
              active
                ? "border-accent text-accent"
                : reached
                  ? "border-edge text-fg"
                  : "border-edge text-muted"
            }`}
          >
            {String(index + 1).padStart(2, "0")} {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function stepIndex(phase: CliRunPipelineDto["phase"]): number {
  const found = STEPS.findIndex((step) => step.phase === phase);
  return found < 0 ? 0 : found;
}

export function formatCliActionError(error: unknown): string {
  if (error instanceof RuntimeClientError) {
    if (error.status === 409) return "这条 run 已有进行中的修复或审查。";
    if (error.status === 404 || error.status === 405) {
      return "Host 还没有加载修复接口。请重启 `pnpm dev` / `pnpm start` 后再点立即修复。";
    }
    if (error.status === 403) return `没有权限启动修复（${error.message}）。`;
    if (error.status === 500) {
      return `${error.message || "无法启动 councilkit"}。可先确认已 pnpm build:cli，并重启 Host。`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "启动失败";
}
