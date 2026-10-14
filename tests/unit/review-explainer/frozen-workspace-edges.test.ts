import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import { ExplainerError } from "@shared/runtime/review-explainer/io";
import { upsertPrDecision } from "@shared/runtime/review-explainer/pr-decisions";
import { afterEach, describe, expect, it } from "vitest";
import {
  readFrozenFile,
  readFrozenReview,
  reviewWorkspace,
} from "../../../runtime-host/review-explainer/workspace";
import { FINDING, PR_URL, RUN_ID } from "../../review-explainer/contract";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";

const homes: string[] = [];
const oldHome = process.env.COUNCILKIT_HOME;

afterEach(() => {
  if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = oldHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ck-frozen-ws-"));
  homes.push(home);
  process.env.COUNCILKIT_HOME = home;
  return seedReviewRun(home);
}

function expectExplainer(run: () => unknown, message: string, status: number): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ExplainerError);
  const error = caught as ExplainerError;
  expect(error.message).toBe(message);
  expect(error.status).toBe(status);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function dropManifestRepo(runDir: string): void {
  const path = join(runDir, "invocation-manifest.v1.json");
  const manifest = readJson<Record<string, unknown>>(path);
  manifest.repoRealpath = undefined;
  writeJson(path, manifest);
}

function replaceFinding(
  runDir: string,
  id: string,
  patch: { text?: string; files?: string[]; status?: LedgerFinding["status"] },
): void {
  const path = join(runDir, "findings.json");
  const ledger = readJson<{ findings: Array<Record<string, unknown>> }>(path);
  const row = ledger.findings.find((finding) => finding.id === id);
  if (!row) throw new Error(`missing finding ${id}`);
  Object.assign(row, patch);
  writeJson(path, ledger);
}

