import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/Button";
import type { HealthResponse } from "@shared/runtime/schemas";

/**
 * Settings section 1 — Host (U6). Online: hostInstanceId + Node version.
 * Unavailable (page already loaded): the plan row "本地执行服务已断开" with the
 * single repair action 查看重启说明.
 */
export interface HostSectionProps {
  /** null = probe in flight; false = Host unreachable. */
  hostOnline: boolean | null;
  health: HealthResponse | undefined;
  onShowRestartHelp: () => void;
}

export function HostSection({ hostOnline, health, onShowRestartHelp }: HostSectionProps) {
  return (
    <section aria-labelledby="settings-host" className="flex flex-col gap-3">
      <div>
        <h2 id="settings-host" className="text-base font-semibold">
          1. Host
        </h2>
        <p className="mt-1 text-sm text-muted">
          本地执行服务（Runtime Host）是唯一的模型执行边界；浏览器不直连任何模型端点。
        </p>
      </div>

      {hostOnline === null ? (
        <StatusPill tone="info" text="正在检查本地执行服务…" className="self-start" />
      ) : hostOnline && health ? (
        <div className="flex flex-col gap-1 rounded border border-edge bg-surface px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <StatusPill tone="success" text="本地执行服务在线" />
          </div>
          <p className="break-all text-xs text-muted">
            Host 实例：{health.hostInstanceId} · Node {health.node.version}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded border border-error bg-surface px-3 py-2 text-sm">
          <StatusPill tone="error" text="本地执行服务已断开，禁止新执行" className="self-start" />
          <p className="text-xs text-muted">
            页面已加载但无法连接 Runtime Host；修复前不能创建或继续任何讨论执行。
          </p>
          <div>
            <Button variant="ghost" onClick={onShowRestartHelp}>
              查看重启说明
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
