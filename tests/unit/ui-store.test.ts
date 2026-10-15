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

  it("opens the sidebar when window is absent", async () => {
    const { useUIStore } = await loadStore();

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it("starts with the sidebar closed when the viewport is narrower than 768", async () => {
    vi.stubGlobal("window", { innerWidth: 767 });
    const { useUIStore } = await loadStore();

    expect(useUIStore.getState().sidebarOpen).toBe(false);
  });

  it("starts with the sidebar open when the viewport is exactly 768", async () => {
    vi.stubGlobal("window", { innerWidth: 768 });
    const { useUIStore } = await loadStore();

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it("toggles and sets the sidebar", async () => {
    const { useUIStore } = await loadStore();

    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(false);

    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(true);

    useUIStore.getState().setSidebarOpen(false);
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    useUIStore.getState().setSidebarOpen(true);
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });
});
