import { defineConfig, devices } from "@playwright/test";

/**
 * V1 supports Chromium only (see docs/plans/2026-07-17-001 Runtime Host cutover).
 * E2E specs arrive with Stage C (U6); this config pins the supported browser,
 * the canonical origin and the production Host boot from the start.
 */
/**
 * Isolated Web Host port. Defaults to the canonical 43127; set
 * COUNCILKIT_E2E_PORT to run the suite against a throwaway port without
 * sharing (or killing) a developer-hosted canonical Host.
 */
const e2ePort = (() => {
  const raw = process.env.COUNCILKIT_E2E_PORT;
  if (raw === undefined || raw === "") return 43127;
  // Strict integer: "45907" is a port, "45907x" is a typo and must fail.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`COUNCILKIT_E2E_PORT must be a valid TCP port, got "${raw}"`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`COUNCILKIT_E2E_PORT must be a valid TCP port, got "${raw}"`);
  }
  return port;
})();
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: e2eOrigin,
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
    env: { ...process.env, COUNCILKIT_E2E: "1", COUNCILKIT_PORT: String(e2ePort) },
    url: `${e2eOrigin}/api/v1/health`,
    reuseExistingServer: !process.env.CI && process.env.COUNCILKIT_E2E_PORT === undefined,
    timeout: 180_000,
  },
});
