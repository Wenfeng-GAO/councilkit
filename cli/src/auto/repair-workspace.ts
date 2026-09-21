import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errors } from "../errors";
import { ensureHome, resolvePaths } from "../store/paths";
import { type RunCommand, defaultRunCommand } from "./checkout-pr";
import { gitRevParse } from "./git-worktree";
import { readInvocationManifest } from "./invocation-manifest";
import { isLocalRemotePath, parseRemoteRepoIdentity } from "./local-repo";
import { sourceReviewDir } from "./repair-persist";

export function isCouncilKitCheckout(cwd: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    return (
      pkg.name === "councilkit" && existsSync(join(cwd, "cli", "src", "commands", "repair.ts"))
    );
  } catch {
    return false;
  }
}

export function assertRepairWorkspace(cwd: string): void {
  if (isCouncilKitCheckout(cwd)) {
    throw errors.usage("repair workspace must not be the CouncilKit checkout");
  }
}

export function sourceRepoRealpath(sourceRunId: string): string | null {
  try {
    const manifest = readInvocationManifest(sourceReviewDir(sourceRunId), sourceRunId);
    const path = manifest?.repoRealpath;
    if (!path || !existsSync(path)) return null;
    return path;
  } catch {
    return null;
  }
}

export function resolveRepairWorkspaceCwd(input: {
  explicit?: string;
  frozen?: string | null;
  sourceRunId: string;
  runId: string;
}): string {
  if (input.explicit) {
    assertRepairWorkspace(input.explicit);
    return input.explicit;
  }
  if (input.frozen && existsSync(input.frozen)) {
    assertRepairWorkspace(input.frozen);
    return input.frozen;
  }
  const dest = join(ensureHome(), "repair-workspaces", input.runId);
  mkdirSync(join(ensureHome(), "repair-workspaces"), { recursive: true, mode: 0o700 });
  const sourceRepo = sourceRepoRealpath(input.sourceRunId);
  if (sourceRepo && !isCouncilKitCheckout(sourceRepo)) {
    if (existsSync(join(dest, ".git")) && !isCouncilKitCheckout(dest)) return dest;
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    assertRepairWorkspace(dest);
    return dest;
  }
  throw errors.usage(
    "could not freeze an isolated repair workspace; source review has no usable repoRealpath",
  );
}

export async function readRemoteUrl(
  repo: string,
  run: RunCommand,
  env: NodeJS.ProcessEnv,
  remote = "origin",
): Promise<string | null> {
  const urls = await readRemoteUrls(repo, run, env, remote);
  return urls?.fetchUrl ?? null;
}

export async function readRemoteUrls(
  repo: string,
  run: RunCommand,
  env: NodeJS.ProcessEnv,
  remote = "origin",
): Promise<{ fetchUrl: string; pushUrl: string; explicitPushUrl: string | null } | null> {
  const fetchResult = await run({
    executable: "git",
    argv: ["remote", "get-url", remote],
    cwd: repo,
    env,
  });
  if (fetchResult.exitCode !== 0) return null;
  const fetchUrl = fetchResult.stdout.trim();
  if (!fetchUrl) return null;
  const pushResult = await run({
    executable: "git",
    argv: ["remote", "get-url", "--push", remote],
    cwd: repo,
    env,
  });
  const pushUrl =
    pushResult.exitCode === 0 && pushResult.stdout.trim() ? pushResult.stdout.trim() : fetchUrl;
  const explicit = await run({
    executable: "git",
    argv: ["config", "--get", `remote.${remote}.pushurl`],
    cwd: repo,
    env,
  });
  const explicitPushUrl =
    explicit.exitCode === 0 && explicit.stdout.trim().length > 0 ? explicit.stdout.trim() : null;
  return { fetchUrl, pushUrl, explicitPushUrl };
}

export function originMatchesRepo(originUrl: string, repo: string): boolean {
  const origin = parseRemoteRepoIdentity(originUrl);
  const identity = parseRemoteRepoIdentity(repo);
  if (!origin || !identity || !origin.host || !identity.host) return false;
  return origin.host === identity.host && origin.path === identity.path;
}

