import { defineConfig, devices } from "@playwright/test";

/**
 * Squad repair observability E2E — isolated from 43127 and repair-ui smoke.
 * Chromium only; workers=1; retries=0; strictPort 43837; no reuse.
 */
export default defineConfig({
  testDir: "./tests/e2e/repair-observability",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/repair-observability/results.json" }],
  ],
  outputDir: "test-results/repair-observability/artifacts",
  use: {
    baseURL: "http://127.0.0.1:43837",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      "pnpm build && pnpm exec tsx tests/e2e/repair-observability/host-entry.mts",
    env: { ...process.env, COUNCILKIT_E2E: "1" },
    url: "http://127.0.0.1:43837/api/v1/health",
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
