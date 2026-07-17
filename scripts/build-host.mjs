import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

/**
 * Production Host build: single-file esbuild bundle plus the watchdog child
 * program (kept as a standalone dependency-free file the bundle spawns).
 * Vite is dev-only and stays external — production never imports it.
 */
await mkdir("dist-host", { recursive: true });

await build({
  entryPoints: ["runtime-host/main.ts"],
  outfile: "dist-host/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  define: {
    __COUNCILKIT_BUILD_MODE__: '"production"',
  },
  alias: {
    "@shared": new URL("../shared", import.meta.url).pathname,
    "@host": new URL("../runtime-host", import.meta.url).pathname,
  },
  external: ["vite", "@vitejs/plugin-react", "fsevents", "lightningcss"],
  banner: {
    js: "// CouncilKit Runtime Host — production bundle (Node.js 22).",
  },
});

await copyFile("runtime-host/process/watchdog-child.mjs", "dist-host/watchdog-child.mjs");

console.log("dist-host/main.mjs + watchdog-child.mjs built");
