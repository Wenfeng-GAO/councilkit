import { defineConfig, devices } from "@playwright/test";

/**
 * Isolated host for the three locked-label screenshots.
 * The default `pnpm test:e2e` server does not seed these runs, so the
 * reports-list counts in report-case-filters stay stable.
 */
const port = process.env.COUNCILKIT_TAG_E2E_PORT ?? "43991";
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /consensus-tags\.spec\.ts/,
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm exec tsx tests/e2e/host-entry.mts",
    env: {
      ...process.env,
      COUNCILKIT_E2E: "1",
      COUNCILKIT_PORT: port,
      CK_E2E_TAG_CASES: "1",
    },
    url: `${origin}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
