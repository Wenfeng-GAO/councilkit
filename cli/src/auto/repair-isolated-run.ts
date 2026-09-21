import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type IsolationCapability,
  type IsolationMode,
  assertIsolationMode,
  probeIsolationCapability,
  sandboxProfile,
} from "@shared/runtime/repair-isolation";
import { errors } from "../errors";
import { type RunCommand, type RunCommandResult, defaultRunCommand } from "./checkout-pr";

const CREDENTIAL_KEYS = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_ASKPASS",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTCODE_TOKEN",
];

export function detectIsolationCapability(
  env: NodeJS.ProcessEnv = process.env,
): IsolationCapability {
  return probeIsolationCapability(process.platform, sandboxExecAvailable(env));
}

function sandboxExecAvailable(env: NodeJS.ProcessEnv): boolean {
  const explicit = env.COUNCILKIT_SANDBOX_EXEC;
  if (explicit && explicit.length > 0) return existsSync(explicit);
  return ["/usr/bin/sandbox-exec", "/usr/sbin/sandbox-exec"].some((path) => existsSync(path));
}

export function stripCredentialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of CREDENTIAL_KEYS) delete next[key];
  return next;
}

export function wrapIsolatedSpawn(input: {
  mode: IsolationMode;
  capability: IsolationCapability;
  executable: string;
  argv: string[];
  worktree: string;
  outputDir: string;
  tmpDir: string;
  extraWritePaths?: string[];
  allowNetwork?: boolean;
  credentialHome?: string;
}): { executable: string; argv: string[] } {
  const allowed = assertIsolationMode(input.mode, input.capability);
  if (!allowed.ok) throw errors.usage(allowed.reason);
  if (input.mode === "collaborative") {
    return { executable: input.executable, argv: input.argv };
  }
  mkdirSync(input.tmpDir, { recursive: true, mode: 0o700 });
  mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
  mkdirSync(input.worktree, { recursive: true });
  const profile = sandboxProfile({
    worktree: realExisting(input.worktree),
    outputDir: realExisting(input.outputDir),
    tmpDir: realExisting(input.tmpDir),
    extraWritePaths: (input.extraWritePaths ?? []).map((path) => realExisting(path)),
    allowNetwork: input.allowNetwork,
    credentialHome: input.credentialHome,
  });
  const profilePath = join(input.tmpDir, "sandbox.sb");
  writeFileSync(profilePath, profile, { encoding: "utf8", mode: 0o600 });
  return {
    executable: sandboxExecBin(),
    argv: ["-f", profilePath, input.executable, ...input.argv],
  };
}

function sandboxExecBin(): string {
  if (process.env.COUNCILKIT_SANDBOX_EXEC && existsSync(process.env.COUNCILKIT_SANDBOX_EXEC)) {
    return process.env.COUNCILKIT_SANDBOX_EXEC;
  }
  if (existsSync("/usr/bin/sandbox-exec")) return "/usr/bin/sandbox-exec";
  return "sandbox-exec";
}

function realExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function runIsolatedCommand(input: {
  mode: IsolationMode;
  capability: IsolationCapability;
  executable: string;
  argv: string[];
  cwd: string;
  outputDir: string;
  tmpDir: string;
  extraWritePaths?: string[];
  allowNetwork?: boolean;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
}): Promise<RunCommandResult> {
  const env: NodeJS.ProcessEnv = {
    ...stripCredentialEnv(input.env ?? process.env),
    TMPDIR: input.tmpDir,
  };
  const wrapped = wrapIsolatedSpawn({
    mode: input.mode,
    capability: input.capability,
    executable: input.executable,
    argv: input.argv,
    worktree: input.cwd,
    outputDir: input.outputDir,
    tmpDir: input.tmpDir,
    extraWritePaths: input.extraWritePaths,
    allowNetwork: input.allowNetwork,
    credentialHome: env.HOME,
  });
  const run = input.runCommand ?? defaultRunCommand;
  return run({
    executable: wrapped.executable,
    argv: wrapped.argv,
    cwd: input.cwd,
    env,
  });
}

/** Publish must not execute candidate hooks under publish credentials. */
export function publishGitArgv(argv: string[]): string[] {
  return ["-c", "core.hooksPath=/dev/null", ...argv];
}

/** Inject hooksPath without changing the user's global git config. */
export function disableCandidateGitHooksEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
}
