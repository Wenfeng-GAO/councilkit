import type { RoundErrorSummary } from "@/lib/round-errors";
import { useEffect, useState } from "react";

interface ErrorBannerProps {
  summary: RoundErrorSummary | null;
  onDismiss: () => void;
}

/**
 * 顶部 round-level 错误汇总 banner（D-10）。
 *
 * 3 主态 + dismissible：
 *   - allOfflineNoSummary → warn「本轮无有效发言，未生成总结。」（D-12）
 *   - summaryFailed → warn「总结生成失败：{msg}」
 *   - fatalGateways 任意 → error「网关「{name}」已离线：密钥无效。该网关下 {N} 个 agent 本轮已跳过。」
 *   - recoverableCount > 0 → warn「{N} 个 agent 本轮出错（限流 / 上游 / 超时 / 网络），其余 agent 继续。」
 *
 * 多类错误可同时展示（fatal 行 + recoverable 行 + summaryFailed 行）。
 * 每轮 summary 变化重置 visible（新一轮自动弹回）。
 *
 * a11y: role="alert" —— 屏幕阅读器插入即播报；× 关闭 aria-label="关闭"。
 */
export function ErrorBanner({ summary, onDismiss }: ErrorBannerProps) {
  const [visible, setVisible] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 对 summary 引用变化触发重置可见，无需 setVisible 依赖
  useEffect(() => {
    // summary 变化（新一轮或新错误聚合）→ 自动弹回可见。
    setVisible(true);
  }, [summary]);

  if (!summary || !visible) return null;

  const lines: { tone: "error" | "warn"; text: string }[] = [];

  if (summary.allOfflineNoSummary) {
    lines.push({ tone: "warn", text: "本轮无有效发言，未生成总结。" });
  }
  if (summary.summaryFailed) {
    lines.push({ tone: "warn", text: `总结生成失败：${summary.summaryFailed.message}` });
  }
  for (const gw of summary.fatalGateways) {
    lines.push({
      tone: "error",
      text: `网关「${gw.gatewayName}」已离线：密钥无效。该网关下 ${gw.agentCount} 个 agent 本轮已跳过。`,
    });
  }
  if (summary.recoverableCount > 0) {
    lines.push({
      tone: "warn",
      text: `${summary.recoverableCount} 个 agent 本轮出错（限流 / 上游 / 超时 / 网络），其余 agent 继续。`,
    });
  }

  if (lines.length === 0) return null;

  // 整体基调：含 fatal 行 → error；否则 warn。
  const hasFatal = lines.some((l) => l.tone === "error");
  const containerTone = hasFatal ? "error" : "warn";
  const containerClass =
    containerTone === "error"
      ? "border border-error bg-error/10 text-fg"
      : "border border-warn bg-warn/10 text-fg";

  const handleDismiss = () => {
    setVisible(false);
    onDismiss();
  };

  return (
    <div
      role="alert"
      className={`mx-auto max-w-3xl rounded p-3 text-sm ${containerClass}`}
      data-testid="error-banner"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          {lines.map((line, i) => (
            <p key={`line-${i}-${line.tone}`} className="leading-snug">
              {line.text}
            </p>
          ))}
        </div>
        <button
          type="button"
          aria-label="关闭"
          onClick={handleDismiss}
          className="shrink-0 text-muted hover:text-fg"
        >
          ×
        </button>
      </div>
    </div>
  );
}
