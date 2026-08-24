/**
 * Map a PR URL to an already-cloned local git repo.
 *
 * Resolution order:
 *   1. `--repo <path>`
 *   2. `repos.json` entry for the PR project key
 *   3. `cwd` if it is a git repo whose remotes match the project
 *
 * A successful `--repo` is remembered in repos.json so the next review of the
 * same project does not need the flag.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { projectKeyFromPr } from "@shared/runtime/pr-url";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";
import { ensureHome, resolvePaths } from "../store/paths";
import type { RunCommand } from "./checkout-pr";

export { projectKeyFromPr };

export interface LocalRepo {
  path: string;
  project: string;
  source: "flag" | "config" | "cwd";
}

interface ReposFile {
  format: "councilkit-repos";
  version: 1;
  repos: Array<{ project: string; path: string }>;
}

/** Extract `group/project` from a git remote URL. */
export function projectFromRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/i, "");
  const scp = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (scp) return scp[2].replace(/^\/+/, "").replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function remoteMatchesProject(remote: string, project: string): boolean {
  const path = projectFromRemote(remote);
  if (path === null) return false;
  return path === project || path.endsWith(`/${project}`);
}

export function resolveGitDir(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch {
    throw errors.usage(`--repo path does not exist: ${abs}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw errors.usage("--repo must be a real directory (not a symlink)");
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw errors.usage("cannot resolve --repo path");
  }
  if (!existsSync(join(real, ".git"))) {
    throw errors.usage(`--repo is not a git checkout (missing .git): ${real}`);
  }
  return real;
}

export async function listRemotes(
  repo: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const result = await runCommand({
    executable: "git",
    argv: ["remote", "-v"],
    cwd: repo,
    env,
  });
  if (result.exitCode !== 0) return [];
  const urls: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) urls.push(parts[1]);
  }
  return urls;
}

export async function resolveLocalRepo(opts: {
  pr: string;
  repoFlag?: string;
  cwd?: string;
  runCommand: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<LocalRepo> {
  const project = projectKeyFromPr(opts.pr);
  if (project === null) {
    throw errors.usage(`cannot derive a project key from PR URL: ${opts.pr}`);
  }
  const env = opts.env ?? process.env;
  if (opts.repoFlag !== undefined && opts.repoFlag.trim().length > 0) {
    const path = resolveGitDir(opts.repoFlag.trim());
    rememberRepo(project, path, env);
    return { path, project, source: "flag" };
  }
  const mapped = lookupRepo(project, env);
  if (mapped !== null) {
    try {
      return { path: resolveGitDir(mapped), project, source: "config" };
    } catch {
      // Stale mapping — fall through to cwd.
    }
  }
  const cwd = opts.cwd ?? process.cwd();
  if (existsSync(join(cwd, ".git"))) {
    try {
      const path = resolveGitDir(cwd);
      const remotes = await listRemotes(path, opts.runCommand, env);
      if (remotes.some((r) => remoteMatchesProject(r, project))) {
        rememberRepo(project, path, env);
        return { path, project, source: "cwd" };
      }
    } catch {
      // cwd is not a usable git dir
    }
  }
  throw errors.usage(
    `no local clone for ${project}. Pass --repo <path> (remembered for next time), or run from that repo.`,
  );
}

function reposPath(env: NodeJS.ProcessEnv): string {
  return join(resolvePaths(env).home, "repos.json");
}

function readRepos(env: NodeJS.ProcessEnv): ReposFile {
  const text = readFileText(reposPath(env));
  if (text === null) return { format: "councilkit-repos", version: 1, repos: [] };
  try {
    const parsed = JSON.parse(text) as ReposFile;
    if (
      parsed.format !== "councilkit-repos" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.repos)
    ) {
      return { format: "councilkit-repos", version: 1, repos: [] };
    }
    return parsed;
  } catch {
    return { format: "councilkit-repos", version: 1, repos: [] };
  }
}

function lookupRepo(project: string, env: NodeJS.ProcessEnv): string | null {
  const hit = readRepos(env).repos.find((r) => r.project === project);
  return hit?.path ?? null;
}

function rememberRepo(project: string, path: string, env: NodeJS.ProcessEnv): void {
  ensureHome(env);
  const file = readRepos(env);
  const idx = file.repos.findIndex((r) => r.project === project);
  if (idx >= 0) file.repos[idx] = { project, path };
  else file.repos.push({ project, path });
  atomicWriteJson(reposPath(env), file);
}
