/**
 * Read-only access to COUNCILKIT_HOME/archived-runs.json — the operator's
 * "hidden from lists" marker set for runs that were already dealt with.
 *
 * Only the Host GET /api/v1/cli-runs list consults it; direct detail reads
 * (GET /api/v1/cli-runs/:id) and the CLI keep showing every run on disk.
 * The file is produced outside this codebase (manual/cleanup tooling), so a
 * missing or malformed file never hides anything — it fails open.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCouncilkitHome } from "./cli-home";
import { isCliRunId } from "./cli-runs-index";

export const ARCHIVED_RUNS_FILE = "archived-runs.json";

const MAX_ARCHIVED_RUNS_BYTES = 256 * 1024;

export interface ArchivedRunsFile {
  version: number;
  runIds: string[];
}

/**
 * Strict shape `{ version: 1, runIds: string[] }` — exactly these two fields,
 * version must be 1, and every id must be a valid CLI run id. Anything else
 * (missing/malformed JSON, unsupported version, unknown fields, one invalid
 * id) returns null so the Host fails open and hides nothing.
 */
export function parseArchivedRunsFile(text: string): ArchivedRunsFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.version !== 1 || !Array.isArray(row.runIds)) {
    return null;
  }
  if (!row.runIds.every((id): id is string => typeof id === "string" && isCliRunId(id))) {
    return null;
  }
  return { version: 1, runIds: row.runIds };
}

export function readArchivedRunIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const path = join(resolveCouncilkitHome(env), ARCHIVED_RUNS_FILE);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVED_RUNS_BYTES) {
      return new Set();
    }
    const parsed = parseArchivedRunsFile(readFileSync(path, "utf8"));
    return parsed === null ? new Set() : new Set(parsed.runIds);
  } catch {
    return new Set();
  }
}
