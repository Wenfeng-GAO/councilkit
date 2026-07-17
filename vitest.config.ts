import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/host/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    // Host/process tests bind the canonical port and spawn child processes:
    // serialize files (maxForks=1) while keeping one fresh fork per file so
    // global mocks in legacy unit tests cannot leak across files.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@host": fileURLToPath(new URL("./runtime-host", import.meta.url)),
    },
  },
});
