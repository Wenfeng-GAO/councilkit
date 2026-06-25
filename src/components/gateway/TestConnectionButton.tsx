import { Button } from "@/components/ui/Button";
import type { TestStatus } from "@/stores/gateways";
import type { GatewayErrorKind } from "@/types";

interface TestConnectionButtonProps {
  status: TestStatus;
  failedKind?: GatewayErrorKind;
  onClick: () => void;
}

/**
 * 4 态测试连接按钮：idle / testing / success / failed。
 * failed-fatal 与 failed-other 复用同一外观，文案「重试测试」。
 * 颜色非唯一信号：success/failure 由文案区分。
 */
export function TestConnectionButton({ status, failedKind, onClick }: TestConnectionButtonProps) {
  // 切测试连接需 ≥ h-10 触摸目标（UI-SPEC spacing exceptions）。
  const className = "px-3 py-2 rounded text-sm";

  if (status === "testing") {
    return (
      <Button variant="ghost" className={className} disabled onClick={onClick}>
        测试中…
      </Button>
    );
  }
  if (status === "success") {
    return (
      <Button
        variant="ghost"
        className={`${className} bg-success/10 text-success border border-success`}
        disabled
        onClick={onClick}
      >
        已连接
      </Button>
    );
  }
  if (status === "failed-fatal" || status === "failed-other") {
    const ariaLabel =
      failedKind === "invalid_key" ? "重试测试（密钥无效）" : "重试测试（连接失败）";
    return (
      <Button
        variant="ghost"
        className={`${className} bg-error/10 text-error border border-error`}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        重试测试
      </Button>
    );
  }
  return (
    <Button variant="ghost" className={className} onClick={onClick}>
      测试连接
    </Button>
  );
}
