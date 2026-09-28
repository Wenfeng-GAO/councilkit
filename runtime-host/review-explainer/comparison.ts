import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ReviewComparison,
  ReviewComparisonMode,
} from "@shared/runtime/review-explainer/contracts";
import { parseFrozenDiff, summarizeDiff } from "@shared/runtime/review-explainer/diff";
import { readFrozenReview } from "./workspace";

const SHA = /^[a-f0-9]{40}$/;
const DIFF_CAP = 16 * 1024 * 1024;

/** Read only immutable objects; never refresh the checkout or fetch missing history. */
export function reviewComparison(runId: string, mode: ReviewComparisonMode): ReviewComparison {
  const frozen = readFrozenReview(runId);
  let fromSha: string | null = mode === "full" ? frozen.identity.mergeBaseSha : null;
  const toSha = frozen.identity.headSha;
  const unavailable = (
    reason: NonNullable<ReviewComparison["reason"]>,
    notice: string,
  ): ReviewComparison => ({
    mode,
    fromSha,
    toSha,
    availability: "unavailable",
    reason,
    notice,
    files: [],
    totals: summarizeDiff({ files: [] }),
  });
  if (mode === "full") {
    if (frozen.availability !== "available")
      return unavailable("diff_unavailable", frozen.notice ?? "冻结全量 diff 不可用。");
    return {
      mode,
      fromSha,
      toSha,
      availability: "available",
      files: frozen.files,
      totals: summarizeDiff(frozen),
    };
  }

  let cwd: string;
  let gitDir: string | undefined;
  let objects: string;
  // Ignore caller Git overrides as well as system/global configuration. The original
  // repository is used only to locate its object store, never to format this diff.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (args: string[], maxBuffer = 64 * 1024) =>
    execFileSync(
      "git",
      [
        "--no-pager",
        "--no-replace-objects",
        ...(gitDir ? [`--git-dir=${gitDir}`, "-c", "core.attributesFile=/dev/null"] : []),
        ...args,
      ],
      {
        cwd: gitDir ?? cwd,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
        // A partial clone must report missing objects, not lazily fetch over the network.
        env: {
          ...environment,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          ...(gitDir ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects) } : {}),
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
  try {
    if (!frozen.repo) throw new Error("missing repository");
    const stat = lstatSync(frozen.repo);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid repository");
    cwd = realpathSync(frozen.repo);
    if (realpathSync(git(["rev-parse", "--show-toplevel"]).trim()) !== cwd)
      throw new Error("repository moved");
    objects = realpathSync(resolve(cwd, git(["rev-parse", "--git-path", "objects"]).trim()));
    if (!lstatSync(objects).isDirectory()) throw new Error("missing object store");
  } catch {
    return unavailable("repository_missing", "冻结仓库不可用，无法读取最后一次提交。");
  }

  try {
    // Own metadata prevents repository info/attributes, shallow markers, grafts and
    // diff configuration from changing the meaning of the two frozen object IDs.
    gitDir = mkdtempSync(join(tmpdir(), "ck-review-comparison-"));
    mkdirSync(join(gitDir, "objects"), { mode: 0o700 });
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/frozen\n", { mode: 0o600 });
    writeFileSync(join(gitDir, "config"), "[core]\n bare = true\n", { mode: 0o600 });
    writeFileSync(join(gitDir, "refs", "heads", "frozen"), `${toSha}\n`, { mode: 0o600 });
    try {
      if (git(["cat-file", "-t", toSha]).trim() !== "commit") throw new Error("invalid head");
    } catch {
      return unavailable("commit_missing", "冻结提交对象不可用，不会使用当前 HEAD 替代。");
    }
    // %(parent) reads commit headers without emitting the message or traversing
    // parent objects. It preserves the raw parent even when the source is shallow.
    const parents = git(["for-each-ref", "--format=%(parent)", "refs/heads/frozen"]).trim();
    const parent = parents.split(" ")[0];
    if (!parent)
      return unavailable("parent_missing", "冻结提交没有可用的第一父提交，无法显示最后一次提交。");
    if (!SHA.test(parent)) throw new Error("invalid parent header");
    fromSha = parent;
    try {
      if (git(["cat-file", "-t", parent]).trim() !== "commit") throw new Error("invalid parent");
    } catch {
      return unavailable("parent_missing", "冻结提交的第一父提交对象缺失，无法显示最后一次提交。");
    }

    const diff = git(
      [
        `--attr-source=${toSha}`,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--find-renames=50%",
        parent,
        toSha,
        "--",
      ],
      DIFF_CAP,
    );
    const parsed = parseFrozenDiff(diff);
    if (parsed.warnings.length) throw new Error("incomplete diff");
    return {
      mode,
      fromSha,
      toSha,
      availability: "available",
      files: parsed.files,
      totals: summarizeDiff(parsed),
    };
  } catch {
    return unavailable("diff_unavailable", "冻结提交 diff 不可用或超过读取限制，请查看全量变更。");
  } finally {
    if (gitDir) rmSync(gitDir, { recursive: true, force: true });
  }
}
