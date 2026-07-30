/**
 * `councilkit runs gc` — reclaim disk from old review/run workspaces (P2-3).
 * Deletes ONLY the enumerated `<runsRoot>/<run-id>/workspaces` directories
 * older than `--keep <days>` (default 7); `report.md` and `transcript.jsonl`
 * are never touched, and run root directories are never removed. Deletion
 * never follows symlinks (a symlinked run dir or workspaces dir is skipped,
 * not traversed).
 *
 *   councilkit runs gc [--keep <days>] [--dry-run] [--all] [--json]
 *
 * `--all` ignores age (and is mutually exclusive with an explicit `--keep`).
 * A single-item IO failure is an exit-5 error, never a silent skip.
 */
import { type Stats, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errors } from "../errors";
import type { OutputSink } from "../output";
import { resolvePaths } from "../store/paths";
import { parseFlags, parseIntFlag } from "./parse";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_KEEP_DAYS = 7;

export interface RunsGcCandidate {
  runId: string;
  workspacePath: string;
  /** ISO mtime of the workspaces directory (the age signal). */
  modifiedAt: string;
  removed: boolean;
}

export interface RunsGcOutcome {
  dryRun: boolean;
  all: boolean;
  keepDays: number | null;
  candidates: RunsGcCandidate[];
}

export interface RunsDeps {
  /** Injectable clock (tests pin "now" instead of touching real mtimes). */
  now?: number;
}

export async function runRuns(argv: string[], out: OutputSink, deps: RunsDeps = {}): Promise<void> {
  const { values, positionals } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        keep: { type: "string" },
        "dry-run": { type: "boolean" },
        all: { type: "boolean" },
      },
      allowPositionals: 1,
    },
    argv,
  );

  const sub = positionals[0];
  if (sub !== "gc") {
    throw errors.usage(
      sub === undefined
        ? "runs requires a subcommand: gc"
        : `unknown runs subcommand "${sub}" (only "gc" exists)`,
    );
  }

  const all = values.all === true;
  const dryRun = values["dry-run"] === true;
  if (all && values.keep !== undefined) {
    throw errors.usage("--all is mutually exclusive with --keep");
  }
  const keepDays = all
    ? null
    : parseIntFlag((values.keep as string) ?? `${DEFAULT_KEEP_DAYS}`, "keep");

  const now = deps.now ?? Date.now();
  const { runsRoot } = resolvePaths();
  const candidates = collectCandidates(runsRoot, { all, keepDays, now });

  if (!dryRun) {
    for (const c of candidates) {
      try {
        rmSync(c.workspacePath, { recursive: true, force: true });
      } catch (cause) {
        throw errors.io(`runs gc: failed to remove a workspaces dir: ${ioName(cause)}`, {
          cause: ioName(cause),
        });
      }
      c.removed = true;
    }
  }

  for (const c of candidates) {
    out.progress(
      `  ${dryRun ? "would remove" : "removed"} ${c.workspacePath} (mtime ${c.modifiedAt})`,
    );
  }
  const outcome: RunsGcOutcome = { dryRun, all, keepDays, candidates };
  await out.finish(outcome, (d) => renderHuman(d as RunsGcOutcome));
}

/** Enumerate `<runsRoot>/<run-id>/workspaces` candidates. Symlinks (run dir or
 * workspaces dir) are skipped via lstat — never followed. A missing runsRoot
 * is an empty success. */
function collectCandidates(
  runsRoot: string,
  opts: { all: boolean; keepDays: number | null; now: number },
): RunsGcCandidate[] {
  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch {
    return [];
  }
  const candidates: RunsGcCandidate[] = [];
  for (const runId of entries) {
    const runDir = join(runsRoot, runId);
    let runStat: Stats;
    try {
      runStat = lstatSync(runDir);
    } catch {
      continue;
    }
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) continue;
    const workspacePath = join(runDir, "workspaces");
    let wsStat: Stats;
    try {
      wsStat = lstatSync(workspacePath);
    } catch {
      continue;
    }
    if (!wsStat.isDirectory() || wsStat.isSymbolicLink()) continue;
    if (!opts.all) {
      const keepDays = opts.keepDays ?? DEFAULT_KEEP_DAYS;
      if (wsStat.mtimeMs >= opts.now - keepDays * DAY_MS) continue;
    }
    candidates.push({
      runId,
      workspacePath,
      modifiedAt: new Date(wsStat.mtimeMs).toISOString(),
      removed: false,
    });
  }
  candidates.sort((a, b) => a.runId.localeCompare(b.runId));
  return candidates;
}

function renderHuman(o: RunsGcOutcome): string {
  const lines: string[] = [];
  const scope = o.all ? "all runs" : `runs older than ${o.keepDays ?? DEFAULT_KEEP_DAYS} days`;
  lines.push(
    `runs gc${o.dryRun ? " (dry-run)" : ""}: ${o.candidates.length} workspaces dir(s) ${o.dryRun ? "matched" : "removed"} (${scope})`,
  );
  for (const c of o.candidates) {
    lines.push(`  ${c.workspacePath}`);
  }
  if (o.candidates.length > 0) {
    lines.push("  (report.md and transcript.jsonl are always kept)");
  }
  return lines.join("\n");
}

function ioName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return "IOFailure";
}
