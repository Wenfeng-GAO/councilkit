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
const nodeGate = resolve(here, "../dist/node-gate.mjs");

if (!existsSync(bundle)) {
  process.stderr.write(
    "councilkit CLI is not built. Run `pnpm build:cli` (from the repo root) first.\n",
  );
  process.exit(2);
}

// NPX-03b: refuse an unsupported Node BEFORE help or any command loads. The
// gate is a separate tiny bundle of shared/runtime/node-gate.ts (the one copy
// the Host uses too), so nothing in the main bundle runs on old Node.
if (existsSync(nodeGate)) {
  const { enforceSupportedNode } = await import(nodeGate);
  enforceSupportedNode(process.version);
}

await import(bundle);
