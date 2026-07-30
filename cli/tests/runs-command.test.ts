/**
 * `councilkit runs gc` (P2-3): deletes ONLY the enumerated
 * `<runsRoot>/<run-id>/workspaces` directories — by age (default 7 days) or
 * `--all`. report.md / transcript.jsonl and the run root are never touched,
 * symlinks are never followed, a missing runsRoot is an empty success, and a
 * single-item IO failure is exit 5 (never a silent skip). Plain temp dirs with
 * pinned mtimes — zero real review runs.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunsGcOutcome, runRuns } from "../src/commands/runs";
import { CliError } from "../src/errors";
import { resolvePaths } from "../src/store/paths";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Pinned "now" — injected via deps so mtimes can be pinned too. */
const NOW = Date.now();

interface FakeSink {
  json: boolean;
  lines: string[];
  finished: unknown;
  progress(m: string): void;
  diag(m: string): void;
  finish(d: unknown): void;
}

function makeSink(): FakeSink {
  const sink: FakeSink = {
    json: false,
    lines: [],
    finished: undefined,
    progress: (m) => sink.lines.push(m),
    diag: () => {},
    finish: (d) => {
      sink.finished = d;
    },
  };
  return sink;
}

describe("cli runs gc command", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-runs-gc-"));
    oldHome = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  /** Create runs/<id>/{workspaces/attempt-0, report.md, transcript.jsonl} and
   * pin the workspaces dir mtime to `ageDays` before NOW. */
  function seedRun(
    runId: string,
    ageDays: number,
  ): {
    runDir: string;
    workspaces: string;
    report: string;
    transcript: string;
  } {
    const paths = resolvePaths();
    const runDir = paths.runDir(runId);
    const workspaces = join(runDir, "workspaces");
    mkdirSync(join(workspaces, "attempt-0"), { recursive: true });
    writeFileSync(join(workspaces, "attempt-0", "scratch.txt"), "work");
    const report = join(runDir, "report.md");
    const transcript = join(runDir, "transcript.jsonl");
    writeFileSync(report, "# report\n");
    writeFileSync(transcript, "{}\n");
    const mtime = new Date(NOW - ageDays * DAY_MS);
    utimesSync(workspaces, mtime, mtime);
    return { runDir, workspaces, report, transcript };
  }

  async function expectUsage(argv: string[], fragment: string): Promise<void> {
    try {
      await runRuns(argv, makeSink(), { now: NOW });
      throw new Error("expected runRuns to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(2);
      expect(err.message).toContain(fragment);
    }
  }

  it("default --keep 7 removes only workspaces older than 7 days, keeps report/transcript", async () => {
    const old = seedRun("ck-review-old", 10);
    const recent = seedRun("ck-review-new", 2);
    const sink = makeSink();
    await runRuns(["gc"], sink, { now: NOW });

    const outcome = sink.finished as RunsGcOutcome;
    expect(outcome.keepDays).toBe(7);
    expect(outcome.all).toBe(false);
    expect(outcome.dryRun).toBe(false);
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]?.runId).toBe("ck-review-old");
    expect(outcome.candidates[0]?.removed).toBe(true);

    // Old workspaces gone; report/transcript and the run root untouched.
    expect(existsSync(old.workspaces)).toBe(false);
    expect(readFileSync(old.report, "utf8")).toBe("# report\n");
    expect(readFileSync(old.transcript, "utf8")).toBe("{}\n");
    expect(existsSync(old.runDir)).toBe(true);
    // Recent workspaces kept.
    expect(existsSync(recent.workspaces)).toBe(true);
  });

  it("--keep 30 keeps a 10-day-old workspace", async () => {
    const run = seedRun("ck-review-old", 10);
    const sink = makeSink();
    await runRuns(["gc", "--keep", "30"], sink, { now: NOW });
    const outcome = sink.finished as RunsGcOutcome;
    expect(outcome.keepDays).toBe(30);
    expect(outcome.candidates).toHaveLength(0);
    expect(existsSync(run.workspaces)).toBe(true);
  });

  it("--all removes every workspace regardless of age", async () => {
    const a = seedRun("ck-review-a", 1);
    const b = seedRun("ck-review-b", 100);
    const sink = makeSink();
    await runRuns(["gc", "--all"], sink, { now: NOW });
    const outcome = sink.finished as RunsGcOutcome;
    expect(outcome.all).toBe(true);
    expect(outcome.keepDays).toBeNull();
    expect(outcome.candidates).toHaveLength(2);
    expect(existsSync(a.workspaces)).toBe(false);
    expect(existsSync(b.workspaces)).toBe(false);
    expect(readFileSync(a.report, "utf8")).toBe("# report\n");
  });

  it("--all is mutually exclusive with an explicit --keep", async () => {
    await expectUsage(["gc", "--all", "--keep", "3"], "mutually exclusive");
  });

  it("--dry-run lists candidates but removes nothing (and composes with --all)", async () => {
    const run = seedRun("ck-review-old", 10);
    const sink = makeSink();
    await runRuns(["gc", "--dry-run", "--all"], sink, { now: NOW });
    const outcome = sink.finished as RunsGcOutcome;
    expect(outcome.dryRun).toBe(true);
    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]?.removed).toBe(false);
    expect(existsSync(run.workspaces)).toBe(true);
  });

  it("never follows a symlinked workspaces dir or a symlinked run dir", async () => {
    // A real dir OUTSIDE the runs tree, symlinked in as <run>/workspaces.
    const outside = join(home, "outside-ws");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "keep me");
    const paths = resolvePaths();
    const runDir = paths.runDir("ck-review-link");
    mkdirSync(runDir, { recursive: true });
    symlinkSync(outside, join(runDir, "workspaces"));
    // A whole run dir symlinked from outside the tree.
    const outsideRun = join(home, "outside-run");
    mkdirSync(join(outsideRun, "workspaces"), { recursive: true });
    symlinkSync(outsideRun, paths.runDir("ck-review-runlink"));

    const sink = makeSink();
    await runRuns(["gc", "--all"], sink, { now: NOW });
    const outcome = sink.finished as RunsGcOutcome;
    expect(outcome.candidates).toHaveLength(0);
    // Nothing traversed, nothing deleted; both symlinks still in place.
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(lstatSync(join(runDir, "workspaces")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outsideRun, "workspaces"))).toBe(true);
    expect(lstatSync(paths.runDir("ck-review-runlink")).isSymbolicLink()).toBe(true);
  });

  it("a missing runsRoot is an empty success", async () => {
    const sink = makeSink();
    await runRuns(["gc"], sink, { now: NOW });
    const outcome = sink.finished as RunsGcOutcome;
    expect(outcome.candidates).toEqual([]);
  });

  it("a run without a workspaces dir is not a candidate", async () => {
    const paths = resolvePaths();
    const runDir = paths.runDir("ck-review-bare");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.md"), "# report\n");
    const sink = makeSink();
    await runRuns(["gc", "--all"], sink, { now: NOW });
    const outcome = sink.finished as RunsGcOutcome;
    expect(outcome.candidates).toEqual([]);
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toBe("# report\n");
  });

  it("--keep must be a positive integer", async () => {
    await expectUsage(["gc", "--keep", "0"], "positive integer");
    await expectUsage(["gc", "--keep", "abc"], "positive integer");
  });

  it("requires the gc subcommand and rejects unknown subcommands", async () => {
    await expectUsage([], "subcommand");
    await expectUsage(["bogus"], "unknown runs subcommand");
  });

  it("a single-item IO failure is exit 5, not a silent skip", async () => {
    const run = seedRun("ck-review-old", 10);
    // Removing <run>/workspaces requires write permission on the run dir.
    chmodSync(run.runDir, 0o555);
    try {
      await runRuns(["gc"], makeSink(), { now: NOW });
      throw new Error("expected runRuns to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
    } finally {
      chmodSync(run.runDir, 0o700);
    }
  });

  it("a symlinked runsRoot is exit 5 (never gc'd through)", async () => {
    const real = join(home, "real-runs");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, resolvePaths().runsRoot);
    try {
      await runRuns(["gc", "--all"], makeSink(), { now: NOW });
      throw new Error("expected runRuns to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
      expect(err.message).toContain("not a real directory");
    }
  });

  it("a readdir IO failure on runsRoot is exit 5, not an empty success", async () => {
    seedRun("ck-review-old", 10);
    const { runsRoot } = resolvePaths();
    chmodSync(runsRoot, 0o000);
    try {
      await runRuns(["gc", "--all"], makeSink(), { now: NOW });
      throw new Error("expected runRuns to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
    } finally {
      chmodSync(runsRoot, 0o700);
    }
  });

  it("TOCTOU: a workspaces dir swapped for a symlink after enumeration is exit 5, target untouched", async () => {
    const run = seedRun("ck-review-old", 10);
    // A real dir OUTSIDE the runs tree that must never be deleted through gc.
    const outside = join(home, "outside-ws");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "keep me");
    try {
      await runRuns(["gc"], makeSink(), {
        now: NOW,
        beforeRemove: (workspacePath) => {
          // Simulate the race: replace the real dir with a symlink to outside.
          rmSync(workspacePath, { recursive: true, force: true });
          symlinkSync(outside, workspacePath);
        },
      });
      throw new Error("expected runRuns to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
      expect(err.message).toContain("changed during gc");
    }
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(lstatSync(run.workspaces).isSymbolicLink()).toBe(true);
  });

  it("TOCTOU: a run dir swapped for a symlink after enumeration is exit 5, target untouched", async () => {
    const run = seedRun("ck-review-old", 10);
    // A real run-shaped tree OUTSIDE the runs root that must never be deleted:
    // a lexical containment check would still pass for this swap.
    const outside = join(home, "outside-run");
    mkdirSync(join(outside, "workspaces"), { recursive: true });
    writeFileSync(join(outside, "workspaces", "precious.txt"), "keep me");
    try {
      await runRuns(["gc"], makeSink(), {
        now: NOW,
        beforeRemove: () => {
          // Simulate the race: replace the whole run dir with a symlink to outside.
          rmSync(run.runDir, { recursive: true, force: true });
          symlinkSync(outside, run.runDir);
        },
      });
      throw new Error("expected runRuns to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
      expect(err.message).toContain("changed during gc");
    }
    expect(readFileSync(join(outside, "workspaces", "precious.txt"), "utf8")).toBe("keep me");
    expect(lstatSync(run.runDir).isSymbolicLink()).toBe(true);
  });

  it("TOCTOU: the runs ROOT swapped for a symlink after enumeration is exit 5, target untouched", async () => {
    seedRun("ck-review-old", 10);
    const { runsRoot } = resolvePaths();
    // A run-shaped tree OUTSIDE the runs root that must never be gc'd: if the
    // delete re-realpath'd the CURRENT root, this swap would become the new
    // trusted root and the delete would proceed inside it (reviewer finding).
    const outside = join(home, "outside-root");
    mkdirSync(join(outside, "ck-review-old", "workspaces"), { recursive: true });
    writeFileSync(join(outside, "ck-review-old", "workspaces", "precious.txt"), "keep me");
    try {
      await runRuns(["gc"], makeSink(), {
        now: NOW,
        beforeRemove: () => {
          // Simulate the race: replace the whole runs ROOT with a symlink.
          rmSync(runsRoot, { recursive: true, force: true });
          symlinkSync(outside, runsRoot);
        },
      });
      throw new Error("expected runRuns to throw");
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.exitCode).toBe(5);
      expect(err.message).toContain("trusted root changed");
    }
    expect(readFileSync(join(outside, "ck-review-old", "workspaces", "precious.txt"), "utf8")).toBe(
      "keep me",
    );
    expect(lstatSync(runsRoot).isSymbolicLink()).toBe(true);
  });
});
