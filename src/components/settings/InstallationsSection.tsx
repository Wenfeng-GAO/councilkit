import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/Button";
import type { DriverSectionItem, InstallationSectionItem } from "@/runtime/readiness";
import type { DriverId } from "@shared/runtime/contracts";
import { driverCapabilityView, driverDisplayName, installationStateView } from "./view-model";

/**
 * Settings section 2 — Installations / 登录能力 (U6). Each row shows the exact
 * InstallationState / DriverCapabilityState vocabulary plus the Readiness
 * table's single repair action.
 */
export interface InstallationsSectionProps {
  hostOnline: boolean;
  installations: InstallationSectionItem[];
  drivers: DriverSectionItem[];
  isLoading: boolean;
  /** Installation id currently being revalidated (disables its button). */
  revalidatingId: string | null;
  driversRechecking: boolean;
  onRevalidate: (installationId: string) => void;
  onShowRequirements: () => void;
  onRecheckDrivers: () => void;
  onShowDiagnostics: (driverId: DriverId) => void;
}

export function InstallationsSection({
  hostOnline,
  installations,
  drivers,
  isLoading,
  revalidatingId,
  driversRechecking,
  onRevalidate,
  onShowRequirements,
  onRecheckDrivers,
  onShowDiagnostics,
}: InstallationsSectionProps) {
  return (
    <section aria-labelledby="settings-installations" className="flex flex-col gap-3">
      <div>
        <h2 id="settings-installations" className="text-base font-semibold">
          2. Installations / 登录能力
        </h2>
        <p className="mt-1 text-sm text-muted">
          Runtime Installation 是 Host 本机发现并验证的程序安装；登录由 CLI 自己管理，CouncilKit
          不读取或保存任何凭据。
        </p>
      </div>

      {!hostOnline ? (
        <p className="text-sm text-muted">本地执行服务不可用，无法读取 Installation 列表。</p>
      ) : isLoading ? (
        <StatusPill tone="info" text="正在读取 Installation…" className="self-start" />
      ) : (
        <>
          {installations.length === 0 ? (
            <div className="flex flex-col gap-2 rounded border border-edge bg-surface px-3 py-2 text-sm">
              <p className="text-fg">尚未发现任何 Installation</p>
              <p className="text-xs text-muted">
                Installation 只能由 Host 在本机发现并经路径/指纹验证后才能使用。
              </p>
              <div>
                <Button variant="ghost" onClick={onShowRequirements}>
                  查看安装/路径要求
                </Button>
              </div>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {installations.map((item) => {
                const view = installationStateView(item.status);
                return (
                  <li
                    key={item.installationId}
                    className="flex flex-col gap-1 rounded border border-edge bg-surface px-3 py-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">
                        {driverDisplayName(item.driverId)}
                      </span>
                      <StatusPill tone={view.tone} text={view.label} />
                    </div>
                    <p className="break-all text-xs text-muted">
                      Installation：{item.installationId}
                    </p>
                    {item.detail ? (
                      <p className="break-words text-xs text-muted">{item.detail}</p>
                    ) : null}
                    {item.action === "revalidate" ? (
                      <div>
                        <Button
                          variant="ghost"
                          disabled={revalidatingId === item.installationId}
                          onClick={() => onRevalidate(item.installationId)}
                        >
                          {revalidatingId === item.installationId ? "正在重新验证…" : "重新验证"}
                        </Button>
                      </div>
                    ) : null}
                    {item.action === "install-requirements" ? (
                      <div>
                        <Button variant="ghost" onClick={onShowRequirements}>
                          查看安装/路径要求
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-1 flex flex-col gap-2">
            <h3 className="text-sm font-medium text-fg">Driver 登录与协议能力</h3>
            <ul className="flex flex-col gap-2">
              {drivers.map((item) => {
                const view = driverCapabilityView(item.status);
                return (
                  <li
                    key={item.driverId}
                    className="flex flex-col gap-1 rounded border border-edge bg-surface px-3 py-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">
                        {driverDisplayName(item.driverId)}
                      </span>
                      <StatusPill tone={view.tone} text={view.label} />
                    </div>
                    {item.action === "wait" ? (
                      <p className="text-xs text-muted">正在检查登录与协议，请稍候…</p>
                    ) : null}
                    {item.action === "cli-login" ? (
                      <div className="flex flex-col gap-1">
                        <p className="text-xs text-muted">
                          本地 CLI 尚未登录；请先在终端完成登录，然后重新检查。
                        </p>
                        <div>
                          <Button
                            variant="ghost"
                            disabled={driversRechecking}
                            onClick={onRecheckDrivers}
                          >
                            {driversRechecking ? "正在重新检查…" : "在终端登录后重新检查"}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {item.action === "driver-diagnostics" ? (
                      <div>
                        <Button variant="ghost" onClick={() => onShowDiagnostics(item.driverId)}>
                          查看诊断/更新 CLI
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
