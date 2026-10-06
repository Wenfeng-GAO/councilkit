import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireExclusiveLock } from "../../../shared/runtime/exclusive-lock";
import { DECISION, FINDING, MODULES } from "../../review-explainer/contract";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

describe("A04 applyFindingDecision", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function api() {
    const mod = await importFeature<Record<string, unknown>>(MODULES.decisions);
    return {
      apply: requireExport<
        (input: Record<string, unknown>) => {
          revision: number;
          items: Record<string, { decision: string }>;
        }
      >(mod, "applyFindingDecision", MODULES.decisions),
      read: requireExport<
        (path: string) => { revision: number; items: Record<string, { decision: string }> }
      >(mod, "readFindingDecisions", MODULES.decisions),
    };
  }

  it("atomically records will_fix / wont_fix / undecided without a reason form", async () => {
    const { apply, read } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-dec-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const first = apply({
      file,
      findingId: FINDING.busy,
      decision: DECISION.willFix,
      expectedRevision: 0,
    });
    expect(first.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
    const second = apply({
      file,
      findingId: FINDING.stale,
      decision: DECISION.wontFix,
      expectedRevision: first.revision,
    });
    expect(second.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
    expect(second.items[FINDING.stale]?.decision).toBe(DECISION.wontFix);
    const withdrawn = apply({
      file,
      findingId: FINDING.stale,
      decision: DECISION.undecided,
      expectedRevision: second.revision,
    });
    expect(withdrawn.items[FINDING.stale]?.decision).toBe(DECISION.undecided);
    const disk = JSON.parse(readFileSync(file, "utf8")) as {
      items: Record<string, { decision: string }>;
    };
    expect(disk.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
    expect(read(file).revision).toBe(withdrawn.revision);
    expect(JSON.stringify(disk)).not.toMatch(/questionnaire|reasonRequired|认可度/);
  });

  it("rejects a stale revision instead of clobbering a concurrent sibling update", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-rev-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const first = apply({
      file,
      findingId: FINDING.busy,
      decision: DECISION.willFix,
      expectedRevision: 0,
    });
    apply({
      file,
      findingId: FINDING.dup,
      decision: DECISION.wontFix,
      expectedRevision: first.revision,
    });
    expect(() =>
      apply({
        file,
        findingId: FINDING.stale,
        decision: DECISION.willFix,
        expectedRevision: first.revision,
      }),
    ).toThrow(/revision|conflict|stale/i);
    const disk = JSON.parse(readFileSync(file, "utf8")) as {
      items: Record<string, { decision: string }>;
    };
    expect(disk.items[FINDING.dup]?.decision).toBe(DECISION.wontFix);
    expect(disk.items[FINDING.stale]).toBeUndefined();
  });

  it("does not leave a truncated file when the write cannot complete", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-fail-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    apply({ file, findingId: FINDING.busy, decision: DECISION.willFix, expectedRevision: 0 });
    const before = readFileSync(file, "utf8");
    // An ordinary file in a parent segment forces an actual ENOTDIR, independent of uid.
    writeFileSync(join(root, "blocked"), "not-a-directory");
    expect(() =>
      apply({
        file: join(root, "blocked", "decisions.json"),
        findingId: FINDING.stale,
        decision: DECISION.willFix,
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("leaves a non-database lock file in place and does not write the decision", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-stale-lock-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const lock = `${file}.lock`;
    const body = `${deadPid()}\n`;
    writeFileSync(lock, body);
    expect(() =>
      apply({
        file,
        findingId: FINDING.busy,
        decision: DECISION.willFix,
        expectedRevision: 0,
      }),
    ).toThrow(/not a database|storage write failure/i);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(body);
  });

  it("records the decision when a previous holder died and left the lock", async () => {
    const { apply, read } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-dead-holder-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const holder = startLockHolder(`${file}.lock`);
    expect(await holder.finished).toBe("held");
    holder.child.kill("SIGKILL");
    await holder.exited;
    const saved = apply({
      file,
      findingId: FINDING.busy,
      decision: DECISION.willFix,
      expectedRevision: 0,
    });
    expect(saved.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
    expect(saved.revision).toBe(1);
    expect(read(file).items[FINDING.busy]?.decision).toBe(DECISION.willFix);
    const again = apply({
      file,
      findingId: FINDING.stale,
      decision: DECISION.wontFix,
      expectedRevision: saved.revision,
    });
    expect(again.items[FINDING.stale]?.decision).toBe(DECISION.wontFix);
    expect(again.revision).toBe(2);
  });

  it("records the decision when a crash left an empty lock behind", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-empty-lock-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const lock = `${file}.lock`;
    writeFileSync(lock, "");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lock, stale, stale);
    const saved = apply({
      file,
      findingId: FINDING.stale,
      decision: DECISION.wontFix,
      expectedRevision: 0,
    });
    expect(saved.items[FINDING.stale]?.decision).toBe(DECISION.wontFix);
    expect(existsSync(file)).toBe(true);
    const again = apply({
      file,
      findingId: FINDING.busy,
      decision: DECISION.willFix,
      expectedRevision: saved.revision,
    });
    expect(again.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
  });

  it("does not take a lock still held by this process", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-live-lock-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const held = acquireExclusiveLock(`${file}.lock`);
    expect(() =>
      apply({
        file,
        findingId: FINDING.busy,
        decision: DECISION.willFix,
        expectedRevision: 0,
      }),
    ).toThrow(/conflict|reload/i);
    expect(existsSync(file)).toBe(false);
    held.release();
    const saved = apply({
      file,
      findingId: FINDING.busy,
      decision: DECISION.willFix,
      expectedRevision: 0,
    });
    expect(saved.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
  });

  it("records the decision when the only lock file is an empty leftover", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-fresh-lock-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    writeFileSync(`${file}.lock`, "");
    const saved = apply({
      file,
      findingId: FINDING.dup,
      decision: DECISION.willFix,
      expectedRevision: 0,
    });
    expect(saved.items[FINDING.dup]?.decision).toBe(DECISION.willFix);
    expect(existsSync(file)).toBe(true);
  });

  it("lets only one process hold the lock, then accepts a decision after that process dies", async () => {
    const { apply } = await api();
    const root = mkdtempSync(join(tmpdir(), "ck-explainer-race-lock-"));
    roots.push(root);
    const file = join(root, "decisions.json");
    const lock = `${file}.lock`;
    const holders = [startLockHolder(lock), startLockHolder(lock)];
    const results = await Promise.all(holders.map((holder) => holder.finished));
    expect(results.filter((result) => result === "held")).toEqual(["held"]);
    for (const holder of holders) holder.child.kill("SIGKILL");
    await Promise.all(holders.map((holder) => holder.exited));
    const saved = apply({
      file,
      findingId: FINDING.busy,
      decision: DECISION.willFix,
      expectedRevision: 0,
    });
    expect(saved.items[FINDING.busy]?.decision).toBe(DECISION.willFix);
  });
});

function startLockHolder(lockPath: string): {
  child: ChildProcess;
  finished: Promise<"held" | "busy">;
  exited: Promise<void>;
} {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { acquireExclusiveLock } from ${JSON.stringify(join(process.cwd(), "shared/runtime/exclusive-lock.ts"))};\nconst held = acquireExclusiveLock(${JSON.stringify(lockPath)});\nconsole.log("held");\nsetInterval(() => {}, 1000);\nvoid held;\n`,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
  const finished = new Promise<"held" | "busy">((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`lock holder stalled: ${text}`)), 4000);
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("held")) {
        clearTimeout(timer);
        resolve("held");
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve("busy");
    });
  });
  return { child, finished, exited };
}

function deadPid(): number {
  for (let pid = 1_000_000_000; pid < 1_000_000_100; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find an unused pid for the stale-lock fixture");
}
