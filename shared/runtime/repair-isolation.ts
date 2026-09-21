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

const PIPELINE_STRONG_UNAVAILABLE =
  "full Squad pipeline strong isolation is unsupported: the Orchestrator must write the journal, and this runner cannot deny publish. Choose collaborative explicitly; candidate-command sandbox is only a local hardening and is not a pipeline strong boundary.";

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
    canDenyPublish: false,
  };
}

/** Candidate-side command sandbox. Not a full Squad pipeline strong guarantee. */
export function assertIsolationMode(
  mode: IsolationMode,
  capability: IsolationCapability,
): { ok: true } | { ok: false; reason: string } {
  if (mode === "collaborative") return { ok: true };
  if (!capability.sandboxExec) {
    return {
      ok: false,
      reason:
        "candidate-command sandbox requires sandbox-exec on Darwin. Collaborative mode must be chosen explicitly for the Squad pipeline.",
    };
  }
  return { ok: true };
}

/** Whole-pipeline isolation for real Squad Orchestrator + journal + publish. */
export function assertSquadPipelineIsolation(
  mode: IsolationMode,
): { ok: true } | { ok: false; reason: string } {
  if (mode === "collaborative") return { ok: true };
  return { ok: false, reason: PIPELINE_STRONG_UNAVAILABLE };
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
  const credentialHome = input.credentialHome;
  const homeDenies = credentialHome
    ? [
        `(deny file-read* (subpath ${quoted(`${credentialHome}/.ssh`)}))`,
        `(deny file-read* (subpath ${quoted(`${credentialHome}/.config/gh`)}))`,
        `(deny file-read* (subpath ${quoted(`${credentialHome}/.config/antcode`)}))`,
        `(deny file-read* (literal ${quoted(`${credentialHome}/.git-credentials`)}))`,
        `(deny file-read* (literal ${quoted(`${credentialHome}/.netrc`)}))`,
        `(deny file-read* (literal ${quoted(`${credentialHome}/.config/gh/hosts.yml`)}))`,
      ].join("\n")
    : "";
  const credentialDenies = `(deny file-read* (regex #"/.ssh/"))
(deny file-read* (regex #"/.git-credentials"))
(deny file-read* (regex #"/.netrc"))
(deny file-read* (regex #"/.config/gh/"))
(deny file-read* (regex #"/.config/antcode/"))
(deny file-read* (literal "/var/run/ssh-agent.socket"))
${homeDenies}`;
  const tmpRuntime =
    input.allowNetwork === true
      ? `(allow file-write-data (literal "/dev/null"))
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
    ? "整条真实 Squad 强隔离当前不支持（Orchestrator 需写 journal，无法拒绝发布）"
    : "协作约定（非 OS 硬隔离；清除不必继承的凭据并禁止候选发布 hooks，不声称不可绕过）";
}
