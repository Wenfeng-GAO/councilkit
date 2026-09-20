import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { isCliRunId } from "@shared/runtime/cli-runs-index";
import { errors } from "../errors";
import { ensureHome, resolvePaths } from "../store/paths";

export interface RepairHandoffRef {
  path: string;
  sha256: string;
  generation: number;
}

export function createRepairHandoff(input: {
  runId: string;
  cycle: number;
  body: unknown;
  directory?: string;
}): RepairHandoffRef {
  if (!isCliRunId(input.runId) || !input.runId.startsWith("ck-repair-")) {
    throw errors.usage("handoff run id must be ck-repair-<uuid>");
  }
  if (!Number.isInteger(input.cycle) || input.cycle < 1) {
    throw errors.usage("handoff cycle must be a positive integer");
  }
  const home = ensureHome();
  const runsRoot = resolvePaths().runsRoot;
  mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  const dir = assertSafeHandoffDir(input.directory ?? join(home, "handoff"), runsRoot);
  const file = join(dir, `${input.runId}-c${input.cycle}.json`);
  const payload = `${JSON.stringify(input.body, null, 2)}\n`;
  try {
    writeFileSync(file, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
    throw errors.io("cannot create repair handoff; use a new cycle file");
  }
  return {
    path: file,
    sha256: createHash("sha256").update(payload).digest("hex"),
    generation: input.cycle,
  };
}

export function readRepairHandoff(input: {
  runId: string;
  cycle: number;
  directory?: string;
}): RepairHandoffRef | null {
  if (!isCliRunId(input.runId) || !input.runId.startsWith("ck-repair-")) return null;
  if (!Number.isInteger(input.cycle) || input.cycle < 1) return null;
  const home = ensureHome();
  const dir = input.directory ?? join(home, "handoff");
  const file = join(dir, `${input.runId}-c${input.cycle}.json`);
  if (!existsSync(file)) return null;
  const payload = readFileSync(file, "utf8");
  return {
    path: file,
    sha256: createHash("sha256").update(payload).digest("hex"),
    generation: input.cycle,
  };
}

export function ensureRepairHandoff(input: {
  runId: string;
  cycle: number;
  body: unknown;
  directory?: string;
}): RepairHandoffRef {
  const existing = readRepairHandoff(input);
  if (existing) return existing;
  return createRepairHandoff(input);
}

function assertSafeHandoffDir(dir: string, runsRoot: string): string {
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw errors.usage("repair handoff directory must not be a symlink");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const after = lstatSync(dir);
  if (after.isSymbolicLink()) {
    throw errors.usage("repair handoff directory must not be a symlink");
  }
  const real = realpathSync(dir);
  const realRuns = realpathSync(runsRoot);
  if (real === realRuns || real.startsWith(realRuns + sep)) {
    throw errors.usage("repair handoff must stay outside the runs history directory");
  }
  return real;
}