describe("frozen review identity and source reads", () => {
  it("rejects a run id that is not a frozen review", () => {
    expectExplainer(
      () => readFrozenReview("ck-run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01"),
      "Invalid review Run identity",
      400,
    );
    expectExplainer(() => readFrozenReview("not-a-run"), "Invalid review Run identity", 400);
  });

  it("rejects a corrupt invocation manifest before reading identity", () => {
    const seeded = setup();
    writeFileSync(join(seeded.runDir, "invocation-manifest.v1.json"), "{");
    expectExplainer(() => readFrozenReview(RUN_ID), "Corrupt frozen invocation manifest", 400);
  });

  it("rejects a ledger whose frozen sha is not a commit id", () => {
    const seeded = setup();
    const path = join(seeded.runDir, "findings.json");
    const ledger = readJson<{ sha: string }>(path);
    ledger.sha = "g".repeat(40);
    writeJson(path, ledger);
    expectExplainer(() => readFrozenReview(RUN_ID), "Invalid finding ledger or frozen SHA", 400);
  });

  it("rejects an invocation manifest that names a different review", () => {
    const seeded = setup();
    const path = join(seeded.runDir, "invocation-manifest.v1.json");
    const manifest = readJson<{ kind: string }>(path);
    manifest.kind = "other-manifest";
    writeJson(path, manifest);
    expectExplainer(() => readFrozenReview(RUN_ID), "Frozen invocation identity mismatch", 400);
  });

  it("rejects an incomplete hunk instead of showing a partial diff", () => {
    const seeded = setup();
    const diff = [
      "diff --git a/src/busy.go b/src/busy.go",
      "--- a/src/busy.go",
      "+++ b/src/busy.go",
      "@@ -1,2 +1,2 @@",
      " only-one",
      "",
    ].join("\n");
    const previous = readFileSync(join(seeded.runDir, "review-context.diff"), "utf8");
    const previousHash = createHash("sha256").update(previous).digest("hex");
    const nextHash = createHash("sha256").update(diff).digest("hex");
    writeFileSync(join(seeded.runDir, "review-context.diff"), diff);
    for (const rel of ["review-context.md", "review-explainer/identity.json"]) {
      const path = join(seeded.runDir, rel);
      writeFileSync(path, readFileSync(path, "utf8").split(previousHash).join(nextHash));
    }
    expectExplainer(() => readFrozenReview(RUN_ID), "Corrupt or incomplete frozen diff hunks", 400);
  });

  it("reads identity.json and its repo path when review context markdown is gone", () => {
    const seeded = setup();
    rmSync(join(seeded.runDir, "review-context.md"));
    dropManifestRepo(seeded.runDir);
    const frozen = readFrozenReview(RUN_ID);
    expect(frozen.identity).toEqual({
      prUrl: PR_URL,
      headSha: seeded.repo.headSha,
      baseSha: seeded.repo.baseSha,
      mergeBaseSha: seeded.repo.mergeBaseSha,
      diffHash: seeded.repo.diffHash,
    });
    expect(frozen.repo).toBe(seeded.repo.repo);
    const file = readFrozenFile(frozen, "src/busy.go", "new");
    const text = seeded.repo.blobs.new["src/busy.go"] ?? "";
    expect(file).toEqual({
      path: "src/busy.go",
      side: "new",
      sha: seeded.repo.headSha,
      availability: "available",
      text,
      lines: text.split("\n").map((line, index) => ({ number: index + 1, text: line })),
    });
  });

  it("says identity is unavailable when both context markdown and identity.json are missing", () => {
    const seeded = setup();
    rmSync(join(seeded.runDir, "review-context.md"));
    rmSync(join(seeded.runDir, "review-explainer", "identity.json"));
    expectExplainer(() => readFrozenReview(RUN_ID), "Frozen review identity is unavailable", 404);
  });

  it("rejects corrupt identity.json when context markdown is missing", () => {
    const seeded = setup();
    rmSync(join(seeded.runDir, "review-context.md"));
    writeFileSync(join(seeded.runDir, "review-explainer", "identity.json"), "{");
    expectExplainer(() => readFrozenReview(RUN_ID), "Corrupt frozen identity", 400);
  });

  it("does not invent a repository when identity.json has no repo path", () => {
    const seeded = setup();
    rmSync(join(seeded.runDir, "review-context.md"));
    dropManifestRepo(seeded.runDir);
    const identityPath = join(seeded.runDir, "review-explainer", "identity.json");
    const identity = readJson<Record<string, unknown>>(identityPath);
    identity.repoPath = null;
    writeJson(identityPath, identity);
    expectExplainer(
      () => readFrozenFile(readFrozenReview(RUN_ID), "src/busy.go", "new"),
      "Frozen repository location is unavailable",
      404,
    );
  });

  it("refuses a symlink repository and a missing blob instead of the working tree", () => {
    const seeded = setup();
    const link = join(seeded.home, "repo-link");
    symlinkSync(seeded.repo.repo, link);
    const manifestPath = join(seeded.runDir, "invocation-manifest.v1.json");
    const manifest = readJson<{ repoRealpath: string }>(manifestPath);
    manifest.repoRealpath = link;
    writeJson(manifestPath, manifest);
    const identityPath = join(seeded.runDir, "review-explainer", "identity.json");
    const identity = readJson<{ repoPath: string }>(identityPath);
    identity.repoPath = link;
    writeJson(identityPath, identity);
    expectExplainer(
      () => readFrozenFile(readFrozenReview(RUN_ID), "src/busy.go", "new"),
      "Frozen source blob unavailable; current checkout is not a substitute",
      404,
    );

    manifest.repoRealpath = seeded.repo.repo;
    writeJson(manifestPath, manifest);
    identity.repoPath = seeded.repo.repo;
    writeJson(identityPath, identity);
    const blob = git(seeded.repo.repo, ["rev-parse", "HEAD:src/busy.go"]);
    rmSync(join(seeded.repo.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    expectExplainer(
      () => readFrozenFile(readFrozenReview(RUN_ID), "src/busy.go", "new"),
      "Frozen source blob unavailable; current checkout is not a substitute",
      404,
    );
  });

  it("refuses a frozen blob larger than 2 MiB", () => {
    const seeded = setup();
    const huge = "h".repeat(2 * 1024 * 1024 + 8);
    writeFileSync(join(seeded.repo.repo, "src/busy.go"), huge);
    git(seeded.repo.repo, ["add", "src/busy.go"]);
    git(seeded.repo.repo, ["commit", "-m", "oversized busy blob"]);
    const head = git(seeded.repo.repo, ["rev-parse", "HEAD"]);
    const mdPath = join(seeded.runDir, "review-context.md");
    writeFileSync(
      mdPath,
      readFileSync(mdPath, "utf8").replace(/^- head: `[a-f0-9]{40}`$/m, `- head: \`${head}\``),
    );
    const manifestPath = join(seeded.runDir, "invocation-manifest.v1.json");
    const manifest = readJson<{ reviewedSha: string }>(manifestPath);
    manifest.reviewedSha = head;
    writeJson(manifestPath, manifest);
    const identityPath = join(seeded.runDir, "review-explainer", "identity.json");
    const identity = readJson<{ headSha: string }>(identityPath);
    identity.headSha = head;
    writeJson(identityPath, identity);
    const ledgerPath = join(seeded.runDir, "findings.json");
    const ledger = readJson<{ sha: string }>(ledgerPath);
    ledger.sha = head;
    writeJson(ledgerPath, ledger);
    expectExplainer(
      () => readFrozenFile(readFrozenReview(RUN_ID), "src/busy.go", "new"),
      "Frozen file exceeds readable size limit",
      413,
    );
  });

  it("keeps an out-of-hunk citation unresolved when the frozen repository cannot be read", () => {
    const seeded = setup();
    replaceFinding(seeded.runDir, FINDING.busy, {
      text: `src/busy.go:${seeded.repo.busyContextLine}`,
      files: ["src/busy.go"],
    });
    rmSync(seeded.repo.repo, { recursive: true, force: true });
    const workspace = reviewWorkspace(RUN_ID);
    const finding = workspace.findings.find((row) => row.id === FINDING.busy);
    expect(finding?.anchors).toEqual([
      { status: "unresolved", reason: "代码与引用不匹配，位置待确认" },
    ]);
  });

  it("reports a finding with no file:line citation as unresolved", () => {
    const seeded = setup();
    replaceFinding(seeded.runDir, FINDING.unanchored, {
      text: "原评审没有给出文件和行号。",
      files: [],
    });
    const workspace = reviewWorkspace(RUN_ID);
    const finding = workspace.findings.find((row) => row.id === FINDING.unanchored);
    expect(finding?.anchors).toEqual([
      { status: "unresolved", reason: "原评审未提供可确认的文件与行号" },
    ]);
  });

  it("collapses a repeated citation and keeps an old-side phrase on the old blob", () => {
    const seeded = setup();
    const line = seeded.repo.busyNewLine;
    const snippet = seeded.repo.blobs.new["src/busy.go"]?.split("\n")[line - 1] ?? "";
    replaceFinding(seeded.runDir, FINDING.busy, {
      text: `src/busy.go:${line} repeated src/busy.go:${line}`,
      files: ["src/busy.go"],
    });
    replaceFinding(seeded.runDir, FINDING.stale, {
      text: "请看旧侧 src/busy.go:1",
      files: ["src/busy.go"],
    });
    const workspace = reviewWorkspace(RUN_ID);
    expect(workspace.findings.find((row) => row.id === FINDING.busy)?.anchors).toEqual([
      {
        status: "resolved",
        path: "src/busy.go",
        side: "new",
        line,
        endLine: line,
        snippet,
      },
    ]);
    expect(workspace.findings.find((row) => row.id === FINDING.stale)?.anchors).toEqual([
      {
        status: "context",
        path: "src/busy.go",
        side: "old",
        line: 1,
        endLine: 1,
        snippet: "package session",
      },
    ]);
  });

  it("projects a saved decision reason and treats an accepted finding as wont_fix", () => {
    const seeded = setup();
    replaceFinding(seeded.runDir, FINDING.dup, { status: "accepted" });
    const busy = readFrozenReview(RUN_ID).findings.find((row) => row.id === FINDING.busy);
    if (!busy) throw new Error("missing busy finding");
    upsertPrDecision({
      prUrl: PR_URL,
      finding: busy,
      decision: "will_fix",
      expectedRevision: 0,
      sourceRunId: RUN_ID,
      reason: "补上所有权回归",
    });
    const workspace = reviewWorkspace(RUN_ID);
    expect(workspace.findings.find((row) => row.id === FINDING.busy)).toMatchObject({
      decision: "will_fix",
      decisionReason: "补上所有权回归",
    });
    expect({
      decision: workspace.findings.find((row) => row.id === FINDING.dup)?.decision,
      decisionReason: workspace.findings.find((row) => row.id === FINDING.dup)?.decisionReason,
    }).toEqual({ decision: "wont_fix", decisionReason: undefined });
    expect(workspace.revision).toBe(1);
  });

  it("keeps the original report readable when the frozen diff file is missing", () => {
    const seeded = setup();
    rmSync(join(seeded.runDir, "review-context.diff"));
    const workspace = reviewWorkspace(RUN_ID);
    expect({
      availability: workspace.availability,
      notice: workspace.notice,
      files: workspace.files,
      headSha: workspace.identity.headSha,
    }).toEqual({
      availability: "missing",
      notice: "冻结 diff 工件缺失，无法展示代码；评审原文仍可阅读。",
      files: [],
      headSha: seeded.repo.headSha,
    });
    expect(workspace.originalReport).toContain("Synthetic explainer fixture. Not PR 128.");
  });
});
