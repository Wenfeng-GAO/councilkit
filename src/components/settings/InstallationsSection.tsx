import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/Button";
import type { DriverSectionItem, InstallationSectionItem } from "@/runtime/readiness";
import type { CliState, DriverId } from "@shared/runtime/contracts";
import type { DriverDescriptor } from "@shared/runtime/schemas";
import { Link } from "react-router-dom";
import {
  AI_TOOL_BINS,
  AI_TOOL_ORDER,
  AI_TOOL_SHORT_NAMES,
  aiToolActionLabel,
  cliStateFromCapability,
  cliStateView,
  driverDisplayName,
  installationStateView,
} from "./view-model";

/**
 * Settings section 2 — 「本机 AI 工具」 (U6 / #274). One row per driver, one
 * cliState tag, one copyable fix line, one action. Installation ID and
 * protocol details live in a per-row 「详情」 disclosure. The section id stays
 * `settings-installations` so pause-reason hash-scroll keeps working.
 */
export interface InstallationsSectionProps {
  hostOnline: boolean;
  installations: InstallationSectionItem[];
  drivers: DriverSectionItem[];
  /** Health `drivers` (cliState + fixCommand). Falls back to `drivers`. */
  cliDrivers?: DriverDescriptor[];
  isLoading: boolean;
  /** Installation id currently being revalidated (disables its button). */
  revalidatingId: string | null;
  /** 「全部重新检查」 in flight (every row is being re-probed). */
  driversRechecking: boolean;
  /** Rows whose own 「重新检查」 is in flight (#321: only that row). */
  recheckingDriverIds?: ReadonlySet<DriverId>;
  onRevalidate: (installationId: string) => void;
  onShowRequirements: () => void;
  onRecheckDriver: (driverId: DriverId) => void;
  onShowDiagnostics: (driverId: DriverId) => void;
  rediscovering?: boolean;
  onRediscover?: () => void;
}

/** A copyable command. Never wraps mid-command (#318); a command wider than
 * the row scrolls inside its chip instead. */
function Copyable({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="inline-block max-w-full cursor-pointer overflow-x-auto whitespace-nowrap rounded bg-surface-2 px-1 align-bottom font-mono text-[13px] text-fg"
      title="复制"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
      }}
    >
      {text}
    </button>
  );
}

function FixLine({
  driverId,
  state,
  fixCommand,
}: {
  driverId: DriverId;
  state: CliState;
  fixCommand: string;
}) {
  const bin = AI_TOOL_BINS[driverId];
  const login = fixCommand || `${bin} login`;
  const version = fixCommand || `${bin} --version`;
  switch (state) {
    case "ready":
      return <p>可以直接用</p>;
    case "not_logged_in":
      return (
        <p>
          在终端运行 <Copyable text={login} />
          ，完成后点「重新检查」
        </p>
      );
    case "checking":
      return <p>正在试连一次（超过 15 秒会给出结论）</p>;
    case "check_failed":
      return (
        <p>
          检查没成功。在终端运行 <Copyable text={version} /> 看看，或点「重新检查」
        </p>
      );
    case "not_installed":
      if (driverId === "cursor-stream-json") {
        const install = fixCommand || "curl https://cursor.com/install -fsS | bash";
        return (
          <p>
            安装：
            <Copyable text={install} />
            ，再 <Copyable text="cursor-agent login" />
            。装好后点「重新检查」
          </p>
        );
      }
      return (
        <p>
          PATH 上找不到 <Copyable text={bin} />
          。装好后点「重新检查」
        </p>
      );
  }
}

function resolveCliState(
  driverId: DriverId,
  cliDrivers: DriverDescriptor[],
  drivers: DriverSectionItem[],
): { cliState: CliState; fixCommand: string } {
  const health = cliDrivers.find((row) => row.driverId === driverId);
  if (health?.cliState) {
    return { cliState: health.cliState, fixCommand: health.fixCommand };
  }
  const capability = drivers.find((row) => row.driverId === driverId);
  if (capability) {
    return { cliState: cliStateFromCapability(capability.status), fixCommand: "" };
  }
  return { cliState: "checking", fixCommand: "" };
}

