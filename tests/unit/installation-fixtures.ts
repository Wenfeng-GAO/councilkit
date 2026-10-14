import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "../../runtime-host/logging";

/**
 * Installation trust walks every ancestor and rejects a group- or
 * other-writable directory. os.tmpdir() (/tmp is 01777) can never produce a
 * trusted installation, so fixtures live under test-results/ instead.
 */
export const INSTALLATION_FIXTURE_PARENT = join(
  process.cwd(),
  "test-results",
  "installations-unit",
);

const roots: string[] = [];

function relax(dir: string): void {
  try {
    chmodSync(dir, 0o755);
  } catch {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) relax(path);
  }
}

export async function cleanupInstallationFixtures(): Promise<void> {
  const pending = roots.splice(0);
  for (const root of pending) relax(root);
  await Promise.all(pending.map((root) => rm(root, { recursive: true, force: true })));
}

export async function privateDir(prefix: string): Promise<string> {
  await mkdir(INSTALLATION_FIXTURE_PARENT, { recursive: true });
  await chmod(INSTALLATION_FIXTURE_PARENT, 0o755);
  await chmod(dirname(INSTALLATION_FIXTURE_PARENT), 0o755);
  const root = await mkdtemp(join(INSTALLATION_FIXTURE_PARENT, prefix));
  await chmod(root, 0o755);
  roots.push(root);
  return root;
}

/** Directory whose path chain is group/other-writable, for rejection tests. */
export async function worldWritableDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export async function writeExecutable(
  dir: string,
  name: string,
  content: string,
  mode = 0o755,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755);
  const path = join(dir, name);
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

export function fingerprintOf(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function installationIdFor(name: string, pathKey: string): string {
  return `${name}-${createHash("sha256").update(pathKey).digest("hex").slice(0, 12)}`;
}

export interface LogCall {
  event: string;
  context?: Record<string, unknown>;
}

export function recordingLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const logger: Logger = {
    info(event, context) {
      calls.push({ event, context });
    },
    warn(event, context) {
      calls.push({ event, context });
    },
    error(event, context) {
      calls.push({ event, context });
    },
    diagnostic() {
      throw new Error("installations registry must not write diagnostics");
    },
    diagnostics() {
      return [];
    },
    recentProblems() {
      return [];
    },
  };
  return { logger, calls };
}
