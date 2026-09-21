import { defineConfig, devices } from "@playwright/test";

/**
 * Real Vite React UI smoke for the repair panel. Does not bind or reuse 43127.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "repair-panel-ui.spec.ts",
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4188",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4188 --strictPort",
    url: "http://127.0.0.1:4188",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
