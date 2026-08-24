/**
 * Checkout a PR into an isolated empty directory, then push the current branch.
 * Used by `councilkit apply`. Never shells out; argv is passed to spawn.
 */
import { spawn } from "node:child_process";
import { parseAntCodePrUrl, parseApplyPrUrl, parseGitHubPrUrl } from "@shared/runtime/pr-url";
import { errors } from "../errors";
import { findExecutable, resolveExecutable } from "./driver-commands";

export { parseAntCodePrUrl, parseApplyPrUrl, parseGitHubPrUrl };

export interface RunCommandInput {
  executable: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export type RunCommand = (input: RunCommandInput) => Promise<RunCommandResult>;

export interface CheckedOutPr {
  prUrl: string;
  host: "github" | "antcode";
  branch: string;
  cloneUrl: string;
}

const DEFAULT_CMD_TIMEOUT_MS = 5 * 60 * 1000;
const BRANCH_RE = /^(?![-.])[A-Za-z0-9._/\-]+$/;
const GH_JSON_FIELDS = "headRefName,headRepository,headRepositoryOwner,isCrossRepository,url";

/** Env for internal CLIs (antcode): strip proxies on that one command only. */
export function internalToolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    NO_PROXY: "*",
    no_proxy: "*",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    https_proxy: "",
    http_proxy: "",
  };
}

export async function defaultRunCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const executable = input.executable.includes("/")
    ? input.executable
    : resolveExecutable(input.executable);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RunCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, input.argv, {
        cwd: input.cwd,
        env: input.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        stdout: "",
        stderr: "",
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 1 * 1024 * 1024) stderr = stderr.slice(-512 * 1024);
    });
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      finish({
        stdout,
        stderr,
        exitCode: null,
        error: `timed out after ${input.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS}ms`,
      });
    }, input.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS);
    timeout.unref?.();
    child.on("error", (error) => {
      clearTimeout(timeout);
      finish({
        stdout,
        stderr,
        exitCode: null,
        error: error.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      finish({ stdout, stderr, exitCode: code });
    });
  });
}

