import { useUIStore } from "@/stores/ui";
import { NavLink } from "react-router-dom";
import { useStore } from "zustand";

export function Sidebar() {
  const { sidebarOpen, toggleSidebar } = useStore(useUIStore);

  if (!sidebarOpen) {
    return (
      <button
        type="button"
        onClick={toggleSidebar}
        className="border-r border-edge p-2 text-muted hover:text-fg"
        aria-label="展开侧边栏"
      >
        »
      </button>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-surface">
      <div className="flex items-center justify-between px-4 py-4">
        <span className="text-sm font-semibold tracking-wide">CouncilKit</span>
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
        <NavLink to="/" className={({ isActive }) => roundedLink(isActive)} end>
          主页
        </NavLink>
        <NavLink to="/rooms/new" className={({ isActive }) => roundedLink(isActive)}>
          新建房间
        </NavLink>
        <NavLink to="/templates" className={({ isActive }) => roundedLink(isActive)}>
          模板 (P1)
        </NavLink>
      </nav>
      <p className="px-4 py-3 text-xs text-muted">local-first · 多 agent 决策</p>
    </aside>
  );
}

function roundedLink(isActive: boolean): string {
  return `rounded px-3 py-2 text-sm ${isActive ? "bg-accent/20 text-fg" : "text-muted hover:text-fg"}`;
}
