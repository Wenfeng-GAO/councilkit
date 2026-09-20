import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errors } from "../errors";
import { ensureHome, resolvePaths } from "../store/paths";
import { readInvocationManifest } from "./invocation-manifest";
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
    if (existsSync(dest) && !isCouncilKitCheckout(dest)) return dest;
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    assertRepairWorkspace(dest);
    return dest;
  }
  throw errors.usage(
    "could not freeze an isolated repair workspace; source review has no usable repoRealpath",
  );
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
