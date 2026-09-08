/**
 * Frozen, colorless PR review context shared by every Attempt. Seats must not
 * each re-fetch or guess CLI flags; the snapshot is hashed once.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errors } from "../errors";
import { type RunCommand, defaultRunCommand } from "./checkout-pr";
import { fetchRefExclusive, gitRevParse } from "./git-worktree";

export const REVIEW_CONTEXT_MD = "review-context.md";
export const REVIEW_CONTEXT_DIFF = "review-context.diff";

export interface FrozenReviewContext {
  headSha: string;
  sourceRef: string;
  targetRef: string | null;
  baseSha: string | null;
  mergeBaseSha: string | null;
  diffHash: string;
  colorlessDiff: string;
  verifiedCli: string;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

export function hashColorlessDiff(diff: string): string {
  return createHash("sha256").update(stripAnsi(diff), "utf8").digest("hex");
}

export function verifiedCliUsage(host: "github" | "antcode"): string {
  if (host === "github") {
    return "gh pr diff --color=never <url>";
  }
  return "antcode pr diff <iid> -P <project> --no-pager";
}

export function formatFrozenContextMarkdown(ctx: FrozenReviewContext): string {
  const lines = [
    "# Frozen review context",
    "",
    `- head: \`${ctx.headSha}\``,
    `- source: \`${ctx.sourceRef}\``,
    `- target: \`${ctx.targetRef ?? "unknown"}\``,
    `- base: \`${ctx.baseSha ?? "unknown"}\``,
    `- merge-base: \`${ctx.mergeBaseSha ?? "unknown"}\``,
    `- colorless diff sha256: \`${ctx.diffHash}\``,
    `- verified CLI: \`${ctx.verifiedCli}\``,
    "",
    "Use `review-context.diff` in this workspace. Do not re-run `gh pr diff` or `antcode pr diff`.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function resolveFrozenTargetSha(opts: {
  repo: string;
  targetRef: string;
  runCommand: RunCommand;
  env: NodeJS.ProcessEnv;
  expectedSha?: string;
  skipRemoteFetch: boolean;
}): Promise<string> {
  if (opts.skipRemoteFetch) {
    const local = await gitRevParse(opts.repo, opts.targetRef, opts.runCommand, opts.env);
    if (local === null) {
      throw errors.runFailed(
        `cannot resolve local target ref ${opts.targetRef}; refusing a head...head empty diff`,
      );
    }
    if (opts.expectedSha && opts.expectedSha.toLowerCase() !== local.toLowerCase()) {
      throw errors.runFailed(
        `local ${opts.targetRef} SHA ${local} does not match the expected PR target ${opts.expectedSha}`,
      );
    }
    return local;
  }
  return fetchRefExclusive({
    repo: opts.repo,
    branch: opts.targetRef,
    runCommand: opts.runCommand,
    env: opts.env,
    expectedSha: opts.expectedSha,
  });
}

export async function freezeReviewContext(opts: {
  repo: string;
  headSha: string;
  sourceRef: string;
  targetRef?: string | null;
  host: "github" | "antcode";
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
  expectedTargetSha?: string;
  /** Tests: resolve targetRef locally. Production always fetches. */
  skipRemoteFetch?: boolean;
}): Promise<FrozenReviewContext> {
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const env = opts.env ?? process.env;
  const head = await gitRevParse(opts.repo, opts.headSha, runCommand, env);
  if (head === null) {
    throw errors.runFailed(`cannot resolve frozen head SHA ${opts.headSha}`);
  }
  const targetRef = opts.targetRef?.trim() ? opts.targetRef.trim() : null;
  if (targetRef === null) {
    throw errors.runFailed("target ref metadata is missing; refusing a head...head empty diff");
  }
  const baseSha = await resolveFrozenTargetSha({
    repo: opts.repo,
    targetRef,
    runCommand,
    env,
    expectedSha: opts.expectedTargetSha,
    skipRemoteFetch: opts.skipRemoteFetch === true,
  });
  const merged = await runCommand({
    executable: "git",
    argv: ["merge-base", head, baseSha],
    cwd: opts.repo,
    env,
  });
  let mergeBaseSha: string | null = null;
  if (merged.exitCode === 0) {
    const sha = merged.stdout.trim();
    mergeBaseSha = /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  }
  if (mergeBaseSha === null) {
    throw errors.runFailed(
      `cannot resolve merge-base of ${head} and ${baseSha}; refusing a head...head empty diff`,
    );
  }
  const diffed = await runCommand({
    executable: "git",
    argv: ["diff", "--no-color", "--no-ext-diff", `${mergeBaseSha}...${head}`],
    cwd: opts.repo,
    env,
  });
  if (diffed.exitCode !== 0) {
    throw errors.runFailed("git diff --no-color failed; refusing a colored or stale snapshot");
  }
  const colorlessDiff = stripAnsi(diffed.stdout);
  return {
    headSha: head,
    sourceRef: opts.sourceRef,
    targetRef,
    baseSha,
    mergeBaseSha,
    diffHash: hashColorlessDiff(colorlessDiff),
    colorlessDiff,
    verifiedCli: verifiedCliUsage(opts.host),
  };
}

export function persistFrozenContext(runDir: string, ctx: FrozenReviewContext): void {
  writeFileSync(join(runDir, REVIEW_CONTEXT_MD), formatFrozenContextMarkdown(ctx), {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(join(runDir, REVIEW_CONTEXT_DIFF), ctx.colorlessDiff, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function copyFrozenContextIntoWorkspace(runDir: string, workspace: string): void {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const name of [REVIEW_CONTEXT_MD, REVIEW_CONTEXT_DIFF]) {
    copyFileSync(join(runDir, name), join(workspace, name));
  }
}
