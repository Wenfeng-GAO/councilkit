/**
 * Spawn the same-checkout `councilkit` CLI from the Host. The Host does not
 * run review/apply agents itself — it only starts the autonomous CLI process
 * so the report page can click 「立即修复」 or paste a PR URL. The CLI still
 * never spawns Host.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCliRunsRoot } from "@shared/runtime/cli-home";
import { resolveHostMode } from "./config";

export type CliRunAction = "fix" | "re-review" | "review";

export interface CliRunLaunchRequest {
  action: CliRunAction;
  runId: string;
  logPath: string;
  pr?: string;
  repo?: string;
}

export interface CliRunLauncher {
  start(input: CliRunLaunchRequest): { pid: number } | Promise<{ pid: number }>;
}

const REVIEW_HANDSHAKE_MS = 20_000;
const REVIEW_HANDSHAKE_POLL_MS = 80;
const LOG_TAIL_MAX = 1024;

export function resolveCouncilkitLauncher(
  fromDir = dirname(fileURLToPath(import.meta.url)),
): string | null {
  for (const root of launcherRoots(fromDir)) {
    const candidate = resolve(root, "cli/bin/councilkit.mjs");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** How the Host should exec same-checkout `councilkit`. Dev uses source via tsx
 * so a stale `cli/dist` cannot reject Host flags like `--run-id`. */
export function resolveCouncilkitSpawn(
  fromDir = dirname(fileURLToPath(import.meta.url)),
): { execPath: string; argvPrefix: string[] } | null {
  if (resolveHostMode() !== "production") {
    for (const root of launcherRoots(fromDir)) {
      const src = resolve(root, "cli/src/main.ts");
      const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
      if (existsSync(src) && existsSync(tsxCli)) {
        return { execPath: process.execPath, argvPrefix: [tsxCli, src] };
      }
    }
  }
  const launcher = resolveCouncilkitLauncher(fromDir);
  if (launcher === null) return null;
  return { execPath: process.execPath, argvPrefix: [launcher] };
}

function launcherRoots(fromDir: string): string[] {
  return [process.cwd(), fromDir, join(fromDir, ".."), join(fromDir, "../..")];
}

export function defaultCliRunLauncher(): CliRunLauncher {
  return {
    start(input) {
      const spawnSpec = resolveCouncilkitSpawn();
      if (spawnSpec === null) {
        throw new Error(
          "councilkit CLI launcher not found; run `pnpm build:cli` from the repo root",
        );
      }
      const args = launchArgs(input);
      // Inherit real fds, not a shared WriteStream: Node refuses (or silently
      // drops) the same stream on both stdout and stderr for a detached child,
      // which left an empty pipeline.log and no pid after 「立即修复」.
      const logFd = openSync(input.logPath, "a");
      try {
        const child = spawn(spawnSpec.execPath, [...spawnSpec.argvPrefix, ...args], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: process.env,
          cwd: process.cwd(),
        });
        const pid = child.pid;
        if (pid === undefined) {
          throw new Error("failed to spawn councilkit (no pid)");
        }
        if (input.action !== "review") {
          child.unref();
          return { pid };
        }
        return handshakeReview(child, input, pid);
      } finally {
        try {
          closeSync(logFd);
        } catch {
          // child owns the fd after spawn
        }
      }
    },
  };
}

export function launchArgs(input: CliRunLaunchRequest): string[] {
  if (input.action === "review") {
    if (input.pr === undefined || input.pr.length === 0) {
      throw new Error("review spawn requires pr");
    }
    const args = ["review", input.pr, "--run-id", input.runId];
    if (input.repo !== undefined && input.repo.length > 0) {
      args.push("--repo", input.repo);
    }
    return args;
  }
  if (input.action === "re-review") {
    return ["fix", "--run", input.runId, "--re-review-only"];
  }
  return ["fix", "--run", input.runId];
}

/** Exported for tests: fail if the child already died, even when the run dir exists. */
export async function handshakeReview(
  child: ChildProcess,
  input: CliRunLaunchRequest,
  pid: number,
): Promise<{ pid: number }> {
  let exited = child.exitCode !== null;
  let exitCode: number | null = child.exitCode;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  const runDir = join(resolveCliRunsRoot(), input.runId);
  const deadline = Date.now() + REVIEW_HANDSHAKE_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(logTail(input.logPath) || `councilkit review exited ${String(exitCode)}`);
    }
    if (isRealDir(runDir) && isPidAlive(pid)) {
      child.unref();
      return { pid };
    }
    await sleep(REVIEW_HANDSHAKE_POLL_MS);
  }
  stopDetachedChild(child, pid);
  throw Object.assign(new Error("review handshake timed out waiting for the run directory"), {
    code: "HANDSHAKE_TIMEOUT",
  });
}

function stopDetachedChild(child: ChildProcess, pid: number): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  child.unref();
}

function isRealDir(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function logTail(path: string): string {
  try {
    const text = readFileSync(path, "utf8").trimEnd();
    return text.length <= LOG_TAIL_MAX ? text : text.slice(-LOG_TAIL_MAX);
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
