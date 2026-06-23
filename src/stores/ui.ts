import { create } from "zustand";

export type ViewMode = "timeline" | "columns";

interface UIState {
  sidebarOpen: boolean;
  viewMode: ViewMode;
  currentRoomId: string | null;
  toggleSidebar: () => void;
  setViewMode: (mode: ViewMode) => void;
  setCurrentRoom: (id: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  viewMode: "timeline",
  currentRoomId: null,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setViewMode: (mode) => set({ viewMode: mode }),
  setCurrentRoom: (id) => set({ currentRoomId: id }),
}));
