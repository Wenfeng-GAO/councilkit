import { getAppRuntime } from "@/runtime/bootstrap";
import { useUIStore } from "@/stores/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink } from "react-router-dom";
import { useStore } from "zustand";

/**
 * App sidebar (U6): navigation in domain language (首页 / 新建讨论 / 设置)
 * plus a tiny Host status indicator — dot + text label, never color-only —
 * linking to /settings where the repair actions live. The legacy 模板 (P1)
 * placeholder link was dropped; templates return post-V1.
 */
const NARROW_QUERY = "(max-width: 767px)";

export function Sidebar({ overlay = false }: { overlay?: boolean }) {
  const { sidebarOpen, toggleSidebar, setSidebarOpen } = useStore(useUIStore);
  const closeIfNarrow = () => {
    if (window.matchMedia(NARROW_QUERY).matches) setSidebarOpen(false);
  };

  if (!sidebarOpen) {
    return (
      <button
        type="button"
        onClick={toggleSidebar}
        className="flex items-start border-r border-edge px-2 pt-3 text-muted hover:text-fg"
        aria-label="展开侧边栏"
      >
        »
      </button>
    );
  }

  return (
    <aside
      className={`flex w-64 shrink-0 flex-col border-r border-edge bg-surface ${
        overlay ? "fixed inset-y-0 left-0 z-30" : ""
      }`}
    >
      <div className="flex items-center justify-between px-4 py-4">
        <span className="font-display text-sm tracking-wide text-parchment">CouncilKit</span>
        <button
          type="button"
          onClick={toggleSidebar}
          className="text-muted hover:text-fg"
          aria-label="收起侧边栏"
        >
          «
        </button>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-2">
        <NavLink
          to="/"
          className={({ isActive }) => roundedLink(isActive)}
          end
          onClick={closeIfNarrow}
        >
          首页
        </NavLink>
        <NavLink
          to="/rooms/new"
          className={({ isActive }) => roundedLink(isActive)}
          onClick={closeIfNarrow}
        >
          新建讨论
        </NavLink>
        <NavLink
          to="/reports"
          className={({ isActive }) => roundedLink(isActive)}
          onClick={closeIfNarrow}
        >
          报告
        </NavLink>
      </nav>
      <div className="border-t border-edge my-2" />
      <div className="flex flex-col gap-1 px-2">
        <NavLink
          to="/settings"
          className={({ isActive }) => roundedLink(isActive)}
          onClick={closeIfNarrow}
        >
          设置
        </NavLink>
        <HostStatusLink />
      </div>
      <p className="px-4 py-3 text-xs text-muted">local-first · 多 agent 决策</p>
    </aside>
  );
}

function HostStatusLink() {
  const { client } = getAppRuntime();
  const healthQuery = useQuery({
    queryKey: ["host", "health"],
    queryFn: () => client.health(),
    refetchInterval: 5000,
    retry: false,
  });

  const state = healthQuery.isPending
    ? { dot: "bg-muted", label: "Host 检查中…" }
    : healthQuery.isSuccess
      ? { dot: "bg-success", label: "Host 在线" }
      : { dot: "bg-error", label: "Host 离线" };

  return (
    <Link
      to="/settings"
      className="flex items-center gap-2 rounded px-3 py-2 text-xs text-muted hover:text-fg"
    >
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${state.dot}`} />
      <span>{state.label}</span>
    </Link>
  );
}

function roundedLink(isActive: boolean): string {
  return `rounded px-3 py-2 text-sm ${isActive ? "bg-accent/20 text-fg" : "text-muted hover:text-fg"}`;
}
