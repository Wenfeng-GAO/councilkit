import { findExecutable } from "../auto/driver-commands";
import { discoverCodexModel } from "../commands/jury";
import { NEXT_REVIEW_HINT, PR_JURY_COUNCIL_NAME } from "./defaults";
import { NEXT_IDEATE_HINT, PRODUCT_JURY_COUNCIL_NAME } from "./ideate-defaults";

const IDEATE_CLIS = ["grok", "kimi", "codex"] as const;

/** CLIs that can actually occupy an ideate seat (Codex needs a discovered model). */
export function ideateClisOnPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  for (const name of IDEATE_CLIS) {
    if (findExecutable(name, env) === null) continue;
    if (name === "codex" && discoverCodexModel(env) === null) continue;
    found.push(name);
  }
  return found;
}

export function canCreateProductJury(env: NodeJS.ProcessEnv = process.env): boolean {
  return ideateClisOnPath(env).length >= 2;
}

export function missingProductJuryMessage(
  councilRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (councilRef !== PRODUCT_JURY_COUNCIL_NAME) {
    return `no council "${councilRef}"`;
  }
  const found = ideateClisOnPath(env);
  if (found.length >= 2) {
    return 'no council "product-jury". Run: councilkit init';
  }
  const foundBit = found.length > 0 ? found.join(", ") : "none";
  return `no council "product-jury". product-jury needs at least two of grok, kimi, or a configured Codex (found: ${foundBit}). Install another AI CLI, then run councilkit init.`;
}

export function initNextHints(opts: {
  hasPrJury: boolean;
  hasProductJury: boolean;
  ideateFound: string[];
}): string {
  const parts: string[] = [];
  if (opts.hasPrJury) parts.push(NEXT_REVIEW_HINT);
  if (opts.hasProductJury) {
    parts.push(NEXT_IDEATE_HINT);
  } else {
    const foundBit = opts.ideateFound.length > 0 ? opts.ideateFound.join(", ") : "none";
    parts.push(
      `product-jury needs at least two of grok, kimi, or a configured Codex (found: ${foundBit}). Install another AI CLI, then re-run councilkit init.`,
    );
  }
  return parts.join(" · ");
}

export { PR_JURY_COUNCIL_NAME, PRODUCT_JURY_COUNCIL_NAME };
