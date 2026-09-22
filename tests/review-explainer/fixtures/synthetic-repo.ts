import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUSY_SNIPPET,
  DELETED_SNIPPET,
  DUP_SNIPPET,
  HIDDEN_CONTEXT_SNIPPET,
  JAVA_SNIPPET,
  README_SNIPPET,
  RENAME_SNIPPET,
  STALE_SNIPPET,
} from "./sample-diff";

export interface SyntheticRepo {
  repo: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  diff: string;
  diffHash: string;
  busyNewLine: number;
  busyContextLine: number;
  staleNewLine: number;
  dupNewLine: number;
  deletedOldLine: number;
  blobs: {
    old: Record<string, string>;
    new: Record<string, string>;
  };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function lineOf(source: string, snippet: string): number {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => line.includes(snippet));
  if (index < 0) throw new Error(`snippet not found: ${snippet}`);
  return index + 1;
}

export function createSyntheticRepo(root: string): SyntheticRepo {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "explainer@test"]);
  git(repo, ["config", "user.name", "Explainer Fixture"]);

  const unchangedPreamble = [
    HIDDEN_CONTEXT_SNIPPET,
    ...Array.from({ length: 14 }, (_, n) => `// ownership contract context ${n + 1}`),
    "",
  ];
  const busyBase = [
    "package session",
    "",
    ...unchangedPreamble,
    "func Handle(req Request) error {",
    '    if req.Kind == "prompt" {',
    "        return nil",
    "    }",
    "    return nil",
    "}",
    "",
  ].join("\n");
  const deletedBase = ["package deleted", "", DELETED_SNIPPET, "    return nil", "}", ""].join(
    "\n",
  );
  const oldNameBase = ["package renamed", "", "func Helper() {}", ""].join("\n");
  const readmeBase = ["# Fixture", "Keep this file without a review comment.", ""].join("\n");
  const javaBase = ["class WideCoverage {", "    void existing() {}", "}", ""].join("\n");

  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "README.md"), readmeBase);
  writeFileSync(join(repo, "src/busy.go"), busyBase);
  writeFileSync(join(repo, "src/deleted.go"), deletedBase);
  writeFileSync(join(repo, "src/old_name.go"), oldNameBase);
  writeFileSync(join(repo, "tests/WideCoverage.java"), javaBase);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  const busyHead = [
    "package session",
    "",
    ...unchangedPreamble,
    "func Handle(req Request) error {",
    '    if req.Kind == "prompt" {',
    "        state.Accept(req)",
    "        if manager.Busy() {",
    `            ${BUSY_SNIPPET}`,
    "        }",
    "        return nil",
    "    }",
    "    return nil",
    "}",
    "",
  ].join("\n");
  const recoveryHead = [
    "package recovery",
    "",
    "func Restore() error {",
    `    ${STALE_SNIPPET}`,
    "        return commitLate()",
    "    }",
    "    return nil",
    "}",
    "",
    "func Dup() error {",
    `    ${DUP_SNIPPET}`,
    "}",
    "",
  ].join("\n");
  const renamedHead = ["package renamed", "", RENAME_SNIPPET, "func Helper() {}", ""].join("\n");
  const readmeHead = [
    "# Fixture",
    README_SNIPPET,
    "Keep this file without a review comment.",
    "",
  ].join("\n");
  const javaHead = [
    "class WideCoverage {",
    `    ${JAVA_SNIPPET}`,
    "    void existing() {}",
    "}",
    "",
  ].join("\n");

  writeFileSync(join(repo, "README.md"), readmeHead);
  writeFileSync(join(repo, "src/busy.go"), busyHead);
  writeFileSync(join(repo, "src/recovery.go"), recoveryHead);
  writeFileSync(join(repo, "src/renamed.go"), renamedHead);
  writeFileSync(join(repo, "tests/WideCoverage.java"), javaHead);
  mkdirSync(join(repo, "assets"), { recursive: true });
  writeFileSync(join(repo, "assets/icon.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 9]));
  git(repo, ["rm", "src/deleted.go"]);
  git(repo, ["rm", "src/old_name.go"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "head"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const mergeBaseSha = git(repo, ["merge-base", baseSha, headSha]);
  const diff = execFileSync(
    "git",
    ["diff", "--no-color", "--no-ext-diff", `${mergeBaseSha}...${headSha}`],
    {
      cwd: repo,
      encoding: "utf8",
    },
  );

  return {
    repo,
    headSha,
    baseSha,
    mergeBaseSha,
    diff,
    diffHash: createHash("sha256").update(diff, "utf8").digest("hex"),
    busyNewLine: lineOf(busyHead, BUSY_SNIPPET),
    busyContextLine: lineOf(busyHead, HIDDEN_CONTEXT_SNIPPET),
    staleNewLine: lineOf(recoveryHead, STALE_SNIPPET),
    dupNewLine: lineOf(recoveryHead, DUP_SNIPPET),
    deletedOldLine: lineOf(deletedBase, DELETED_SNIPPET),
    blobs: {
      old: {
        "README.md": readmeBase,
        "src/busy.go": busyBase,
        "src/deleted.go": deletedBase,
        "src/old_name.go": oldNameBase,
        "tests/WideCoverage.java": javaBase,
      },
      new: {
        "README.md": readmeHead,
        "src/busy.go": busyHead,
        "src/recovery.go": recoveryHead,
        "src/renamed.go": renamedHead,
        "tests/WideCoverage.java": javaHead,
      },
    },
  };
}
