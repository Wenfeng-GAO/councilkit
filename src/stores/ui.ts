import { create } from "zustand";

export type ViewMode = "timeline" | "columns";

interface UIState {
  sidebarOpen: boolean;
  viewMode: ViewMode;
  currentRoomId: string | null;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  setCurrentRoom: (id: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: typeof window === "undefined" ? true : window.innerWidth >= 768,
  viewMode: "timeline",
  currentRoomId: null,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setCurrentRoom: (id) => set({ currentRoomId: id }),
}));
