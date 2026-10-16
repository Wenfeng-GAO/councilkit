/**
 * NPX-03 / NPX-03b (#282): the ONE unsupported-Node copy and gate shared by the
 * CLI launcher (cli/bin/councilkit.mjs, via the tiny cli/dist/node-gate.mjs
 * bundle built from this file), the npx path (same launcher) and the Runtime
 * Host (runtime-host/config.ts). Designer copy, verbatim; only the version is
 * substituted at runtime. Keep this file dependency-free: it must load on old
 * Node before anything else does.
 */
export const SUPPORTED_NODE_MAJOR = 22 as const;

export function nodeMajor(version: string): number {
  return Number.parseInt(String(version).replace(/^v/, "").split(".")[0] ?? "0", 10);
}

export function isSupportedNode(version: string): boolean {
  const major = nodeMajor(version);
  return Number.isFinite(major) && major >= SUPPORTED_NODE_MAJOR;
}

/** zh line first, then en line (designer, NPX-03). */
export function unsupportedNodeLines(version: string): readonly [string, string] {
  return [
    `CouncilKit 需要 Node.js 22 或更新版本，你现在用的是 ${version}。升级方法：\`nvm install --lts && nvm use --lts\`，或者从 nodejs.org 下载 LTS 版本。`,
    `CouncilKit needs Node.js 22 or newer (you have ${version}). Upgrade with \`nvm install --lts && nvm use --lts\`, or get the LTS from nodejs.org.`,
  ];
}

export function unsupportedNodeMessage(version: string): string {
  return unsupportedNodeLines(version).join("\n");
}

/**
 * Gate for entry points: on an unsupported Node, write the two lines to stderr
 * (no stack, no code prefix) and exit 1. Returns normally otherwise.
 */
export function enforceSupportedNode(
  version: string = process.version,
  io: { stderr: { write(s: string): unknown }; exit(code: number): never } = {
    stderr: process.stderr,
    exit: (code: number) => process.exit(code),
  },
): void {
  if (isSupportedNode(version)) return;
  io.stderr.write(`${unsupportedNodeMessage(version)}\n`);
  io.exit(1);
}
