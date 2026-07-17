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
}

export function ControlBanner({ state, notice }: ControlBannerProps) {
  const display = STATE_DISPLAY[state ?? "acquiring"];
  return (
    <div
      className={`flex flex-wrap items-center gap-2 border-b px-6 py-2 text-sm ${display.toneClass}`}
      data-testid="control-banner"
      data-control-state={state ?? "acquiring"}
    >
      <span aria-hidden="true">{display.icon}</span>
      <span>{display.label}</span>
      {notice ? (
        <span className="rounded border border-current px-2 py-0.5 text-xs">{notice}</span>
      ) : null}
    </div>
  );
}
