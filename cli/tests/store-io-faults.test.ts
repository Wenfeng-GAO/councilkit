/**
 * Fault injection for store IO branches that a real filesystem will not hit:
 * stalled or partial writes, close/fsync/rename cleanup, non-Error mkdir
 * failures, id collisions, and read races between the two store reads.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors";

const control = vi.hoisted(() => ({
  mkdirSync: null as ((...args: unknown[]) => unknown) | null,
  writeSync: null as ((...args: unknown[]) => unknown) | null,
  closeSync: null as ((...args: unknown[]) => unknown) | null,
  fsyncSync: null as ((...args: unknown[]) => unknown) | null,
  unlinkSync: null as ((...args: unknown[]) => unknown) | null,
  renameSync: null as ((...args: unknown[]) => unknown) | null,
  readFileSync: null as ((...args: unknown[]) => unknown) | null,
  statSync: null as ((...args: unknown[]) => unknown) | null,
  randomUUID: null as (() => string) | null,
}));

const fsActual = vi.hoisted(() => ({
  current: null as typeof import("node:fs") | null,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  fsActual.current = actual;
  const wrap =
    (
      key:
        | "mkdirSync"
        | "writeSync"
        | "closeSync"
        | "fsyncSync"
        | "unlinkSync"
        | "renameSync"
        | "readFileSync"
        | "statSync",
    ) =>
    (...args: unknown[]) => {
      const hook = control[key];
      if (hook) return hook(...args);
      const fn = actual[key] as (...inner: unknown[]) => unknown;
      return fn(...args);
    };
  return {
    ...actual,
    mkdirSync: wrap("mkdirSync"),
    writeSync: wrap("writeSync"),
    closeSync: wrap("closeSync"),
    fsyncSync: wrap("fsyncSync"),
    unlinkSync: wrap("unlinkSync"),
    renameSync: wrap("renameSync"),
    readFileSync: wrap("readFileSync"),
    statSync: wrap("statSync"),
  };
});

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => (control.randomUUID ? control.randomUUID() : actual.randomUUID()),
  };
});

import { atomicWriteFile, readFileText } from "../src/store/atomic-write";
import { ensureHome, ensureRunDir } from "../src/store/paths";
import { Store } from "../src/store/store";

const KIMI = { driverId: "kimi-stream-json" as const, options: {} };
const dirs: string[] = [];

function realFs(): typeof import("node:fs") {
  const current = fsActual.current;
  if (!current) throw new Error("node:fs actual was not captured");
  return current;
}

function makeParent(): string {
  const parent = mkdtempSync(join(tmpdir(), "ck-store-faults-"));
  chmodSync(parent, 0o700);
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

function resetHooks(): void {
  control.mkdirSync = null;
  control.writeSync = null;
  control.closeSync = null;
  control.fsyncSync = null;
  control.unlinkSync = null;
  control.renameSync = null;
  control.readFileSync = null;
  control.statSync = null;
  control.randomUUID = null;
}

function agentInput(name: string) {
  return {
    name,
    personaPrompt: `${name} persona`,
    modelId: "kimi-k2",
    color: "#112233",
    driverSelection: KIMI,
  };
}

afterEach(() => {
  resetHooks();
  for (const dir of dirs.splice(0)) {
    realFs().chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("atomic write faults", () => {
  it("stops when a write returns no bytes and removes the tmp file", () => {
    const parent = makeParent();
    const target = join(parent, "out.txt");
    realFs().writeFileSync(target, "old");
    control.writeSync = () => 0;
    let message = "";
    try {
      atomicWriteFile(target, "abcdef");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("atomic write stalled after 0 bytes");
    expect(realFs().readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reports the number of bytes accepted before a later write stalls", () => {
    const parent = makeParent();
    const target = join(parent, "out.txt");
    let calls = 0;
    control.writeSync = (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        return realFs().writeSync(args[0] as number, args[1] as Buffer, args[2] as number, 2);
      }
      return 0;
    };
    let message = "";
    try {
      atomicWriteFile(target, "abcdef");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("atomic write stalled after 2 bytes");
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("completes a payload that the kernel accepts two bytes at a time", () => {
    const parent = makeParent();
    const target = join(parent, "out.txt");
    control.writeSync = (...args: unknown[]) => {
      const length = args[3] as number;
      return realFs().writeSync(
        args[0] as number,
        args[1] as Buffer,
        args[2] as number,
        Math.min(2, length),
      );
    };
    expect(atomicWriteFile(target, "abcdef")).toBe(6);
    expect(realFs().readFileSync(target, "utf8")).toBe("abcdef");
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the original file when fsync fails", () => {
    const parent = makeParent();
    const target = join(parent, "out.txt");
    realFs().writeFileSync(target, "old");
    control.fsyncSync = () => {
      throw new Error("fsync failed");
    };
    let message = "";
    try {
      atomicWriteFile(target, "new");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("fsync failed");
    expect(realFs().readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("treats a close failure as the write error and preserves the previous file", () => {
    const parent = makeParent();
    const target = join(parent, "out.txt");
    realFs().writeFileSync(target, "old");
    control.closeSync = () => {
      throw new Error("close failed");
    };
    let message = "";
    try {
      atomicWriteFile(target, "new");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("close failed");
    expect(realFs().readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves the original write error when close also fails", () => {
    const parent = makeParent();
    const target = join(parent, "out.txt");
    control.writeSync = () => {
      throw new Error("write failed");
    };
    control.closeSync = () => {
      throw new Error("close failed");
    };
    let message = "";
    try {
      atomicWriteFile(target, "new");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("write failed");
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("still throws the write error when tmp cleanup fails, and leaves the tmp behind", () => {
    const parent = makeParent();
    const target = join(parent, "out.txt");
    realFs().writeFileSync(target, "old");
    control.renameSync = () => {
      const error = new Error("cross device");
      (error as { code?: string }).code = "EXDEV";
      throw error;
    };
    control.unlinkSync = () => {
      throw new Error("unlink failed");
    };
    let caught: { message?: string; code?: string } = {};
    try {
      atomicWriteFile(target, "abc");
    } catch (error) {
      caught = error as { message?: string; code?: string };
    }
    expect(caught.message).toBe("cross device");
    expect(caught.code).toBe("EXDEV");
    expect(realFs().readFileSync(target, "utf8")).toBe("old");
    const tmps = readdirSync(parent).filter((name) => name.endsWith(".tmp"));
    expect(tmps).toEqual([expect.stringMatching(/^\.out\.txt\.[0-9a-f]{12}\.tmp$/)]);
    expect(realFs().readFileSync(join(parent, tmps[0] ?? ""), "utf8")).toBe("abc");
  });
});

describe("readFileText faults", () => {
  it("maps a non-Error stat failure and an Error without a code", () => {
    const parent = makeParent();
    const file = join(parent, "note.txt");
    control.statSync = () => {
      throw "nope";
    };
    const raw = cliError(() => readFileText(file));
    expect(raw.exitCode).toBe(5);
    expect(raw.message).toBe(`cannot stat "${file}": IOFailure`);

    control.statSync = () => {
      throw new Error("stat failed");
    };
    const named = cliError(() => readFileText(file));
    expect(named.exitCode).toBe(5);
    expect(named.message).toBe(`cannot stat "${file}": Error`);

    control.statSync = () => {
      const error = new Error("io");
      (error as { code?: string }).code = "EIO";
      throw error;
    };
    const coded = cliError(() => readFileText(file));
    expect(coded.exitCode).toBe(5);
    expect(coded.message).toBe(`cannot stat "${file}": EIO`);
  });

  it("returns null when read races with deletion after a successful stat", () => {
    const parent = makeParent();
    const file = join(parent, "note.txt");
    realFs().writeFileSync(file, "keep");
    control.readFileSync = () => {
      const error = new Error("gone");
      (error as { code?: string }).code = "ENOENT";
      throw error;
    };
    expect(readFileText(file)).toBeNull();
    expect(realFs().readFileSync(file, "utf8")).toBe("keep");
  });
});

describe("directory creation faults", () => {
  it("redacts a non-Error mkdir failure and a named mkdir failure", () => {
    const parent = makeParent();
    control.mkdirSync = () => {
      throw "boom";
    };
    let raw = "";
    try {
      ensureHome({ COUNCILKIT_HOME: join(parent, "missing") });
    } catch (error) {
      raw = error instanceof Error ? error.message : "";
    }
    expect(raw).toBe("could not create councilkit home dir (path redacted): IO failure");

    control.mkdirSync = () => {
      throw Object.assign(new Error("full"), { name: "DiskFull" });
    };
    let named = "";
    try {
      ensureHome({ COUNCILKIT_HOME: join(parent, "other") });
    } catch (error) {
      named = error instanceof Error ? error.message : "";
    }
    expect(named).toBe("could not create councilkit home dir (path redacted): DiskFull");
    expect(existsSync(join(parent, "missing"))).toBe(false);
    expect(existsSync(join(parent, "other"))).toBe(false);
  });

  it("redacts a named failure while creating a run directory", () => {
    const parent = makeParent();
    const home = join(parent, "home");
    mkdirSync(home, { mode: 0o700 });
    control.mkdirSync = () => {
      throw Object.assign(new Error("full"), { name: "RunDirFailed" });
    };
    let message = "";
    try {
      ensureRunDir("run-1", { COUNCILKIT_HOME: home });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("could not create run dir (path redacted): RunDirFailed");
    expect(existsSync(join(home, "runs"))).toBe(false);
  });
});

describe("store faults", () => {
  it("names a non-Error write failure as IOFailure for agents and councils", () => {
    const parent = makeParent();
    const home = join(parent, "home");
    mkdirSync(home, { mode: 0o700 });
    const store = new Store({ env: { COUNCILKIT_HOME: home } });
    const alpha = store.createAgent(agentInput("alpha"));
    control.writeSync = () => {
      throw "disk";
    };
    const agentErr = cliError(() => store.createAgent(agentInput("beta")));
    expect(agentErr.exitCode).toBe(5);
    expect(agentErr.message).toBe("failed to write agents.json: IOFailure");
    expect(agentErr.detail).toEqual({ cause: "IOFailure" });
    expect(store.listAgents()).toEqual([alpha]);

    resetHooks();
    store.createCouncil({
      name: "jury",
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const before = realFs().readFileSync(join(home, "councils.json"), "utf8");
    control.writeSync = () => {
      throw "disk";
    };
    const councilErr = cliError(() =>
      store.createCouncil({
        name: "next",
        topic: "t",
        agentIds: [alpha.id],
        rounds: 1,
        reporterAgentId: alpha.id,
      }),
    );
    expect(councilErr.exitCode).toBe(5);
    expect(councilErr.message).toBe("failed to write councils.json: IOFailure");
    expect(councilErr.detail).toEqual({ cause: "IOFailure" });
    expect(realFs().readFileSync(join(home, "councils.json"), "utf8")).toBe(before);
  });

  it("rejects an agent id collision and a council id collision", () => {
    const parent = makeParent();
    const home = join(parent, "home");
    mkdirSync(home, { mode: 0o700 });
    control.randomUUID = () => "agent-fixed";
    const store = new Store({ env: { COUNCILKIT_HOME: home } });
    const first = store.createAgent(agentInput("one"));
    expect(first.id).toBe("agent-fixed");
    const agentErr = cliError(() => store.createAgent(agentInput("two")));
    expect(agentErr.exitCode).toBe(2);
    expect(agentErr.message).toBe("agent id collision (retry)");
    expect(store.listAgents().map((row) => row.name)).toEqual(["one"]);

    const ids = ["agent-2", "council-fixed", "council-fixed"];
    control.randomUUID = () => {
      const next = ids.shift();
      if (next === undefined) throw new Error("unexpected randomUUID call");
      return next;
    };
    const second = store.createAgent(agentInput("two"));
    expect(second.id).toBe("agent-2");
    const council = store.createCouncil({
      name: "one",
      topic: "t",
      agentIds: [second.id],
      rounds: 1,
      reporterAgentId: second.id,
    });
    expect(council.id).toBe("council-fixed");
    const councilErr = cliError(() =>
      store.createCouncil({
        name: "two",
        topic: "t",
        agentIds: [second.id],
        rounds: 1,
        reporterAgentId: second.id,
      }),
    );
    expect(councilErr.exitCode).toBe(2);
    expect(councilErr.message).toBe("council id collision (retry)");
    expect(store.listCouncils().map((row) => row.name)).toEqual(["one"]);
  });

  it("reports a disappearing agent, council, and roster target between reads", () => {
    const parent = makeParent();
    const home = join(parent, "home");
    mkdirSync(home, { mode: 0o700 });
    const store = new Store({ env: { COUNCILKIT_HOME: home } });
    const alpha = store.createAgent(agentInput("alpha"));
    const beta = store.createAgent(agentInput("beta"));
    const council = store.createCouncil({
      name: "pr-jury",
      topic: "t",
      agentIds: [alpha.id],
      rounds: 1,
      reporterAgentId: alpha.id,
    });
    const agentsBefore = realFs().readFileSync(join(home, "agents.json"), "utf8");
    const councilsBefore = realFs().readFileSync(join(home, "councils.json"), "utf8");

    let agentReads = 0;
    control.readFileSync = (...args: unknown[]) => {
      if (String(args[0]).endsWith("agents.json")) {
        agentReads += 1;
        if (agentReads >= 2) {
          return `${JSON.stringify({ format: "councilkit-agents", version: 1, agents: [] })}\n`;
        }
      }
      return realFs().readFileSync(
        args[0] as Parameters<typeof import("node:fs").readFileSync>[0],
        args[1] as Parameters<typeof import("node:fs").readFileSync>[1],
      );
    };
    const agentErr = cliError(() => store.deleteAgent(beta.id));
    expect(agentErr.exitCode).toBe(2);
    expect(agentErr.message).toBe(`no agent matches ref "${beta.id}"`);
    resetHooks();
    expect(realFs().readFileSync(join(home, "agents.json"), "utf8")).toBe(agentsBefore);

    let councilReads = 0;
    control.readFileSync = (...args: unknown[]) => {
      if (String(args[0]).endsWith("councils.json")) {
        councilReads += 1;
        if (councilReads >= 2) {
          return `${JSON.stringify({ format: "councilkit-councils", version: 1, councils: [] })}\n`;
        }
      }
      return realFs().readFileSync(
        args[0] as Parameters<typeof import("node:fs").readFileSync>[0],
        args[1] as Parameters<typeof import("node:fs").readFileSync>[1],
      );
    };
    const councilErr = cliError(() => store.deleteCouncil(council.id));
    expect(councilErr.exitCode).toBe(2);
    expect(councilErr.message).toBe(`no council matches ref "${council.id}"`);
    councilReads = 0;
    const syncErr = cliError(() => store.syncCouncilRoster("pr-jury", [alpha, beta], alpha.id));
    expect(syncErr.exitCode).toBe(2);
    expect(syncErr.message).toBe('no council matches ref "pr-jury"');
    resetHooks();
    expect(realFs().readFileSync(join(home, "councils.json"), "utf8")).toBe(councilsBefore);
    expect(store.getCouncil(council.id).name).toBe("pr-jury");
  });
});
