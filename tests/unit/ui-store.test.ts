import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * UI shell store. The initial sidebar flag is chosen once, when the module
 * evaluates: open when there is no window, and open on viewports >= 768.
 * Each case re-imports the module so that choice is observable.
 */

async function loadStore() {
  return import("@/stores/ui");
}

describe("useUIStore", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("opens the sidebar, uses the timeline, and selects no room when window is absent", async () => {
    const { useUIStore } = await loadStore();

    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().viewMode).toBe("timeline");
    expect(useUIStore.getState().currentRoomId).toBe(null);
  });

  it("starts with the sidebar closed when the viewport is narrower than 768", async () => {
    vi.stubGlobal("window", { innerWidth: 767 });
    const { useUIStore } = await loadStore();

    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().viewMode).toBe("timeline");
    expect(useUIStore.getState().currentRoomId).toBe(null);
  });

  it("starts with the sidebar open when the viewport is exactly 768", async () => {
    vi.stubGlobal("window", { innerWidth: 768 });
    const { useUIStore } = await loadStore();

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it("toggles the sidebar, sets the view, and tracks the current room", async () => {
    const { useUIStore } = await loadStore();

    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().viewMode).toBe("timeline");
    expect(useUIStore.getState().currentRoomId).toBe(null);

    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(true);

    useUIStore.getState().setSidebarOpen(false);
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    useUIStore.getState().setSidebarOpen(true);
    expect(useUIStore.getState().sidebarOpen).toBe(true);

    useUIStore.getState().setViewMode("columns");
    expect(useUIStore.getState().viewMode).toBe("columns");
    expect(useUIStore.getState().sidebarOpen).toBe(true);

    useUIStore.getState().setViewMode("timeline");
    expect(useUIStore.getState().viewMode).toBe("timeline");

    useUIStore.getState().setCurrentRoom("room-7");
    expect(useUIStore.getState().currentRoomId).toBe("room-7");
    expect(useUIStore.getState().viewMode).toBe("timeline");

    useUIStore.getState().setCurrentRoom(null);
    expect(useUIStore.getState().currentRoomId).toBe(null);
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().viewMode).toBe("timeline");
  });
});
