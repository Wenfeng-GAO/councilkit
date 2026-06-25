interface StatusPillProps {
  tone: "muted" | "info" | "success" | "error" | "warn";
  text: string;
  className?: string;
}

const TONE_CLASSES: Record<StatusPillProps["tone"], string> = {
  muted: "bg-surface-2 text-muted border border-edge",
  info: "bg-info/10 text-info border border-info",
  success: "bg-success/10 text-success border border-success",
  error: "bg-error/10 text-error border border-error",
  warn: "bg-warn/10 text-warn border border-warn",
};

/**
 * 通用状态 pill。颜色不作为唯一信号：调用方需自行在 text 中携带含义文字
 * （如「密钥无效」「已连接」），并按 a11y 需要补 ⚠ 等前缀。
 */
export function StatusPill({ tone, text, className = "" }: StatusPillProps) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs leading-snug ${TONE_CLASSES[tone]} ${className}`}
    >
      {text}
    </span>
  );
}
