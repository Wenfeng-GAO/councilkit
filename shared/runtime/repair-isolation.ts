export const ISOLATION_MODES = ["strong", "collaborative"] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export interface IsolationCapability {
  platform: NodeJS.Platform;
  sandboxExec: boolean;
  canEnforceDeadlineAfterParentExit: boolean;
  canDenyCredentialRead: boolean;
  canDenyControlPlaneWrite: boolean;
  canDenyPublish: boolean;
}

export function probeIsolationCapability(
  platform: NodeJS.Platform,
  sandboxExecAvailable: boolean,
): IsolationCapability {
  const darwinSandbox = platform === "darwin" && sandboxExecAvailable;
  return {
    platform,
    sandboxExec: darwinSandbox,
    canEnforceDeadlineAfterParentExit: platform === "darwin" || platform === "linux",
    canDenyCredentialRead: darwinSandbox,
    canDenyControlPlaneWrite: darwinSandbox,
    canDenyPublish: darwinSandbox,
  };
}

export function assertIsolationMode(
  mode: IsolationMode,
  capability: IsolationCapability,
): { ok: true } | { ok: false; reason: string } {
  if (mode === "collaborative") return { ok: true };
  if (!capability.sandboxExec) {
    return {
      ok: false,
      reason:
        "strong isolation requires sandbox-exec on Darwin; this runner cannot deny control-plane writes, credential reads, or publish. Collaborative mode must be chosen explicitly.",
    };
  }
  if (
    !capability.canDenyControlPlaneWrite ||
    !capability.canDenyCredentialRead ||
    !capability.canDenyPublish
  ) {
    return { ok: false, reason: "strong isolation is incomplete on this runner" };
  }
  return { ok: true };
}

export function sandboxProfile(input: {
  worktree: string;
  outputDir: string;
  tmpDir: string;
  extraWritePaths?: string[];
  allowNetwork?: boolean;
  credentialHome?: string;
}): string {
  const paths = [input.worktree, input.outputDir, input.tmpDir, ...(input.extraWritePaths ?? [])];
  const writes = paths.map((path) => `(allow file-write* (subpath ${quoted(path)}))`).join("\n");
  const network = input.allowNetwork === true ? "(allow network*)" : "(deny network*)";
  const credentialDenies = `(deny file-read* (regex #"/.ssh/"))
(deny file-read* (regex #"/.git-credentials"))
(deny file-read* (regex #"/.netrc"))
(deny file-read* (literal "/var/run/ssh-agent.socket"))`;
  const tmpRuntime =
    input.allowNetwork === true
      ? `(allow file-write* (regex #"^/private/tmp/"))
(allow file-write* (regex #"^/tmp/"))
(allow file-write-data (literal "/dev/null"))
(allow file-ioctl)
(allow ipc-posix-shm)`
      : `(allow file-write-data (literal "/dev/null"))`;
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
(deny file-write*)
${writes}
${tmpRuntime}
${network}
${credentialDenies}
`;
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function isolationLabel(mode: IsolationMode): string {
  return mode === "strong"
    ? "强隔离（OS sandbox；候选代码不可写控制面、读凭据或发布）"
    : "协作约定（非 OS 隔离；不声称不可绕过）";
}
