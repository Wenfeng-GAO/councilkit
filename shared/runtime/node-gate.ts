/**
 * NPX-03 / NPX-03b (#282) and the install floor (#372): the ONE unsupported-Node
 * copy and gate shared by the CLI launcher (cli/bin/councilkit.mjs, via the
 * tiny cli/dist/node-gate.mjs bundle built from this file), the npx path (same
 * launcher) and the Runtime Host (runtime-host/config.ts). Keep this file
 * dependency-free: it must load on old Node before anything else does.
 *
 * The floor is the lowest Node that `pnpm install --frozen-lockfile` accepts
 * under `.npmrc` `engine-strict=true`. jsdom@30.1.2 in the lockfile requires
 * `^22.22.2 || ^24.15.0 || >=26`. README, package.json `engines`, and this
 * gate all state that same floor (`>=22.22.2`).
 */
export const SUPPORTED_NODE_MAJOR = 22 as const;
export const SUPPORTED_NODE_FLOOR = "22.22.2" as const;
export const SUPPORTED_NODE_RANGE = `>=${SUPPORTED_NODE_FLOOR}` as const;

export interface NodeVersionParts {
  major: number;
  minor: number;
  patch: number;
}

const FLOOR: NodeVersionParts = { major: 22, minor: 22, patch: 2 };

export function nodeParts(version: string): NodeVersionParts | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version).trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? "0");
  const patch = Number(match[3] ?? "0");
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch };
}

export function nodeMajor(version: string): number {
  return nodeParts(version)?.major ?? Number.NaN;
}

function compareParts(left: NodeVersionParts, right: NodeVersionParts): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function isSupportedNode(version: string): boolean {
  const parts = nodeParts(version);
  return parts !== null && compareParts(parts, FLOOR) >= 0;
}

/** zh line first, then en line. Names the real floor, not only the major. */
export function unsupportedNodeLines(version: string): readonly [string, string] {
  return [
    `CouncilKit 需要 Node.js ${SUPPORTED_NODE_FLOOR} 或更新版本，你现在用的是 ${version}。升级方法：\`nvm install ${SUPPORTED_NODE_FLOOR} && nvm use ${SUPPORTED_NODE_FLOOR}\`，或者从 nodejs.org 下载 ${SUPPORTED_NODE_FLOOR} 或更新的 LTS 版本。`,
    `CouncilKit needs Node.js ${SUPPORTED_NODE_FLOOR} or newer (you have ${version}). Upgrade with \`nvm install ${SUPPORTED_NODE_FLOOR} && nvm use ${SUPPORTED_NODE_FLOOR}\`, or get ${SUPPORTED_NODE_FLOOR} or a newer LTS from nodejs.org.`,
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
