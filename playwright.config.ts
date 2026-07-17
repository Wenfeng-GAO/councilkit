import { defineConfig, devices } from "@playwright/test";

/**
 * V1 supports Chromium only (see docs/plans/2026-07-17-001 Runtime Host cutover).
 * E2E specs arrive with Stage C (U6); this config pins the supported browser,
 * the canonical origin and the production Host boot from the start.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:43127",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
