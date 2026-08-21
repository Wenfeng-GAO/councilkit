/**
 * Spawn the same-checkout `councilkit` CLI from the Host. The Host does not
 * run review/apply agents itself — it only starts the autonomous CLI process
 * so the report page can click 「立即修复」. The CLI still never spawns Host.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CliRunAction = "fix" | "re-review";

export interface CliRunLaunchRequest {
  action: CliRunAction;
  runId: string;
  logPath: string;
}

export interface CliRunLauncher {
  start(input: CliRunLaunchRequest): { pid: number };
}

export function resolveCouncilkitLauncher(
  fromDir = dirname(fileURLToPath(import.meta.url)),
): string | null {
  const roots = [process.cwd(), fromDir, join(fromDir, ".."), join(fromDir, "../..")];
  for (const root of roots) {
    const candidate = resolve(root, "cli/bin/councilkit.mjs");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function defaultCliRunLauncher(): CliRunLauncher {
  return {
    start(input) {
      const launcher = resolveCouncilkitLauncher();
      if (launcher === null) {
        throw new Error(
          "councilkit CLI launcher not found; run `pnpm build:cli` from the repo root",
        );
      }
      const args =
        input.action === "re-review"
          ? ["fix", "--run", input.runId, "--re-review-only"]
          : ["fix", "--run", input.runId];
      // Inherit real fds, not a shared WriteStream: Node refuses (or silently
      // drops) the same stream on both stdout and stderr for a detached child,
      // which left an empty pipeline.log and no pid after 「立即修复」.
      const logFd = openSync(input.logPath, "a");
      try {
        const child = spawn(process.execPath, [launcher, ...args], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: process.env,
          cwd: process.cwd(),
        });
        if (child.pid === undefined) {
          throw new Error("failed to spawn councilkit (no pid)");
        }
        child.unref();
        return { pid: child.pid };
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

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
