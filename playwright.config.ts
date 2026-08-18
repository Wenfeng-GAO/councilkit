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
  webServer: {
    // Build the real production bundle, then boot the dedicated E2E Host
    // (tests/e2e/host-entry.mts): real runtime server + scriptable fake
    // drivers on the canonical origin.
    command: "pnpm build && pnpm exec tsx tests/e2e/host-entry.mts",
    env: { ...process.env, COUNCILKIT_E2E: "1" },
    url: "http://127.0.0.1:43127/api/v1/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
