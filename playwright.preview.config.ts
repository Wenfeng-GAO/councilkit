import { defineConfig, devices } from "@playwright/test";

/**
 * Isolated Vite preview for UI layout tests. Does not bind or reuse 43127.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "finding-ledger-layout.spec.ts",
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4179",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
