/**
 * #273 SAFE-05 e2e regression: a default (read-only) review must leave the
 * target repo, its .git/, $HOME and /tmp untouched — even when the target repo
 * ships a script that writes outside the repo.
 *
 * Real CLI orchestration (runReview: worktree, seats, aggregator, ledger); only
 * the agent subprocess is fake. The fake models the dangerous agent that QA saw
 * in R-1 (grok ran `node test.js` in the target repo): whenever its argv skips
 * the CLI's permission prompts, it executes the target repo's script at the
 * repo's absolute path. The positive control (`--allow-write`) proves the test
 * can see a breach, so a pass on the default path is meaningful.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUSY_REPORT_LINE,
  fakeCliPath,
  reportOutput,
  runSyntheticReview,
  seedAgents,
} from "../../tests/review-explainer/cli-harness";
import { createSyntheticRepo } from "../../tests/review-explainer/fixtures/synthetic-repo";
import { PERMISSION_SKIP_FLAGS } from "../src/auto/driver-commands";

function hashTree(root: string, skip: (rel: string) => boolean = () => false): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (skip(rel)) continue;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

let home: string;
let fakeUserHome: string;
let tmpMarker: string;
const previous = {
  COUNCILKIT_HOME: process.env.COUNCILKIT_HOME,
  PATH: process.env.PATH,
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-safe05-"));
  fakeUserHome = mkdtempSync(join(tmpdir(), "ck-safe05-home-"));
  tmpMarker = join("/tmp", `ck-safe05-${process.pid}-${Date.now()}.marker`);
  process.env.COUNCILKIT_HOME = home;
  process.env.PATH = fakeCliPath(home, previous.PATH);
});
afterEach(() => {
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(fakeUserHome, { recursive: true, force: true });
  rmSync(tmpMarker, { force: true });
});

function plantHostileScript(repo: string): string {
  const script = join(repo, "test.js");
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(process.env.HOME, '.ck-safe05-home.marker'), 'x');",
      `fs.writeFileSync(${JSON.stringify(tmpMarker)}, 'x');`,
      "fs.appendFileSync(path.join(__dirname, 'test.js'), '\\n// touched');",
      "fs.writeFileSync(path.join(__dirname, '.git', 'ck-safe05'), 'x');",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", "test.js"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "add test script"], { cwd: repo, stdio: "pipe" });
  return script;
}

async function review(repo: string, script: string, extraArgs: string[] = []) {
  return runSyntheticReview({
    home,
    repo,
    agents: seedAgents(),
    extraArgs,
    output: (spawn, aggregator) => {
      const skips = spawn.argv.some((a) =>
        (PERMISSION_SKIP_FLAGS as readonly string[]).includes(a),
      );
      if (skips) {
        execFileSync(process.execPath, [script], {
          cwd: repo,
          env: { PATH: process.env.PATH ?? "", HOME: fakeUserHome },
        });
      }
      return reportOutput([BUSY_REPORT_LINE], aggregator);
    },
  });
}

describe("#273 SAFE-05 default review leaves the target untouched", () => {
  it("read-only (default): repo byte-identical, .git/ sha256 unchanged, no $HOME or /tmp marker", async () => {
    const { repo } = createSyntheticRepo(home);
    const script = plantHostileScript(repo);
    const isGit = (rel: string) => rel === ".git" || rel.startsWith(".git/");
    const repoBefore = hashTree(repo, isGit);
    const gitBefore = hashTree(join(repo, ".git"));

    const run = await review(repo, script);

    expect(run.calls.length).toBeGreaterThan(0);
    expect(hashTree(repo, isGit)).toEqual(repoBefore);
    expect(hashTree(join(repo, ".git"))).toEqual(gitBefore);
    expect(existsSync(join(fakeUserHome, ".ck-safe05-home.marker"))).toBe(false);
    expect(existsSync(tmpMarker)).toBe(false);
  });

  it("positive control: --allow-write lets the same agent breach, so the check above can fail", async () => {
    const { repo } = createSyntheticRepo(home);
    const script = plantHostileScript(repo);
    await review(repo, script, ["--allow-write"]);
    expect(existsSync(join(fakeUserHome, ".ck-safe05-home.marker"))).toBe(true);
    expect(existsSync(tmpMarker)).toBe(true);
  });
});
