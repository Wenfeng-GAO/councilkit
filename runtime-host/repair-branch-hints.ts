import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { resolveCliRunsRoot } from "@shared/runtime/cli-home";
import { withDriverWellKnownPath } from "@shared/runtime/driver-bins";
import {
  type RepairBranchHints,
  type RepairHintSource,
  type ResolvedRepairBranchHints,
  branchesFromAntCodePrShow,
  branchesFromGhPrView,
  mergeRepairBranchHints,
  uniqueFeatureWorktreeBranch,
} from "@shared/runtime/pr-inspect";
import { parseAntCodePrUrl, parseApplyPrUrl } from "@shared/runtime/pr-url";
import { repairBranchHintsFromFrozenContext } from "@shared/runtime/repair-auth";

const INSPECT_TIMEOUT_MS = 4000;
const GIT_TIMEOUT_MS = 2500;
const GH_JSON_FIELDS = "headRefName,baseRefName";

export async function resolveRepairBranchHints(input: {
  runId: string;
  prUrl: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedRepairBranchHints> {
  const env = input.env ?? process.env;
  const frozen = readFrozenHints(input.runId, env);
  const repo = readInvocationRepo(input.runId, env);
  const prUrl = input.prUrl;
  const needInspect = prUrl !== null && prUrl.length > 0 && (!frozen.sourceBranch || !frozen.base);
  const inspected =
    needInspect && prUrl
      ? await inspectPrBranches(prUrl, { cwd: repo ?? process.cwd(), env })
      : emptyHints();
  const needWorktree =
    (!frozen.sourceBranch && !inspected.sourceBranch) || (!frozen.base && !inspected.base);
  const worktree = needWorktree ? await readWorktreeHints(repo, env) : emptyHints();
  return mergeRepairBranchHints([
    { ...inspected, source: "pr" },
    { ...frozen, source: "review" },
    { ...worktree, source: "worktree" },
  ]);
}

export async function inspectPrBranches(
  prUrl: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<RepairBranchHints> {
  const parsed = parseApplyPrUrl(prUrl);
  if (parsed === null) return emptyHints();
  const env = withDriverWellKnownPath(opts.env);
  if (parsed.kind === "github") {
    const gh = findBin("gh", env);
    if (gh === null) return emptyHints();
    const view = await runCommand(
      gh,
      ["pr", "view", parsed.url.toString(), "--json", GH_JSON_FIELDS],
      {
        cwd: opts.cwd,
        env,
        timeoutMs: INSPECT_TIMEOUT_MS,
      },
    );
    if (view.exitCode !== 0) return emptyHints();
    return branchesFromGhPrView(jsonParse(view.stdout));
  }
  const ant = parseAntCodePrUrl(parsed.url);
  const antcode = findBin("antcode", env);
  if (ant === null || antcode === null) return emptyHints();
  const shown = await runCommand(
    antcode,
    ["pr", "show", ant.iid, "-P", ant.project, "--json", "--raw", "--no-pager"],
    {
      cwd: opts.cwd,
      env: {
        ...env,
        NO_PROXY: "*",
        no_proxy: "*",
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        https_proxy: "",
        http_proxy: "",
      },
      timeoutMs: INSPECT_TIMEOUT_MS,
    },
  );
  if (shown.exitCode !== 0) return emptyHints();
  return branchesFromAntCodePrShow(jsonParse(shown.stdout));
}

export type { RepairHintSource };

function readFrozenHints(runId: string, env: NodeJS.ProcessEnv): RepairBranchHints {
  const path = join(resolveCliRunsRoot(env), runId, "review-context.md");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return emptyHints();
    return repairBranchHintsFromFrozenContext(readFileSync(path, "utf8"));
  } catch {
    return emptyHints();
  }
}

function readInvocationRepo(runId: string, env: NodeJS.ProcessEnv): string | null {
  const path = join(resolveCliRunsRoot(env), runId, "invocation-manifest.v1.json");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return null;
    const rec = jsonParse(readFileSync(path, "utf8"));
    if (rec === null || typeof rec !== "object") return null;
    const repo = (rec as { repoRealpath?: unknown }).repoRealpath;
    if (typeof repo !== "string" || repo.length === 0) return null;
    const dirStat = lstatSync(repo);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    return repo;
  } catch {
    return null;
  }
}

async function readWorktreeHints(
  repo: string | null,
  env: NodeJS.ProcessEnv,
): Promise<RepairBranchHints> {
  if (repo === null) return emptyHints();
  const gitEnv = withDriverWellKnownPath(env);
  const git = findBin("git", gitEnv);
  if (git === null) return emptyHints();
  const result = await runCommand(git, ["worktree", "list", "--porcelain"], {
    cwd: repo,
    env: gitEnv,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return emptyHints();
  return {
    sourceBranch: uniqueFeatureWorktreeBranch(result.stdout),
    base: null,
  };
}

function findBin(name: string, env: NodeJS.ProcessEnv): string | null {
  const path = env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    try {
      const stat = lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function runCommand(
  executable: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; exitCode: number | null }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, argv, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-512 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-128 * 1024);
    });
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      finish({ stdout, stderr, exitCode: null });
    }, opts.timeoutMs);
    timeout.unref?.();
    child.on("error", (error) => {
      clearTimeout(timeout);
      finish({ stdout: "", stderr: error.message, exitCode: null });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      finish({ stdout, stderr, exitCode: code });
    });
  });
}

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function emptyHints(): RepairBranchHints {
  return { sourceBranch: null, base: null };
}
