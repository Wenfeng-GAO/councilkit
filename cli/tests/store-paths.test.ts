/**
 * Path resolution and directory creation for the CLI store.
 * Covers COUNCILKIT_HOME / XDG / homedir priority, the run artifact map,
 * and redacted mkdir failures.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { councilkitHome, ensureHome, ensureRunDir, resolvePaths } from "../src/store/paths";

const dirs: string[] = [];

function makeParent(): string {
  const parent = mkdtempSync(join(tmpdir(), "ck-store-paths-"));
  chmodSync(parent, 0o700);
  dirs.push(parent);
  return parent;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("councilkitHome", () => {
  it("prefers an absolute COUNCILKIT_HOME over XDG and normalizes ..", () => {
    const parent = makeParent();
    const home = join(parent, "home");
    expect(
      councilkitHome({
        COUNCILKIT_HOME: join(parent, "home", "..", "home"),
        XDG_CONFIG_HOME: join(parent, "xdg"),
      }),
    ).toBe(home);
  });

  it("resolves a relative COUNCILKIT_HOME against the cwd", () => {
    expect(councilkitHome({ COUNCILKIT_HOME: "rel-councilkit-home" })).toBe(
      resolve("rel-councilkit-home"),
    );
  });

  it("uses XDG_CONFIG_HOME/councilkit when COUNCILKIT_HOME is missing or empty", () => {
    const parent = makeParent();
    const xdg = join(parent, "xdg");
    expect(councilkitHome({ XDG_CONFIG_HOME: xdg })).toBe(join(xdg, "councilkit"));
    expect(councilkitHome({ COUNCILKIT_HOME: "", XDG_CONFIG_HOME: xdg })).toBe(
      join(xdg, "councilkit"),
    );
  });

  it("treats a whitespace COUNCILKIT_HOME or XDG_CONFIG_HOME as unset", () => {
    const parent = makeParent();
    const xdg = join(parent, "xdg");
    const home = join(parent, "home");
    expect(councilkitHome({ COUNCILKIT_HOME: "   ", XDG_CONFIG_HOME: xdg })).toBe(
      join(xdg, "councilkit"),
    );
    expect(councilkitHome({ COUNCILKIT_HOME: `\n\t${home}\t`, XDG_CONFIG_HOME: xdg })).toBe(home);
    expect(councilkitHome({ COUNCILKIT_HOME: "", XDG_CONFIG_HOME: "  " })).toBe(
      resolve(homedir(), ".config", "councilkit"),
    );
  });

  it("falls back to the os home config dir when both overrides are empty", () => {
    const fallback = resolve(homedir(), ".config", "councilkit");
    expect(councilkitHome({})).toBe(fallback);
    expect(councilkitHome({ COUNCILKIT_HOME: "", XDG_CONFIG_HOME: "" })).toBe(fallback);
  });

  it("reads process.env when no env argument is passed", () => {
    const parent = makeParent();
    const home = join(parent, "from-process-env");
    const previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
    try {
      expect(councilkitHome()).toBe(home);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
      else process.env.COUNCILKIT_HOME = previous;
    }
  });
});

describe("resolvePaths", () => {
  it("maps home, registries, and run artifacts for a run id", () => {
    const parent = makeParent();
    const home = join(parent, "cfg");
    const paths = resolvePaths({ COUNCILKIT_HOME: home });
    const runDir = join(home, "runs", "run-1");
    expect({
      home: paths.home,
      agents: paths.agents,
      councils: paths.councils,
      runsRoot: paths.runsRoot,
      runDir: paths.runDir("run-1"),
      transcript: paths.transcript("run-1"),
      report: paths.report("run-1"),
      findings: paths.findings("run-1"),
      planLock: paths.planLock("run-1"),
      landings: paths.landings("run-1"),
    }).toEqual({
      home,
      agents: join(home, "agents.json"),
      councils: join(home, "councils.json"),
      runsRoot: join(home, "runs"),
      runDir,
      transcript: join(runDir, "transcript.jsonl"),
      report: join(runDir, "report.md"),
      findings: join(runDir, "findings.json"),
      planLock: join(runDir, "plan.lock.json"),
      landings: join(runDir, "landings.jsonl"),
    });
  });
});

describe("ensureHome and ensureRunDir", () => {
  it("creates a missing home at 0700 and leaves that mode on a second call", () => {
    const parent = makeParent();
    const home = join(parent, "home");
    const env = { COUNCILKIT_HOME: home };
    expect(ensureHome(env)).toBe(home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(ensureHome(env)).toBe(councilkitHome(env));
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("creates the home and a 0700 run dir, and a second call returns the same path", () => {
    const parent = makeParent();
    const home = join(parent, "home");
    const env = { COUNCILKIT_HOME: home };
    const first = ensureRunDir("run-1", env);
    const second = ensureRunDir("run-b", env);
    expect(first).toBe(join(home, "runs", "run-1"));
    expect(second).toBe(join(home, "runs", "run-b"));
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "runs")).mode & 0o777).toBe(0o700);
    expect(statSync(first).mode & 0o777).toBe(0o700);
    expect(ensureRunDir("run-1", env)).toBe(first);
    expect(statSync(first).mode & 0o777).toBe(0o700);
  });

  it("reports a redacted IO failure when the home parent is a file", () => {
    const parent = makeParent();
    const blocker = join(parent, "blocker");
    writeFileSync(blocker, "x");
    let message = "";
    try {
      ensureHome({ COUNCILKIT_HOME: join(blocker, "home") });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("could not create councilkit home dir (path redacted): IO failure");
    expect(readFileSync(blocker, "utf8")).toBe("x");
  });

  it("reports a redacted IO failure when ensureRunDir cannot create the home", () => {
    const parent = makeParent();
    const blocker = join(parent, "blocker");
    writeFileSync(blocker, "x");
    let message = "";
    try {
      ensureRunDir("run-1", { COUNCILKIT_HOME: join(blocker, "home") });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("could not create councilkit home dir (path redacted): IO failure");
    expect(readFileSync(blocker, "utf8")).toBe("x");
  });

  it("reports a redacted IO failure when runs is a file, and leaves that file in place", () => {
    const parent = makeParent();
    const home = join(parent, "home");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, "runs"), "not-a-dir");
    let message = "";
    try {
      ensureRunDir("run-1", { COUNCILKIT_HOME: home });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("could not create run dir (path redacted): IO failure");
    expect(readFileSync(join(home, "runs"), "utf8")).toBe("not-a-dir");
  });
});
