#!/usr/bin/env node
/**
 * Thin launcher for the CouncilKit CLI (D1: bin = already-committed thin
 * launcher). The real entry is the esbuild bundle at ../dist/main.mjs; this
 * file exists so a workspace bin is stable regardless of cwd/tsx/PATH. If the
 * bundle is absent it prints an actionable message instead of a cryptic
 * module-resolution error.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "../dist/main.mjs");

if (!existsSync(bundle)) {
  process.stderr.write(
    "councilkit CLI is not built. Run `pnpm build:cli` (from the repo root) first.\n",
  );
  process.exit(2);
}

await import(bundle);