export function InstallationsSection({
  hostOnline,
  installations,
  drivers,
  cliDrivers = [],
  isLoading,
  revalidatingId,
  driversRechecking,
  recheckingDriverIds,
  onRevalidate,
  onShowRequirements,
  onRecheckDriver,
  onShowDiagnostics,
  rediscovering = false,
  onRediscover,
}: InstallationsSectionProps) {
  const rows = AI_TOOL_ORDER.map((driverId) => {
    const { cliState, fixCommand } = resolveCliState(driverId, cliDrivers, drivers);
    return {
      driverId,
      cliState,
      fixCommand,
      installations: installations.filter((item) => item.driverId === driverId),
    };
  });

  return (
    <section aria-labelledby="settings-installations" className="flex flex-col gap-3">
      <div>
        <h2 id="settings-installations" className="text-2xl font-semibold">
          本机 AI 工具
        </h2>
        <p className="mt-1 text-sm text-muted">
          CouncilKit 只调用你电脑上已登录的命令行工具，不读取、不保存密钥。至少需要 1 个「就绪」。
        </p>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted"
        aria-label="状态图例"
      >
        <span className="inline-flex items-center gap-1">
          <StatusPill tone="success" text="就绪" /> 可以直接用
        </span>
        <span className="inline-flex items-center gap-1">
          <StatusPill tone="warn" text="未登录" /> 已安装，需要登录
        </span>
        <span className="inline-flex items-center gap-1">
          <StatusPill tone="muted" text="未安装" /> 本机没有这个命令
        </span>
        <span className="inline-flex items-center gap-1">
          <StatusPill tone="info" text="检查中" /> 最多 15 秒
        </span>
        <span className="inline-flex items-center gap-1">
          <StatusPill tone="error" text="检查失败" /> 点「重新检查」再试
        </span>
      </div>

      {!hostOnline ? (
        <p className="text-sm text-muted">本地执行服务不可用，无法读取本机 AI 工具状态。</p>
      ) : isLoading ? (
        <StatusPill tone="info" text="正在读取本机 AI 工具…" className="self-start" />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const view = cliStateView(row.cliState);
              const action = aiToolActionLabel(row.cliState);
              const checking = row.cliState === "checking";
              const rowRechecking =
                driversRechecking || (recheckingDriverIds?.has(row.driverId) ?? false);
              return (
                <li
                  key={row.driverId}
                  data-cli-tool={AI_TOOL_BINS[row.driverId]}
                  className="flex flex-col gap-2 rounded border border-edge bg-surface px-4 py-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                    <div className="w-44 shrink-0 text-[15px] font-semibold text-fg">
                      {AI_TOOL_SHORT_NAMES[row.driverId]}{" "}
                      <span className="text-sm font-normal text-muted">
                        {AI_TOOL_BINS[row.driverId]}
                      </span>
                    </div>
                    <div className="w-24 shrink-0" data-cli-state-pill>
                      <StatusPill tone={view.tone} text={view.label} />
                    </div>
                    <div className="min-w-0 flex-1 text-[13px] text-muted">
                      <FixLine
                        driverId={row.driverId}
                        state={row.cliState}
                        fixCommand={row.fixCommand}
                      />
                    </div>
                    <div className="shrink-0">
                      {row.cliState === "ready" ? (
                        <Link
                          to="/settings#settings-agents"
                          className="inline-flex items-center justify-center rounded border border-edge px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2"
                        >
                          {action}
                        </Link>
                      ) : (
                        <Button
                          variant="ghost"
                          disabled={checking || rowRechecking}
                          onClick={() => onRecheckDriver(row.driverId)}
                        >
                          {rowRechecking && !checking ? "正在重新检查…" : action}
                        </Button>
                      )}
                    </div>
                  </div>
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer select-none">详情</summary>
                    <div className="mt-2 flex flex-col gap-1">
                      <p>Driver：{driverDisplayName(row.driverId)}</p>
                      {row.installations.length === 0 ? (
                        <p>尚未发现 Installation。</p>
                      ) : (
                        row.installations.map((item) => {
                          const instView = installationStateView(item.status);
                          return (
                            <div key={item.installationId} className="flex flex-col gap-1">
                              <p className="break-all">
                                Installation：{item.installationId}{" "}
                                <StatusPill tone={instView.tone} text={instView.label} />
                              </p>
                              {item.detail ? <p className="break-words">{item.detail}</p> : null}
                              {item.action === "revalidate" ? (
                                <div>
                                  <Button
                                    variant="ghost"
                                    disabled={revalidatingId === item.installationId}
                                    onClick={() => onRevalidate(item.installationId)}
                                  >
                                    {revalidatingId === item.installationId
                                      ? "正在重新验证…"
                                      : "重新验证"}
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
                            </div>
                          );
                        })
                      )}
                      {row.cliState === "check_failed" ? (
                        <div>
                          <Button variant="ghost" onClick={() => onShowDiagnostics(row.driverId)}>
                            查看诊断/更新 CLI
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>

          <div className="flex items-center gap-4 rounded border border-edge bg-surface px-4 py-3">
            <p className="text-sm text-muted">
              没有任何就绪工具？也可以先 <b>看示例</b>（内置示例 AI，不需要账号）。
            </p>
            <Link
              to="/"
              className="ml-auto inline-flex shrink-0 items-center justify-center rounded border border-edge px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2"
            >
              先看示例
            </Link>
          </div>

          {onRediscover ? (
            <div>
              <Button variant="ghost" disabled={rediscovering} onClick={onRediscover}>
                {rediscovering ? "正在重新发现…" : "重新发现本机 CLI"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
