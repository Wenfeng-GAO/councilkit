/**
 * Callers that used to write through a destination symlink.
 * The outside file must stay unchanged.
 */
import type { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IDEATE_EMPTY_MCP, prepareIdeateWorkspace } from "../src/auto/ideate-policy";
import { LiveEventWriter } from "../src/auto/live-events";
import { spawnDeadlineSupervisor } from "../src/auto/repair-deadline-supervisor";
import { readRepairHandoff } from "../src/auto/repair-handoff";
import { appendRepairJournal } from "../src/auto/repair-persist";
import {
  REVIEW_CONTEXT_DIFF,
  REVIEW_CONTEXT_MD,
  copyFrozenContextIntoWorkspace,
  persistFrozenContext,
} from "../src/auto/review-context";
import { defaultSupervisedPolicy, writePolicyIntent } from "../src/auto/squad-gate-policy";

const REPAIR_ID = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const dirs: string[] = [];
let previousHome: string | undefined;

function makeParent(): string {
  const parent = mkdtempSync(join(tmpdir(), "ck-symlink-artifact-"));
  dirs.push(parent);
  return parent;
}

afterEach(() => {
  if (previousHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = previousHome;
  previousHome = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("managed artifact symlink writes", () => {
  it("replaces a gate-policy symlink instead of writing the outside file", () => {
    const parent = makeParent();
    const outside = join(parent, "outside.json");
    const taskDir = join(parent, "task");
    mkdirSync(taskDir);
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, join(taskDir, "councilkit-gate-policy.json"));

    writePolicyIntent(taskDir, defaultSupervisedPolicy(), { taskId: "task-A" });

    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
    const policyPath = join(taskDir, "councilkit-gate-policy.json");
    expect(lstatSync(policyPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(policyPath, "utf8")).toContain('"gate_id": "review"');
  });

  it("persists frozen context over a symlink and copies past a dangling workspace link", () => {
    const parent = makeParent();
    const outside = join(parent, "outside.md");
    const runDir = join(parent, "run");
    const workspace = join(parent, "workspace");
    mkdirSync(runDir);
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, join(runDir, REVIEW_CONTEXT_MD));
    symlinkSync(outside, join(runDir, REVIEW_CONTEXT_DIFF));
    const ctx = {
      headSha: "abc123",
      sourceRef: "HEAD",
      targetRef: "main",
      baseSha: "def456",
      mergeBaseSha: "def456",
      diffHash: "00",
      colorlessDiff: "diff --git a/a b/a\n",
      verifiedCli: "gh pr diff --color=never <url>",
    };

    persistFrozenContext(runDir, ctx);

    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
    expect(lstatSync(join(runDir, REVIEW_CONTEXT_MD)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(runDir, REVIEW_CONTEXT_MD), "utf8")).toContain("abc123");
    expect(readFileSync(join(runDir, REVIEW_CONTEXT_DIFF), "utf8")).toBe(ctx.colorlessDiff);

    const danglingMd = join(parent, "dangling-md");
    const danglingDiff = join(parent, "dangling-diff");
    mkdirSync(workspace);
    symlinkSync(danglingMd, join(workspace, REVIEW_CONTEXT_MD));
    symlinkSync(danglingDiff, join(workspace, REVIEW_CONTEXT_DIFF));
    copyFrozenContextIntoWorkspace(runDir, workspace);

    expect(() => lstatSync(danglingMd)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => lstatSync(danglingDiff)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(lstatSync(join(workspace, REVIEW_CONTEXT_MD)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(workspace, REVIEW_CONTEXT_MD), "utf8")).toContain("abc123");
    expect(readFileSync(join(workspace, REVIEW_CONTEXT_DIFF), "utf8")).toBe(ctx.colorlessDiff);
  });

  it("does not append a repair journal through a symlink or a dangling symlink", () => {
    const parent = makeParent();
    const runDir = join(parent, "run");
    mkdirSync(runDir);
    const outside = join(parent, "outside.jsonl");
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, join(runDir, "journal.jsonl"));

    expect(() => appendRepairJournal(runDir, { kind: "note" })).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");

    const danglingRun = join(parent, "dangling-run");
    const danglingTarget = join(parent, "created-outside.jsonl");
    mkdirSync(danglingRun);
    symlinkSync(danglingTarget, join(danglingRun, "journal.jsonl"));
    expect(() => appendRepairJournal(danglingRun, { kind: "note" })).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(() => lstatSync(danglingTarget)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("does not read or create a handoff through a symlink", () => {
    const parent = makeParent();
    previousHome = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = join(parent, "home");
    const outside = join(parent, "outside.json");
    const dir = join(parent, "handoff");
    mkdirSync(dir);
    writeFileSync(outside, '{"secret":true}\n');
    symlinkSync(outside, join(dir, `${REPAIR_ID}-c1.json`));

    expect(readRepairHandoff({ runId: REPAIR_ID, cycle: 1, directory: dir })).toBeNull();
    expect(readFileSync(outside, "utf8")).toBe('{"secret":true}\n');
    expect(lstatSync(join(dir, `${REPAIR_ID}-c1.json`)).isSymbolicLink()).toBe(true);
  });

  it("replaces a planted ideate .mcp.json symlink", () => {
    const parent = makeParent();
    const outside = join(parent, "outside-mcp.json");
    const workspace = join(parent, "workspace");
    mkdirSync(workspace);
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, join(workspace, ".mcp.json"));

    prepareIdeateWorkspace(workspace);

    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
    const mcp = join(workspace, ".mcp.json");
    expect(lstatSync(mcp).isSymbolicLink()).toBe(false);
    expect(readFileSync(mcp, "utf8")).toBe(IDEATE_EMPTY_MCP);
  });

  it("does not append live events through a symlink", () => {
    const parent = makeParent();
    const outside = join(parent, "outside.jsonl");
    const runDir = join(parent, "run");
    mkdirSync(join(runDir, "live"), { recursive: true });
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, join(runDir, "live", "attempt-0.jsonl"));
    const writer = new LiveEventWriter(runDir, { mergeWindowMs: 60_000 });

    writer.append("attempt-0", [{ type: "tool.completed", name: "Bash", summary: "ls" }]);

    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
    expect(lstatSync(join(runDir, "live", "attempt-0.jsonl")).isSymbolicLink()).toBe(true);
  });

  it("returns the supervisor pid when the log path is a symlink", () => {
    const parent = makeParent();
    const outside = join(parent, "outside.log");
    const logPath = join(parent, "supervisor.log");
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, logPath);

    const result = spawnDeadlineSupervisor({
      cliBin: "unused",
      executionPath: join(parent, "execution.json"),
      logPath,
      spawnImpl: (() => ({ pid: 4242, unref() {} })) as unknown as typeof spawn,
    });

    expect(result).toEqual({ pid: 4242 });
    expect(readFileSync(outside, "utf8")).toBe("SECRET\n");
    expect(lstatSync(logPath).isSymbolicLink()).toBe(true);
  });
});
