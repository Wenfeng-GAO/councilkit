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
import { dirname, join } from "node:path";
import { isCliRunId, listCliRuns, readCliRun } from "@shared/runtime/cli-runs-index";
import { errors } from "../errors";
import {
  type TrustedRoot,
  assertWithinRoot,
  bindTrustedRoot,
  revalidateTrustedRoot,
} from "../fs-safe";
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
  /** Test hook invoked after the pre-delete re-validation, right before each
   * removal — lets a test simulate the TOCTOU swap (real dir → symlink). */
  beforeRemove?: (workspacePath: string) => void;
}

export async function runRuns(argv: string[], out: OutputSink, deps: RunsDeps = {}): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") return runList(rest, out);
  if (sub === "open") return runOpen(rest, out);
  if (sub !== "gc") {
    throw errors.usage(
      sub === undefined
        ? "runs requires a subcommand: list|open|gc"
        : `unknown runs subcommand "${sub}" (list|open|gc)`,
    );
  }

  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        keep: { type: "string" },
        "dry-run": { type: "boolean" },
        all: { type: "boolean" },
      },
      allowPositionals: 0,
    },
    rest,
  );

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
  // Bind the trusted runs root ONCE (lstat proves a real directory, realpath
  // pins its canonical location). Every candidate is validated against THIS
  // pinned root, and the root is re-validated against it before every delete —
  // re-realpathing the CURRENT root at delete time would accept a root swapped
  // for a symlink mid-gc as the new trusted root (reviewer finding). A missing
  // runsRoot stays an empty success.
  const bound = bindTrustedRoot(runsRoot);
  const candidates = bound === null ? [] : collectCandidates(bound, { all, keepDays, now });

  if (!dryRun && bound !== null) {
    for (const c of candidates) {
      deps.beforeRemove?.(c.workspacePath);
      // TOCTOU guard: the workspaces dir was validated at enumeration time, but
      // it may have been swapped for a symlink since — re-validate immediately
      // before the recursive delete (reviewer finding).
      assertDeletable(c.workspacePath, bound);
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

async function runList(argv: string[], out: OutputSink): Promise<void> {
  parseFlags({ flags: { json: { type: "boolean" } }, allowPositionals: 0 }, argv);
  const runs = listCliRuns();
  await out.finish({ runs }, (d) => {
    const list = (d as { runs: ReturnType<typeof listCliRuns> }).runs;
    if (list.length === 0) return "no CLI runs in this home";
    return list
      .map((r) => {
        const report = r.hasReport ? "report" : "no-report";
        return `${r.runId}  ${r.kind}  ${r.status}  ${report}  ${r.title}`;
      })
      .join("\n");
  });
}

async function runOpen(argv: string[], out: OutputSink): Promise<void> {
  const { positionals } = parseFlags(
    { flags: { json: { type: "boolean" } }, allowPositionals: 1 },
    argv,
  );
  const runId = positionals[0];
  if (runId === undefined) throw errors.usage("runs open requires a run id");
  if (!isCliRunId(runId)) {
    throw errors.usage(`not a CLI run id: "${runId}"`);
  }
  const detail = readCliRun(runId);
  if (detail === null) {
    throw errors.usage(`no run found for ${runId}`);
  }
  const url = detail.reportUrl;
  await out.finish({ runId, url, hasReport: detail.hasReport, title: detail.title }, () =>
    [`${url}`, detail.hasReport ? `report: ${detail.title}` : "report.md is missing"].join("\n"),
  );
}

/** Enumerate `<runsRoot>/<run-id>/workspaces` candidates under the BOUND root.
 * Symlinks are never followed — a symlinked run/workspaces dir is skipped, and
 * a candidate whose REAL path escapes the bound root is an exit-5 error. Any
 * single-item IO failure is an exit-5 error, never a silent skip (reviewer
 * findings). */
function collectCandidates(
  bound: TrustedRoot,
  opts: { all: boolean; keepDays: number | null; now: number },
): RunsGcCandidate[] {
  const runsRoot = bound.path;
  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch (cause) {
    if (ioCode(cause) === "ENOENT") return [];
    throw errors.io(`runs gc: cannot read the runs dir: ${ioName(cause)}`, {
      cause: ioName(cause),
    });
  }
  const candidates: RunsGcCandidate[] = [];
  for (const runId of entries) {
    const runDir = join(runsRoot, runId);
    let runStat: Stats;
    try {
      runStat = lstatSync(runDir);
    } catch (cause) {
      // Vanished between readdir and lstat — a benign race, not corruption.
      if (ioCode(cause) === "ENOENT") continue;
      throw errors.io(`runs gc: cannot stat a run dir: ${ioName(cause)}`, {
        cause: ioName(cause),
      });
    }
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) continue;
    const workspacePath = join(runDir, "workspaces");
    let wsStat: Stats;
    try {
      wsStat = lstatSync(workspacePath);
    } catch (cause) {
      // A run without a workspaces dir is simply not a candidate.
      if (ioCode(cause) === "ENOENT") continue;
      throw errors.io(`runs gc: cannot stat a workspaces dir: ${ioName(cause)}`, {
        cause: ioName(cause),
      });
    }
    if (!wsStat.isDirectory() || wsStat.isSymbolicLink()) continue;
    // Containment against the BOUND root on REAL paths (an intermediate
    // symlink pointing outside the tree defeats a lexical check).
    assertWithinRoot(bound, workspacePath);
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

/** Pre-delete re-validation (TOCTOU), all against the root BOUND at
 * enumeration time:
 *  (a) the bound root must be UNCHANGED — a root swapped for a symlink (or
 *      re-created elsewhere) would otherwise turn an external tree into the
 *      new trusted root (reviewer finding);
 *  (b) EVERY link in the chain is re-checked, not just the leaf — lstat on
 *      the workspaces path alone would follow a run dir swapped for a
 *      symlink, and a lexical containment check would still pass;
 *  (c) the workspace's REAL path must still sit under the bound root.
 * Any violation refuses the delete with exit 5 (fail-closed). */
function assertDeletable(workspacePath: string, bound: TrustedRoot): void {
  revalidateTrustedRoot(bound);
  const runDir = dirname(workspacePath);
  for (const [label, path] of [
    ["run dir", runDir],
    ["workspaces dir", workspacePath],
  ] as const) {
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (cause) {
      throw errors.io(`runs gc: a ${label} changed during gc: ${ioName(cause)}`, {
        cause: ioName(cause),
      });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw errors.io(`runs gc: a ${label} changed during gc (refusing to remove it)`);
    }
  }
  // Containment on REAL paths against the BOUND root: resolve() is purely
  // lexical and stays blind to an intermediate symlink pointing outside the
  // runs tree.
  assertWithinRoot(bound, workspacePath);
}

function ioCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
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
