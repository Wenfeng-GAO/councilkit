import { useUIStore } from "@/stores/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "zustand";
import { Sidebar } from "./Sidebar";

interface AppShellProps {
  children: ReactNode;
}

const NARROW_QUERY = "(max-width: 767px)";

export function AppShell({ children }: AppShellProps) {
  const { sidebarOpen, setSidebarOpen } = useStore(useUIStore);
  const [narrow, setNarrow] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(NARROW_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const sync = () => {
      setNarrow(media.matches);
      if (media.matches) setSidebarOpen(false);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [setSidebarOpen]);

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-fg">
      {narrow && sidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-black/55"
          aria-label="关闭侧边栏"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <Sidebar overlay={narrow && sidebarOpen} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