export async function materializeRepairWorkspace(input: {
  dest: string;
  sourceRepo: string;
  sourceBranch: string;
  sourceSha: string;
  expectedOriginUrl?: string;
  expectedPushUrl?: string;
  expectedRepo?: string;
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  cwd: string;
  headSha: string;
  sourceRef: string;
  originUrl: string;
  fetchUrl: string;
  pushUrl: string;
}> {
  assertRepairWorkspace(input.dest);
  if (isCouncilKitCheckout(input.sourceRepo)) {
    throw errors.usage("repair workspace source must not be the CouncilKit checkout");
  }
  const run = input.runCommand ?? defaultRunCommand;
  const env = input.env ?? process.env;
  const sourceUrls = await readRemoteUrls(input.sourceRepo, run, env);
  const fetchUrl = input.expectedOriginUrl ?? sourceUrls?.fetchUrl ?? null;
  const pushUrl = input.expectedPushUrl ?? sourceUrls?.pushUrl ?? fetchUrl;
  if (!fetchUrl || !pushUrl) {
    throw errors.runFailed("source repository has no origin URL to freeze");
  }
  assertRemoteMatchesRepo(fetchUrl, input.expectedRepo);
  assertRemoteMatchesRepo(pushUrl, input.expectedRepo);
  const existing = existsSync(join(input.dest, ".git"));
  if (!existing) {
    const cloned = await run({
      executable: "git",
      argv: ["clone", "--local", "--no-hardlinks", input.sourceRepo, input.dest],
      cwd: input.sourceRepo,
      env,
    });
    if (cloned.exitCode !== 0) {
      throw errors.runFailed(`git clone of isolated repair workspace failed: ${cloned.stderr}`);
    }
    const setFetch = await run({
      executable: "git",
      argv: ["remote", "set-url", "origin", fetchUrl],
      cwd: input.dest,
      env,
    });
    if (setFetch.exitCode !== 0) {
      throw errors.runFailed("could not freeze the isolated workspace origin URL");
    }
    const setPush = await run({
      executable: "git",
      argv: ["remote", "set-url", "--push", "origin", pushUrl],
      cwd: input.dest,
      env,
    });
    if (setPush.exitCode !== 0) {
      throw errors.runFailed("could not freeze the isolated workspace push URL");
    }
    const branch = input.sourceBranch.replace(/^refs\/heads\//, "");
    const checkout = await run({
      executable: "git",
      argv: ["checkout", "-B", branch, input.sourceSha],
      cwd: input.dest,
      env,
    });
    if (checkout.exitCode !== 0) {
      throw errors.runFailed(`isolated workspace checkout failed: ${checkout.stderr}`);
    }
    const head = await gitRevParse(input.dest, "HEAD", run, env);
    if (!head || head.toLowerCase() !== input.sourceSha.toLowerCase()) {
      throw errors.runFailed("isolated workspace HEAD does not match the frozen source SHA");
    }
  }
  await assertFrozenRemoteUrls(input.dest, fetchUrl, pushUrl, run, env);
  const branch = input.sourceBranch.replace(/^refs\/heads\//, "");
  const ref = await run({
    executable: "git",
    argv: ["rev-parse", "--symbolic-full-name", `refs/heads/${branch}`],
    cwd: input.dest,
    env,
  });
  if (ref.stdout.trim() !== `refs/heads/${branch}`) {
    throw errors.runFailed("isolated workspace is missing the frozen source branch");
  }
  const head = await gitRevParse(input.dest, `refs/heads/${branch}`, run, env);
  if (!head) throw errors.runFailed("isolated workspace source ref is not a commit");
  return {
    cwd: input.dest,
    headSha: head.toLowerCase(),
    sourceRef: `refs/heads/${branch}`,
    originUrl: fetchUrl,
    fetchUrl,
    pushUrl,
  };
}

export async function assertFrozenRemoteUrls(
  repo: string,
  fetchUrl: string,
  pushUrl: string,
  run: RunCommand = defaultRunCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const actual = await readRemoteUrls(repo, run, env);
  if (!actual) throw errors.runFailed("isolated workspace is missing origin");
  if (actual.fetchUrl !== fetchUrl) {
    throw errors.runFailed("isolated workspace origin drifted from the frozen fetch URL");
  }
  if (actual.pushUrl !== pushUrl) {
    throw errors.runFailed("isolated workspace origin drifted from the frozen push URL");
  }
  if (actual.explicitPushUrl && actual.explicitPushUrl !== pushUrl) {
    throw errors.runFailed("isolated workspace pushurl drifted from the frozen push URL");
  }
}

function assertRemoteMatchesRepo(url: string, repo?: string): void {
  if (!repo || isLocalRemotePath(url)) return;
  if (!originMatchesRepo(url, repo)) {
    throw errors.runFailed("frozen origin URL does not match the repair profile repo");
  }
}

export function inspectCwdForRepair(input: {
  workspaceCwd?: string;
  sourceRunId: string;
}): string {
  if (input.workspaceCwd && existsSync(input.workspaceCwd)) return input.workspaceCwd;
  const sourceRepo = sourceRepoRealpath(input.sourceRunId);
  if (sourceRepo) return sourceRepo;
  return resolvePaths().home;
}