/** Read PR metadata without cloning. Used by review worktrees. */
export async function inspectPullRequest(
  prUrl: string,
  runCommand: RunCommand = defaultRunCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckedOutPr> {
  const parsed = parseApplyPrUrl(prUrl);
  if (parsed === null) {
    throw errors.usage(`review/apply only supports GitHub or AntCode PR URLs, got "${prUrl}"`);
  }
  if (parsed.kind === "github") {
    if (findExecutable("gh", env) === null) {
      throw errors.usage("GitHub PRs need `gh` on PATH to resolve the source branch");
    }
    const view = await runCommand({
      executable: "gh",
      argv: ["pr", "view", parsed.url.toString(), "--json", GH_JSON_FIELDS],
      cwd: process.cwd(),
      env,
    });
    assertOk(view, "gh pr view");
    const meta = parseGhPrView(view.stdout);
    return {
      prUrl: parsed.url.toString(),
      host: "github",
      branch: meta.branch,
      cloneUrl: meta.nameWithOwner,
    };
  }
  if (findExecutable("antcode", env) === null) {
    throw errors.usage("AntCode PRs need `antcode` on PATH to resolve the source branch");
  }
  const ant = parseAntCodePrUrl(parsed.url);
  if (ant === null) {
    throw errors.usage(`could not parse AntCode PR URL: ${parsed.url.toString()}`);
  }
  const shown = await runCommand({
    executable: "antcode",
    argv: ["pr", "show", ant.iid, "-P", ant.project, "--json", "--raw", "--no-pager"],
    cwd: process.cwd(),
    env: internalToolEnv(env),
  });
  assertOk(shown, "antcode pr show");
  const meta = parseAntCodePrShow(shown.stdout);
  return {
    prUrl: parsed.url.toString(),
    host: "antcode",
    branch: meta.branch,
    cloneUrl: meta.cloneUrl,
  };
}

export async function checkoutPullRequest(
  prUrl: string,
  cwd: string,
  runCommand: RunCommand = defaultRunCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckedOutPr> {
  const parsed = parseApplyPrUrl(prUrl);
  if (parsed === null) {
    throw errors.usage(`apply only supports GitHub or AntCode PR URLs, got "${prUrl}"`);
  }
  if (parsed.kind === "github") {
    return checkoutGitHub(parsed.url, cwd, runCommand, env);
  }
  return checkoutAntCode(parsed.url, cwd, runCommand, env);
}

async function checkoutGitHub(
  url: URL,
  cwd: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
): Promise<CheckedOutPr> {
  if (findExecutable("gh", env) === null) {
    throw errors.usage("GitHub apply needs `gh` on PATH");
  }
  const view = await runCommand({
    executable: "gh",
    argv: ["pr", "view", url.toString(), "--json", GH_JSON_FIELDS],
    cwd,
    env,
  });
  assertOk(view, "gh pr view");
  const meta = parseGhPrView(view.stdout);
  const clone = await runCommand({
    executable: "gh",
    argv: ["repo", "clone", meta.nameWithOwner, ".", "--", "--depth", "1"],
    cwd,
    env,
  });
  assertOk(clone, "gh repo clone");
  const checked = await runCommand({
    executable: "gh",
    argv: ["pr", "checkout", url.toString()],
    cwd,
    env,
  });
  assertOk(checked, "gh pr checkout");
  const branch = await currentBranch(cwd, runCommand, env, meta.branch);
  return {
    prUrl: url.toString(),
    host: "github",
    branch,
    cloneUrl: meta.nameWithOwner,
  };
}

async function checkoutAntCode(
  url: URL,
  cwd: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
): Promise<CheckedOutPr> {
  if (findExecutable("antcode", env) === null) {
    throw errors.usage("AntCode apply needs `antcode` on PATH");
  }
  const parsed = parseAntCodePrUrl(url);
  if (parsed === null) {
    throw errors.usage(`could not parse AntCode PR URL: ${url.toString()}`);
  }
  const shown = await runCommand({
    executable: "antcode",
    argv: ["pr", "show", parsed.iid, "-P", parsed.project, "--json", "--raw", "--no-pager"],
    cwd,
    env: internalToolEnv(env),
  });
  assertOk(shown, "antcode pr show");
  const meta = parseAntCodePrShow(shown.stdout);
  const cloned = await runCommand({
    executable: "git",
    argv: ["clone", "--depth", "1", "--branch", meta.branch, meta.cloneUrl, "."],
    cwd,
    env,
  });
  assertOk(cloned, "git clone");
  const branch = await currentBranch(cwd, runCommand, env, meta.branch);
  return {
    prUrl: url.toString(),
    host: "antcode",
    branch,
    cloneUrl: meta.cloneUrl,
  };
}

export async function currentBranch(
  cwd: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
  fallback: string,
): Promise<string> {
  const result = await runCommand({
    executable: "git",
    argv: ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
    env,
  });
  if (result.exitCode === 0) {
    const name = result.stdout.trim();
    if (BRANCH_RE.test(name)) return name;
  }
  if (!BRANCH_RE.test(fallback)) {
    throw errors.runFailed(`refusing to use unsafe branch name "${fallback}"`);
  }
  return fallback;
}

export async function gitHeadSha(
  cwd: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const result = await runCommand({
    executable: "git",
    argv: ["rev-parse", "HEAD"],
    cwd,
    env,
  });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

export async function gitWorkingTreeDirty(
  cwd: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
  ignore: readonly string[] = [],
): Promise<boolean> {
  const result = await runCommand({
    executable: "git",
    argv: ["status", "--porcelain"],
    cwd,
    env,
  });
  assertOk(result, "git status");
  const ignored = new Set(ignore);
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const path = trimmed.slice(2).trim();
    if (ignored.has(path)) continue;
    return true;
  }
  return false;
}

export async function commitLeftoverChanges(
  cwd: string,
  message: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
  exclude: readonly string[] = [],
): Promise<boolean> {
  const add = await runCommand({
    executable: "git",
    argv: ["add", "-A"],
    cwd,
    env,
  });
  assertOk(add, "git add");
  for (const path of exclude) {
    const reset = await runCommand({
      executable: "git",
      argv: ["reset", "-q", "HEAD", "--", path],
      cwd,
      env,
    });
    if (reset.exitCode !== 0 && reset.error !== undefined) {
      throw errors.runFailed(`git reset failed: ${trimCmdError(reset)}`, { phase: "apply" });
    }
  }
  const diff = await runCommand({
    executable: "git",
    argv: ["diff", "--cached", "--quiet"],
    cwd,
    env,
  });
  if (diff.exitCode === 0) return false;
  const commitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME || "councilkit",
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL || "councilkit@localhost",
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME || env.GIT_AUTHOR_NAME || "councilkit",
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL || env.GIT_AUTHOR_EMAIL || "councilkit@localhost",
  };
  const commit = await runCommand({
    executable: "git",
    argv: ["commit", "-m", message],
    cwd,
    env: commitEnv,
  });
  assertOk(commit, "git commit");
  return true;
}

export async function pushCurrentBranch(
  cwd: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const first = await runCommand({
    executable: "git",
    argv: ["push"],
    cwd,
    env,
  });
  if (first.exitCode === 0 && first.error === undefined) return;
  const upstreamMissing = /no upstream|has no upstream|set-upstream/i.test(
    `${first.stderr}\n${first.stdout}\n${first.error ?? ""}`,
  );
  if (!upstreamMissing) {
    throw errors.runFailed(`git push failed: ${trimCmdError(first)}`, { phase: "push" });
  }
  const second = await runCommand({
    executable: "git",
    argv: ["push", "-u", "origin", "HEAD"],
    cwd,
    env,
  });
  if (second.exitCode !== 0 || second.error !== undefined) {
    throw errors.runFailed(`git push failed: ${trimCmdError(second)}`, { phase: "push" });
  }
}

function parseGhPrView(stdout: string): { branch: string; nameWithOwner: string } {
  let rec: unknown;
  try {
    rec = JSON.parse(stdout);
  } catch {
    throw errors.runFailed("gh pr view did not return JSON");
  }
  if (rec === null || typeof rec !== "object") {
    throw errors.runFailed("gh pr view JSON was not an object");
  }
  const row = rec as Record<string, unknown>;
  const branch = typeof row.headRefName === "string" ? row.headRefName : "";
  if (!BRANCH_RE.test(branch)) {
    throw errors.runFailed("gh pr view did not include a usable headRefName");
  }
  const repo = row.headRepository;
  const owner = row.headRepositoryOwner;
  let nameWithOwner = "";
  if (repo !== null && typeof repo === "object") {
    const r = repo as Record<string, unknown>;
    if (typeof r.nameWithOwner === "string") nameWithOwner = r.nameWithOwner;
    else if (typeof r.name === "string" && owner !== null && typeof owner === "object") {
      const login = (owner as Record<string, unknown>).login;
      if (typeof login === "string") nameWithOwner = `${login}/${r.name}`;
    }
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(nameWithOwner)) {
    throw errors.runFailed("gh pr view did not include a usable head repository");
  }
  return { branch, nameWithOwner };
}

function parseAntCodePrShow(stdout: string): { branch: string; cloneUrl: string } {
  let rec: unknown;
  try {
    rec = JSON.parse(stdout);
  } catch {
    throw errors.runFailed("antcode pr show did not return JSON");
  }
  if (rec === null || typeof rec !== "object") {
    throw errors.runFailed("antcode pr show JSON was not an object");
  }
  const row = rec as Record<string, unknown>;
  const branch = typeof row.source_branch === "string" ? row.source_branch : "";
  if (!BRANCH_RE.test(branch)) {
    throw errors.runFailed("antcode pr show did not include a usable source_branch");
  }
  const source = row.source;
  let cloneUrl = "";
  if (source !== null && typeof source === "object") {
    const s = source as Record<string, unknown>;
    if (typeof s.ssh_url === "string" && s.ssh_url.length > 0) cloneUrl = s.ssh_url;
    else if (typeof s.http_url === "string" && s.http_url.length > 0) cloneUrl = s.http_url;
  }
  if (cloneUrl.length === 0 || /[\n\r]/.test(cloneUrl)) {
    throw errors.runFailed("antcode pr show did not include a usable clone URL");
  }
  return { branch, cloneUrl };
}

function assertOk(result: RunCommandResult, label: string): void {
  if (result.error !== undefined) {
    throw errors.runFailed(`${label} failed: ${result.error}`, { phase: "checkout" });
  }
  if (result.exitCode !== 0) {
    throw errors.runFailed(`${label} failed: ${trimCmdError(result)}`, { phase: "checkout" });
  }
}

function trimCmdError(result: RunCommandResult): string {
  const text = (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`).replace(
    /\s+/g,
    " ",
  );
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
