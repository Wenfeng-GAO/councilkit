/**
 * Isolated git worktrees of a local clone, used as review Attempt cwd so
 * drivers do not each clone the PR themselves.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { errors } from "../errors";
import { type TrustedRoot, assertWithinRoot, revalidateTrustedRoot } from "../fs-safe";
import { type RunCommand, defaultRunCommand } from "./checkout-pr";

const FETCH_REF_PREFIX = "refs/councilkit/fetch";
const BRANCH_RE = /^(?![-.])[A-Za-z0-9._/\-]+$/;

export async function gitRevParse(
  repo: string,
  ref: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const result = await runCommand({
    executable: "git",
    argv: ["rev-parse", "--verify", ref],
    cwd: repo,
    env,
  });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

/** Fetch a remote branch into a unique ref so concurrent reviews cannot share FETCH_HEAD. */
export async function fetchRefExclusive(opts: {
  repo: string;
  branch: string;
  runCommand: RunCommand;
  env: NodeJS.ProcessEnv;
  expectedSha?: string;
}): Promise<string> {
  const branch = opts.branch.replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
  if (!BRANCH_RE.test(branch)) {
    throw errors.runFailed(`refusing to fetch unusable branch "${opts.branch}"`);
  }
  const destRef = `${FETCH_REF_PREFIX}/${randomUUID()}`;
  const fetched = await opts.runCommand({
    executable: "git",
    argv: ["fetch", "origin", `+${branch}:${destRef}`, "--update-head-ok"],
    cwd: opts.repo,
    env: opts.env,
    timeoutMs: 5 * 60 * 1000,
  });
  if (fetched.exitCode !== 0) {
    throw errors.runFailed(
      `git fetch origin ${branch} failed; refusing to review a stale local ref`,
    );
  }
  const sha = await gitRevParse(opts.repo, destRef, opts.runCommand, opts.env);
  await opts.runCommand({
    executable: "git",
    argv: ["update-ref", "-d", destRef],
    cwd: opts.repo,
    env: opts.env,
  });
  if (sha === null) {
    throw errors.usage(`branch "${branch}" was fetched but the exclusive ref is not a usable SHA`);
  }
  if (opts.expectedSha && opts.expectedSha.toLowerCase() !== sha.toLowerCase()) {
    throw errors.runFailed(
      `fetched ${branch} SHA ${sha} does not match the expected PR head ${opts.expectedSha}`,
    );
  }
  return sha;
}

export async function resolveLocalPrSha(opts: {
  repo: string;
  branch: string;
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
  /** Tests: skip fetch and use this ref (usually HEAD). */
  pinnedRef?: string;
  expectedSha?: string;
}): Promise<string> {
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const env = opts.env ?? process.env;
  if (opts.pinnedRef !== undefined && opts.pinnedRef.length > 0) {
    const pinned = await gitRevParse(opts.repo, opts.pinnedRef, runCommand, env);
    if (pinned === null) {
      throw errors.runFailed(`cannot resolve worktree ref "${opts.pinnedRef}"`);
    }
    return pinned;
  }
  return fetchRefExclusive({
    repo: opts.repo,
    branch: opts.branch,
    runCommand,
    env,
    expectedSha: opts.expectedSha,
  });
}

export async function addDetachedWorktree(opts: {
  repo: string;
  dest: string;
  sha: string;
  runDir: string;
  root: TrustedRoot;
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const env = opts.env ?? process.env;
  revalidateTrustedRoot(opts.root);
  assertWithinRoot(opts.root, opts.dest);
  await removeWorktreeIfPresent(opts);
  const added = await runCommand({
    executable: "git",
    argv: ["worktree", "add", "--detach", opts.dest, opts.sha],
    cwd: opts.repo,
    env,
  });
  if (added.exitCode !== 0 || added.error !== undefined) {
    throw errors.io(`git worktree add failed: ${(added.stderr || added.error || "exit").trim()}`);
  }
}

export async function removeWorktreeIfPresent(opts: {
  repo: string;
  dest: string;
  runDir: string;
  root: TrustedRoot;
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const env = opts.env ?? process.env;
  revalidateTrustedRoot(opts.root);
  assertWithinRoot(opts.root, opts.dest);
  if (!existsSync(opts.dest)) {
    await runCommand({
      executable: "git",
      argv: ["worktree", "prune"],
      cwd: opts.repo,
      env,
    });
    return;
  }
  const stat = lstatSync(opts.dest);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw errors.io("the workspace path is not a real directory (refusing to remove it)");
  }
  await runCommand({
    executable: "git",
    argv: ["worktree", "remove", "--force", opts.dest],
    cwd: opts.repo,
    env,
  });
  await runCommand({
    executable: "git",
    argv: ["worktree", "prune"],
    cwd: opts.repo,
    env,
  });
  if (existsSync(opts.dest)) {
    rmSync(opts.dest, { recursive: true, force: true });
  }
}
