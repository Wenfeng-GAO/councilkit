/**
 * Canonical report.md and --out copy writes, including IO failures.
 * EACCES is skipped for root because mode 0500 does not block the superuser.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors";
import { writeCanonicalReport, writeReportCopy } from "../src/report/render";

const control = vi.hoisted(() => ({
  mkdirSync: null as ((...args: unknown[]) => unknown) | null,
}));

const fsActual = vi.hoisted(() => ({
  current: null as typeof import("node:fs") | null,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  fsActual.current = actual;
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => {
      const hook = control.mkdirSync;
      if (hook) return hook(...args);
      return actual.mkdirSync(...(args as Parameters<typeof actual.mkdirSync>));
    },
  };
});

const dirs: string[] = [];

function realFs(): typeof import("node:fs") {
  const current = fsActual.current;
  if (!current) throw new Error("node:fs actual was not captured");
  return current;
}

function makeParent(): string {
  const parent = realFs().mkdtempSync(join(tmpdir(), "ck-report-write-"));
  realFs().chmodSync(parent, 0o700);
  dirs.push(parent);
  return parent;
}

function cliError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected CliError");
}

afterEach(() => {
  control.mkdirSync = null;
  const fs = realFs();
  for (const dir of dirs.splice(0)) {
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.chmodSync(join(dir, name), 0o700);
      } catch {
        // Non-directories and already-removed entries are irrelevant to cleanup.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("report file writes", () => {
  it("writes the canonical report and the --out copy with mode 0600", () => {
    const parent = makeParent();
    const canonical = join(parent, "runs", "ck-run-9", "report.md");
    const copy = join(parent, "out", "decision.md");
    const markdown = "# Council Report\n\n- Status: complete\n";
    writeCanonicalReport(canonical, markdown);
    writeReportCopy(copy, markdown);
    const fs = realFs();
    expect(fs.readFileSync(canonical, "utf8")).toBe("# Council Report\n\n- Status: complete\n");
    expect(fs.readFileSync(copy, "utf8")).toBe("# Council Report\n\n- Status: complete\n");
    expect(fs.statSync(canonical).mode & 0o777).toBe(0o600);
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(parent, "runs", "ck-run-9")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(parent, "out")).mode & 0o777).toBe(0o700);
    expect(
      fs.readdirSync(join(parent, "runs", "ck-run-9")).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(fs.readdirSync(join(parent, "out")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces an existing canonical report and can write an empty payload", () => {
    const parent = makeParent();
    const file = join(parent, "report.md");
    writeCanonicalReport(file, "first\n");
    writeCanonicalReport(file, "second\n");
    const fs = realFs();
    expect(fs.readFileSync(file, "utf8")).toBe("second\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    writeCanonicalReport(file, "");
    expect(fs.readFileSync(file, "utf8")).toBe("");
    expect(fs.readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("wraps a non-directory parent as an IO error and leaves that file in place", () => {
    const parent = makeParent();
    const blocker = join(parent, "not-a-dir");
    realFs().writeFileSync(blocker, "keep");
    const err = cliError(() => writeCanonicalReport(join(blocker, "report.md"), "# no\n"));
    expect(err.name).toBe("CliError");
    expect(err.exitCode).toBe(5);
    expect(err.message).toBe("failed to write canonical report: Error");
    expect(err.detail).toEqual({ cause: "Error" });
    expect(realFs().readFileSync(blocker, "utf8")).toBe("keep");
    expect(realFs().readdirSync(parent).sort()).toEqual(["not-a-dir"]);
  });

  it("wraps a directory --out target as an IO error and removes the temp file", () => {
    const parent = makeParent();
    const target = join(parent, "target");
    realFs().mkdirSync(target, { mode: 0o700 });
    const err = cliError(() => writeReportCopy(target, "# no\n"));
    expect(err.name).toBe("CliError");
    expect(err.exitCode).toBe(5);
    expect(err.message).toBe("failed to write --out report copy: Error");
    expect(err.detail).toEqual({ cause: "Error" });
    expect(realFs().readdirSync(target)).toEqual([]);
    expect(
      realFs()
        .readdirSync(parent)
        .filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(realFs().readdirSync(parent).sort()).toEqual(["target"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "leaves an existing canonical report unchanged when its directory is not writable",
    () => {
      const parent = makeParent();
      const dir = join(parent, "run");
      const fs = realFs();
      fs.mkdirSync(dir, { mode: 0o700 });
      const file = join(dir, "report.md");
      fs.writeFileSync(file, "original\n");
      fs.chmodSync(dir, 0o500);
      try {
        const err = cliError(() => writeCanonicalReport(file, "replacement\n"));
        expect(err.name).toBe("CliError");
        expect(err.exitCode).toBe(5);
        expect(err.message).toBe("failed to write canonical report: Error");
        expect(err.detail).toEqual({ cause: "Error" });
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      expect(fs.readFileSync(file, "utf8")).toBe("original\n");
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "leaves an existing --out copy unchanged when its directory is not writable",
    () => {
      const parent = makeParent();
      const dir = join(parent, "out");
      const fs = realFs();
      fs.mkdirSync(dir, { mode: 0o700 });
      const file = join(dir, "report.md");
      fs.writeFileSync(file, "original\n");
      fs.chmodSync(dir, 0o500);
      try {
        const err = cliError(() => writeReportCopy(file, "replacement\n"));
        expect(err.name).toBe("CliError");
        expect(err.exitCode).toBe(5);
        expect(err.message).toBe("failed to write --out report copy: Error");
        expect(err.detail).toEqual({ cause: "Error" });
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      expect(fs.readFileSync(file, "utf8")).toBe("original\n");
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it("labels a non-Error write failure IOFailure and keeps the previous bytes", () => {
    const parent = makeParent();
    const file = join(parent, "report.md");
    realFs().writeFileSync(file, "kept\n");
    control.mkdirSync = () => {
      throw "disk";
    };
    try {
      const err = cliError(() => writeCanonicalReport(file, "next\n"));
      expect(err.name).toBe("CliError");
      expect(err.exitCode).toBe(5);
      expect(err.message).toBe("failed to write canonical report: IOFailure");
      expect(err.detail).toEqual({ cause: "IOFailure" });
    } finally {
      control.mkdirSync = null;
    }
    expect(realFs().readFileSync(file, "utf8")).toBe("kept\n");
  });

  it("puts the Error name, not its message, on an --out failure", () => {
    const parent = makeParent();
    const file = join(parent, "decision.md");
    realFs().writeFileSync(file, "kept\n");
    control.mkdirSync = () => {
      const error = new Error("no space left");
      error.name = "DiskFull";
      throw error;
    };
    try {
      const err = cliError(() => writeReportCopy(file, "next\n"));
      expect(err.name).toBe("CliError");
      expect(err.exitCode).toBe(5);
      expect(err.message).toBe("failed to write --out report copy: DiskFull");
      expect(err.detail).toEqual({ cause: "DiskFull" });
    } finally {
      control.mkdirSync = null;
    }
    expect(realFs().readFileSync(file, "utf8")).toBe("kept\n");
  });
});
