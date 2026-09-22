import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveCliRunsRoot, resolveCouncilkitHome } from "@shared/runtime/cli-home";
import { type LedgerFinding, parseFindingsFile } from "@shared/runtime/cli-ledger";
import { isCliRunId, readCliRun } from "@shared/runtime/cli-runs-index";
import { resolveFindingAnchor } from "@shared/runtime/review-explainer/anchors";
import type {
  DiffFile,
  FindingAnchor,
  FrozenFileContent,
  FrozenIdentity,
  ReviewExplainerWorkspace,
} from "@shared/runtime/review-explainer/contracts";
import { parseFrozenDiff, repoPath, summarizeDiff } from "@shared/runtime/review-explainer/diff";
import {
  ExplainerError,
  assertPrivatePath,
  readBounded,
} from "@shared/runtime/review-explainer/io";
import {
  canonicalPr,
  decisionForFinding,
  loadPrDecisions,
} from "@shared/runtime/review-explainer/pr-decisions";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const FILE_CAP = 2 * 1024 * 1024;
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function runDirectory(runId: string): string {
  if (!isCliRunId(runId) || !runId.startsWith("ck-review-"))
    throw new ExplainerError("Invalid review Run identity");
  const root = resolveCliRunsRoot(process.env);
  const dir = join(root, runId);
  assertPrivatePath(root, dir);
  return dir;
}
function artifact(dir: string, path: string, cap: number, optional = false): string | null {
  const file = join(dir, path);
  assertPrivatePath(dir, file, optional);
  return readBounded(file, cap, optional);
}
export interface FrozenReview {
  dir: string;
  identity: FrozenIdentity;
  repo: string | null;
  files: DiffFile[];
  findings: LedgerFinding[];
  originalReport: string;
  availability: "available" | "missing";
  notice?: string;
}
export function readFrozenReview(runId: string): FrozenReview {
  const dir = runDirectory(runId);
  const ledgerRaw = artifact(dir, "findings.json", 4 * 1024 * 1024);
  const ledger = ledgerRaw ? parseFindingsFile(ledgerRaw) : null;
  if (!ledger || ledger.runId !== runId || !SHA.test(ledger.sha ?? ""))
    throw new ExplainerError("Invalid finding ledger or frozen SHA");
  const md = artifact(dir, "review-context.md", 64000, true);
  const manifestRaw = artifact(dir, "invocation-manifest.v1.json", 512000, true);
  let manifest: {
    runId?: string;
    kind?: string;
    reviewedSha?: string;
    repoRealpath?: string;
    task?: { pr?: string };
  } = {};
  try {
    if (manifestRaw) manifest = JSON.parse(manifestRaw);
  } catch {
    throw new ExplainerError("Corrupt frozen invocation manifest");
  }
  if (
    manifestRaw &&
    (manifest.runId !== runId ||
      manifest.kind !== "councilkit-invocation-manifest" ||
      manifest.reviewedSha !== ledger.sha)
  )
    throw new ExplainerError("Frozen invocation identity mismatch");
  const run = readCliRun(runId);
  const prUrl = canonicalPr(manifest.task?.pr ?? run?.reviewEvidence?.prUrl ?? "");
  const take = (name: string) =>
    new RegExp(`^- ${name}: \\x60([^\\x60]+)\\x60`, "m").exec(md ?? "")?.[1] ?? "";
  let identity: FrozenIdentity = {
    prUrl,
    headSha: take("head"),
    baseSha: take("base"),
    mergeBaseSha: take("merge-base"),
    diffHash: take("colorless diff sha256"),
  };
  let repo = typeof manifest.repoRealpath === "string" ? manifest.repoRealpath : null;
  if (!md) {
    const saved = artifact(dir, "review-explainer/identity.json", 64000, true);
    if (!saved) throw new ExplainerError("Frozen review identity is unavailable", 404);
    try {
      const data = JSON.parse(saved);
      identity = {
        prUrl,
        headSha: data.headSha,
        baseSha: data.baseSha,
        mergeBaseSha: data.mergeBaseSha,
        diffHash: data.diffHash,
      };
      repo ??= typeof data.repoPath === "string" ? data.repoPath : null;
    } catch {
      throw new ExplainerError("Corrupt frozen identity");
    }
  }
  if (
    ![identity.headSha, identity.baseSha, identity.mergeBaseSha].every(
      (sha) => typeof sha === "string" && SHA.test(sha),
    ) ||
    !HASH.test(identity.diffHash) ||
    identity.headSha !== ledger.sha
  )
    throw new ExplainerError("Invalid frozen source identity");
  const diff = artifact(dir, "review-context.diff", 16 * 1024 * 1024, true);
  const originalReport = artifact(dir, "report.md", 2 * 1024 * 1024, true) ?? "";
  if (diff === null)
    return {
      dir,
      identity,
      repo,
      findings: ledger.findings,
      files: [],
      originalReport,
      availability: "missing",
      notice: "冻结 diff 工件缺失，无法展示代码；评审原文仍可阅读。",
    };
  if (digest(diff) !== identity.diffHash)
    throw new ExplainerError("Corrupt frozen diff: hash mismatch");
  const parsed = parseFrozenDiff(diff);
  if (parsed.warnings.length) throw new ExplainerError("Corrupt or incomplete frozen diff hunks");
  return {
    dir,
    identity,
    repo,
    findings: ledger.findings,
    files: parsed.files,
    originalReport,
    availability: "available",
  };
}
function gitBlob(frozen: FrozenReview, path: string, side: "old" | "new"): FrozenFileContent {
  const sha = side === "old" ? frozen.identity.mergeBaseSha : frozen.identity.headSha;
  if (!frozen.repo) throw new ExplainerError("Frozen repository location is unavailable", 404);
  try {
    if (!lstatSync(frozen.repo).isDirectory() || lstatSync(frozen.repo).isSymbolicLink())
      throw new Error("invalid repo");
    const cwd = realpathSync(frozen.repo);
    const spec = `${sha}:${repoPath(path)}`;
    const size = Number(
      execFileSync("git", ["cat-file", "-s", spec], {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    );
    if (!Number.isSafeInteger(size) || size > FILE_CAP)
      throw new ExplainerError("Frozen file exceeds readable size limit", 413);
    const data = execFileSync("git", ["cat-file", "blob", spec], {
      cwd,
      timeout: 5000,
      maxBuffer: FILE_CAP,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (data.includes(0)) return { path, side, sha, availability: "binary", text: "", lines: [] };
    const text = data.toString("utf8");
    return {
      path,
      side,
      sha,
      availability: "available",
      text,
      lines: text.split("\n").map((line, index) => ({ number: index + 1, text: line })),
    };
  } catch (error) {
    if (error instanceof ExplainerError) throw error;
    throw new ExplainerError(
      "Frozen source blob unavailable; current checkout is not a substitute",
      404,
    );
  }
}
export function readFrozenFile(
  frozen: FrozenReview,
  requestedPath: string,
  side: "old" | "new",
): FrozenFileContent {
  const path = repoPath(requestedPath);
  const file = frozen.files.find(
    (row) => row.path === path || row.oldPath === path || row.newPath === path,
  );
  if (!file) throw new ExplainerError("File not in permitted frozen diff", 403);
  const actual = side === "old" ? file.oldPath : file.newPath;
  const sha = side === "old" ? frozen.identity.mergeBaseSha : frozen.identity.headSha;
  if (!actual) return { path, side, sha, availability: "absent", text: "", lines: [] };
  if (file.binary) return { path: actual, side, sha, availability: "binary", text: "", lines: [] };
  return gitBlob(frozen, actual, side);
}
function findingAnchors(frozen: FrozenReview, finding: LedgerFinding): FindingAnchor[] {
  const text = `${finding.text}\n${finding.title}`;
  const refs = [...text.matchAll(/([\w.\-/]+\.[\w]+):(\d+)(?:-(\d+))?/g)].slice(0, 30);
  const anchors: FindingAnchor[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const path = ref[1] ?? "";
    const line = Number(ref[2]);
    const file = frozen.files.find((row) => [row.path, row.oldPath, row.newPath].includes(path));
    const side =
      file?.status === "deleted" ||
      /old side|旧侧|old-side/i.test(text.slice(Math.max(0, (ref.index ?? 0) - 90), ref.index))
        ? "old"
        : "new";
    const key = `${path}:${side}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let anchor = resolveFindingAnchor({
      parsedDiff: frozen,
      findingId: finding.id,
      path,
      side,
      line,
    });
    if (anchor.status === "unresolved" && file && !file.binary) {
      try {
        const content = readFrozenFile(frozen, path, side);
        const found = content.lines.find((row) => row.number === line);
        if (found)
          anchor = {
            status: "context",
            path: content.path,
            side,
            line,
            endLine: Number(ref[3] ?? line),
            snippet: found.text,
          };
      } catch {
        /* keep diagnostic anchor; never use current checkout */
      }
    }
    anchors.push(anchor);
  }
  return anchors.length
    ? anchors
    : [{ status: "unresolved", reason: "原评审未提供可确认的文件与行号" }];
}
export function reviewWorkspace(runId: string): ReviewExplainerWorkspace {
  const frozen = readFrozenReview(runId);
  const decisions = loadPrDecisions(frozen.identity.prUrl, resolveCouncilkitHome(process.env));
  return {
    runId,
    identity: frozen.identity,
    files: frozen.files,
    findings: frozen.findings.map((row) => ({
      ...row,
      anchors: findingAnchors(frozen, row),
      decision:
        decisionForFinding(decisions, row)?.decision ??
        (row.status === "accepted" ? "wont_fix" : "undecided"),
    })),
    decisions,
    revision: decisions.revision,
    originalReport: frozen.originalReport,
    totals: summarizeDiff(frozen),
    availability: frozen.availability,
    ...(frozen.notice ? { notice: frozen.notice } : {}),
  };
}
