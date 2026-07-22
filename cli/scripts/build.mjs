import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * CLI production build: single-file esbuild bundle. Mirrors scripts/build-host.mjs
 * but entry/cli-specific. The bundle pulls in shared/runtime/*, zod, and the
 * reused browser runtime modules (src/runtime/client.ts + event-stream.ts) — all
 * pure Node-safe transitive deps — so the bin has no runtime TS path-alias
 * dependency.
 *
 * Paths resolve relative to this script so the build is cwd-independent (it runs
 * both as `node scripts/build.mjs` from cli/ and as `node cli/scripts/build.mjs`
 * from the repo root).
 */
const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const repoRoot = resolve(cliRoot, "..");

await mkdir(resolve(cliRoot, "dist"), { recursive: true });

await build({
  entryPoints: [resolve(cliRoot, "src/main.ts")],
  outfile: resolve(cliRoot, "dist/main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  alias: {
    "@": resolve(repoRoot, "src"),
    "@shared": resolve(repoRoot, "shared"),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});

// The launcher imports the bundle as a module (no shebang needed on the bundle
// itself), but mark it executable anyway for direct invocation.
await chmod(resolve(cliRoot, "dist/main.mjs"), 0o755);

console.log("cli/dist/main.mjs built");
