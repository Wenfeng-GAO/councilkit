import { TestConnectionButton } from "@/components/gateway/TestConnectionButton";
import { StatusPill } from "@/components/shared/StatusPill";
import type { Gateway } from "@/models";
import type { TestStatus } from "@/stores/gateways";
import type { GatewayErrorKind } from "@/types";

interface GatewayCardProps {
  gateway: Gateway;
  status: TestStatus;
  failedKind?: GatewayErrorKind;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}

const MONO_STYLE: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
};

export function GatewayCard({
  gateway,
  status,
  failedKind,
  onEdit,
  onDelete,
  onTest,
}: GatewayCardProps) {
  const typeLabel = gateway.type === "anthropic" ? "Anthropic" : "OpenAI 兼容";

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEdit();
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: 卡片含内部 action 按钮（编辑/删除/测试），<button> 外层会形成嵌套 interactive 内容；用 div+role+tabIndex 维持 Enter→编辑 a11y 行为（UI-SPEC keyboard）。
    <div
      role="button"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex items-center justify-between rounded border border-edge bg-surface px-4 py-3 hover:border-accent focus:outline-none focus:border-accent"
    >
      <div className="flex flex-1 items-center gap-3 overflow-hidden">
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white"
          aria-hidden="true"
        >
          {gateway.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-fg">{gateway.name}</span>
            <StatusPill tone="muted" text={typeLabel} />
          </div>
          <div className="flex flex-col gap-0.5 text-xs text-muted">
            <span style={MONO_STYLE}>{gateway.baseUrl}</span>
            <span>{gateway.defaultModel}</span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <TestConnectionButton status={status} failedKind={failedKind} onClick={onTest} />
        <button type="button" onClick={onEdit} className="text-sm text-muted hover:text-fg">
          编辑网关
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-sm text-error hover:opacity-80"
          aria-label={`删除网关 ${gateway.name}`}
        >
          删除
        </button>
      </div>
    </div>
  );
}
