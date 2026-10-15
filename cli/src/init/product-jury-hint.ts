import { findExecutable } from "../auto/driver-commands";
import { cliLang } from "../cli-locale";
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

/** Designer-locked CK-1 copy (2026-10-16 reject of #311). Tool names come from detection. */
export function missingProductJuryMessage(
  councilRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (councilRef !== PRODUCT_JURY_COUNCIL_NAME) {
    return `no council "${councilRef}"`;
  }
  const found = ideateClisOnPath(env);
  if (found.length >= 2) {
    return cliLang(env) === "zh"
      ? "还没有产品创意审查团。运行 `councilkit init`。"
      : 'no council "product-jury". Run: councilkit init';
  }
  return productJuryNeedsTwoMessage(found, env);
}

export function productJuryNeedsTwoMessage(
  found: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const zh = cliLang(env) === "zh";
  const others = IDEATE_CLIS.filter((name) => !found.includes(name));
  if (found.length === 0) {
    return zh
      ? "产品创意需要至少两个 AI 工具，现在一个都没找到。装好并登录 grok、kimi 或 codex 中的任意两个，然后运行 `councilkit init`。"
      : "Product ideation needs at least two AI CLIs; found none. Install and log in to any two of grok, kimi, or codex, then run `councilkit init`.";
  }
  if (found.length === 1) {
    const only = found[0] ?? "kimi";
    if (zh) {
      const alt = others.join(" 或 ");
      return `产品创意需要至少两个 AI 工具，现在只找到 ${only}。再装好并登录 ${alt} 中的一个，然后运行 \`councilkit init\`。`;
    }
    const alt = others.join(" or ");
    return `Product ideation needs at least two AI CLIs; found only ${only}. Install and log in to ${alt}, then run \`councilkit init\`.`;
  }
  // found.length >= 2 is handled by the caller; keep a safe fallback.
  return zh
    ? "还没有产品创意审查团。运行 `councilkit init`。"
    : 'no council "product-jury". Run: councilkit init';
}

export function initNextHints(opts: {
  hasPrJury: boolean;
  hasProductJury: boolean;
  ideateFound: string[];
  env?: NodeJS.ProcessEnv;
}): string {
  const parts: string[] = [];
  if (opts.hasPrJury) parts.push(NEXT_REVIEW_HINT);
  if (opts.hasProductJury) {
    parts.push(NEXT_IDEATE_HINT);
  } else {
    parts.push(productJuryNeedsTwoMessage(opts.ideateFound, opts.env));
  }
  return parts.join(" · ");
}

export { PR_JURY_COUNCIL_NAME, PRODUCT_JURY_COUNCIL_NAME };
