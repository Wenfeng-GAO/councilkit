import { Button } from "@/components/ui/Button";
import type { ControlState } from "@/orchestrator/discussion-orchestrator";

/**
 * Control banner (U6): the page's Scope Controller state, always with a text
 * label and a distinct icon glyph — never color alone.
 */

const STATE_DISPLAY: Record<ControlState, { icon: string; label: string; toneClass: string }> = {
  acquiring: {
    icon: "⟳",
    label: "正在取得控制权…",
    toneClass: "border-edge bg-surface-2 text-muted",
  },
  controlling: {
    icon: "✓",
    label: "当前页面拥有控制权",
    toneClass: "border-success bg-success/10 text-success",
  },
  observing: {
    icon: "◉",
    label: "只读观察中（另一页面正在控制）",
    toneClass: "border-info bg-info/10 text-info",
  },
  "lost-control": {
    icon: "⚠",
    label: "控制权已丢失（已被其他页面接管）",
    toneClass: "border-warn bg-warn/10 text-warn",
  },
  takeover_failed: {
    icon: "✕",
    label: "接管失败（Host 拒绝了控制转移）",
    toneClass: "border-error bg-error/10 text-error",
  },
};

interface ControlBannerProps {
  /** Undefined before the Orchestrator first reports → shown as acquiring. */
  state: ControlState | undefined;
  /** Transient transition notice (e.g. 已取得控制权), auto-dismissed by the page. */
  notice?: string | null;
  /** S8：当前控制者 controllerId 前缀（最新非 closed binding 的 controllerId 前
   * 8 位）。全控制态都显示——observing 时辨识对方 tab，controlling 时辨识自己。
   * R1：旧 tab banner 不会自动翻转，此前缀正是为这类多 tab 场景提供可辨识性。 */
  controllerId?: string | null;
  /** S8：observing 态「取得控制权」点击回调（Web Lock steal + 重跑 controlRoom）。 */
  onTakeover?: () => void;
  /** S8：「取得控制权」进行中（steal + 重跑 controlRoom 期间禁用按钮）。 */
  takeoverPending?: boolean;
}

/** 控制者前缀：取 controllerId 前 8 位，同 controller 多 tab 可辨。null/空 → 不显示。 */
function controllerPrefix(controllerId: string | null | undefined): string | null {
  if (!controllerId) return null;
  const head = controllerId.slice(0, 8);
  return head.length > 0 ? `控制者 #${head}` : null;
}

export function ControlBanner({
  state,
  notice,
  controllerId,
  onTakeover,
  takeoverPending,
}: ControlBannerProps) {
  const display = STATE_DISPLAY[state ?? "acquiring"];
  const prefix = controllerPrefix(controllerId);
  // 前缀在全控制态都显示：observing 辨识对方、controlling 辨识自己、lost-control
  // 仍可看出「被谁接管」。acquiring/takeover_failed 时无意义不显示。
  const showPrefix = prefix && state !== "acquiring" && state !== undefined;
  return (
    <div
      className={`flex flex-wrap items-center gap-2 border-b px-6 py-2 text-sm ${display.toneClass}`}
      data-testid="control-banner"
      data-control-state={state ?? "acquiring"}
    >
      <span aria-hidden="true">{display.icon}</span>
      <span>{display.label}</span>
      {showPrefix ? (
        <span
          data-testid="controller-id"
          className="rounded border border-current px-2 py-0.5 text-xs font-mono"
        >
          {prefix}
        </span>
      ) : null}
      {notice ? (
        <span className="rounded border border-current px-2 py-0.5 text-xs">{notice}</span>
      ) : null}
      {state === "observing" && onTakeover ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onTakeover}
          disabled={takeoverPending}
          className="ml-auto"
        >
          {takeoverPending ? "正在取得控制权…" : "取得控制权"}
        </Button>
      ) : null}
      {state === "takeover_failed" ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-xs">
            请确认 Host 在线（设置页 Host 段可重启）后，刷新页面重试接管。
          </span>
          <Button type="button" variant="ghost" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
        </div>
      ) : null}
    </div>
  );
}
