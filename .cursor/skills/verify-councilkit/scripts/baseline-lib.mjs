/**
 * Shared helpers for the baseline-relative lint, test, and e2e steps.
 * Pure comparisons live here so a self-test can pin them without Biome, Vitest, or Playwright.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LINT_PREFIXES = ["src/", "shared/", "runtime-host/", "tests/", "scripts/", "cli/"];
const LINT_FILES = new Set(["playwright.config.ts", "playwright.review-explainer.config.ts"]);
const LINT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".json",
  ".jsonc",
  ".css",
]);
const SKIP_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "dist-host",
  "coverage",
  "test-results",
  "playwright-report",
]);

const NON_PRODUCT_PREFIXES = [".cursor/", "artifacts/verify/"];
const NON_PRODUCT_EXACT = new Set([".gitignore"]);

export function assertNode22() {
  const major = process.versions.node.split(".")[0];
  if (major === "22") return;
  process.stderr.write(
    `CouncilKit Runtime Host requires Node.js 22.x. Current node is ${process.version}. Set COUNCILKIT_NODE to a Node 22 binary.\n`,
  );
  process.exit(1);
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) out[key] = true;
    else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

export function resolveMergeBase(repo) {
  const candidates = ["origin/main", "origin/master", "main", "master"];
  for (const ref of candidates) {
    const verify = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repo,
      encoding: "utf8",
    });
    if (verify.status !== 0) continue;
    const base = spawnSync("git", ["merge-base", "HEAD", ref], {
      cwd: repo,
      encoding: "utf8",
    });
    if (base.status !== 0) continue;
    const sha = base.stdout.trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return { sha, ref };
  }
  return null;
}

export function gitOutput(repo, args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

/** `git diff -z --name-status` records. Rename and copy keep both paths. */
export function recordsFromNameStatusZ(text) {
  const parts = text.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  const records = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    i += 1;
    if (!status) break;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = parts[i];
      const to = parts[i + 1];
      i += 2;
      records.push({ kind, from, to });
    } else {
      const path = parts[i];
      i += 1;
      records.push({ kind, from: path, to: path });
    }
  }
  return records;
}

export function changedRecords(repo, mergeBase) {
  const diff = gitOutput(repo, [
    "diff",
    "-z",
    "--name-status",
    "-M",
    "--find-renames",
    mergeBase,
  ]);
  const untracked = gitOutput(repo, ["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter((path) => path.length > 0);
  return { records: recordsFromNameStatusZ(diff), untracked };
}

export function extensionOf(path) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return "";
  return path.slice(dot);
}

export function inLintScope(path) {
  if (!path || path.endsWith("/")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => SKIP_SEGMENTS.has(segment))) return false;
  if (path === "tests/fixtures" || path.startsWith("tests/fixtures/")) return false;
  if (LINT_FILES.has(path)) return LINT_EXTENSIONS.has(extensionOf(path));
  if (!LINT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return LINT_EXTENSIONS.has(extensionOf(path));
}

/** Repo-root Biome config. A nested `biome.json` does not drive the lint step. */
export function isLintConfigPath(path) {
  return path === "biome.json" || path === "biome.jsonc";
}

/** True when a changed or untracked path is the Biome config the lint step uses. */
export function lintConfigChanged(records, untracked) {
  for (const record of records) {
    if (isLintConfigPath(record.to) || isLintConfigPath(record.from)) return true;
  }
  return untracked.some((path) => isLintConfigPath(path));
}

/** Tracked files the lint step would check. Untracked paths stay with the diff pairs. */
export function listLintScopedFiles(repo) {
  const text = gitOutput(repo, ["ls-files", "-z", "--", ...LINT_PREFIXES, ...LINT_FILES]);
  return text
    .split("\0")
    .filter((path) => path.length > 0 && inLintScope(path))
    .sort((a, b) => a.localeCompare(b));
}

/** Full-scope pairs. A missing merge-base blob is cleared later by the lint step. */
export function lintPairsForConfigChange(scopedFiles) {
  return scopedFiles.map((headPath) => ({ headPath, baselinePath: headPath }));
}

/**
 * @param {Array<{kind: string, from: string, to: string}>} records
 * @param {string[]} untracked
 * @param {(path: string) => boolean} scope
 * @param {(path: string) => boolean} existsHead
 */
export function lintPairsFromRecords(records, untracked, scope, existsHead) {
  const baselineByHead = new Map();
  for (const record of records) {
    if (record.kind === "D") {
      baselineByHead.delete(record.to);
      continue;
    }
    if (record.kind === "A") baselineByHead.set(record.to, null);
    else if (record.kind === "R" || record.kind === "C") baselineByHead.set(record.to, record.from);
    else baselineByHead.set(record.to, record.to);
  }
  for (const path of untracked) baselineByHead.set(path, null);
  const pairs = [];
  for (const [headPath, baselinePath] of baselineByHead) {
    if (!scope(headPath)) continue;
    if (!existsHead(headPath)) continue;
    pairs.push({ headPath, baselinePath });
  }
  pairs.sort((a, b) => a.headPath.localeCompare(b.headPath));
  return pairs;
}

export function isNonProductPath(path) {
  if (NON_PRODUCT_EXACT.has(path)) return true;
  return NON_PRODUCT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Paths whose bytes can change Vitest results. Skill, evidence, and gitignore do not. */
export function productPathsDiffer(repo, mergeBase) {
  const { records, untracked } = changedRecords(repo, mergeBase);
  const paths = new Set(untracked);
  for (const record of records) {
    if (record.to) paths.add(record.to);
    if (record.from) paths.add(record.from);
  }
  return [...paths].filter((path) => path && !isNonProductPath(path)).sort();
}

export function normalizeDiagPath(file, root) {
  let text = String(file ?? "<unscoped>").replaceAll("\\", "/");
  if (text.startsWith("./")) text = text.slice(2);
  if (text.startsWith("/") && root) {
    const rootText = String(root).replaceAll("\\", "/").replace(/\/$/, "");
    if (text === rootText) return "<root>";
    if (text.startsWith(`${rootText}/`)) text = text.slice(rootText.length + 1);
  }
  return text || "<unscoped>";
}

export function diagnosticCounts(report, root) {
  const omitted = report?.summary?.diagnosticsNotPrinted ?? 0;
  if (omitted > 0) {
    throw new Error(
      `biome omitted ${omitted} diagnostics; rerun with --max-diagnostics=none`,
    );
  }
  const counts = new Map();
  for (const diagnostic of report?.diagnostics ?? []) {
    const severity = diagnostic.severity ?? "error";
    if (severity !== "error" && severity !== "fatal") continue;
    const file = normalizeDiagPath(diagnostic.location?.path?.file ?? "<unscoped>", root);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

export function mergeCounts(into, from) {
  for (const [key, value] of from) into.set(key, (into.get(key) ?? 0) + value);
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function sumCounts(counts) {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
}

/**
 * Fail when a paired file's HEAD count is higher, or a new file has any
 * error diagnostic. Totals can stay flat while a single file still regresses.
 */
export function compareLintCounts(pairs, headCounts, baselineCounts) {
  const regressions = [];
  const seenHead = new Set();
  for (const pair of pairs) {
    seenHead.add(pair.headPath);
    const head = headCounts.get(pair.headPath) ?? 0;
    const baseline = pair.baselinePath == null ? 0 : (baselineCounts.get(pair.baselinePath) ?? 0);
    if (pair.baselinePath == null) {
      if (head > 0) {
        regressions.push({ file: pair.headPath, head, baseline: 0, reason: "new-file" });
      }
    } else if (head > baseline) {
      regressions.push({ file: pair.headPath, head, baseline, reason: "increased" });
    }
  }
  for (const [file, head] of headCounts) {
    if (seenHead.has(file)) continue;
    const baseline = baselineCounts.get(file) ?? 0;
    if (head > baseline) {
      regressions.push({
        file,
        head,
        baseline,
        reason: baselineCounts.has(file) ? "increased" : "new-file",
      });
    }
  }
  regressions.sort((a, b) => a.file.localeCompare(b.file));
  return {
    headDiagnostics: sumCounts(headCounts),
    baselineDiagnostics: sumCounts(baselineCounts),
    regressions,
  };
}

export function relativeTestFile(file, repoRoot) {
  let text = String(file ?? "<unknown>");
  let root = repoRoot ? String(repoRoot) : "";
  if (root) {
    try {
      root = realpathSync(root);
    } catch {
      // The self-test uses a path that is not on disk.
    }
  }
  try {
    text = realpathSync(text);
  } catch {
    // A suite that failed to load may still name a missing file.
  }
  text = text.replaceAll("\\", "/");
  if (root) {
    const rootText = root.replaceAll("\\", "/").replace(/\/$/, "");
    if (text === rootText) return "<root>";
    if (text.startsWith(`${rootText}/`)) return text.slice(rootText.length + 1);
  }
  return text;
}

/** Stable failing names. Empty ancestor titles from Vitest 1.6 are dropped. */
export function failingTestNames(report, repoRoot) {
  const names = new Set();
  for (const file of report?.testResults ?? []) {
    const rel = relativeTestFile(file.name, repoRoot);
    const assertions = file.assertionResults ?? [];
    const failed = assertions.filter((assertion) => assertion.status === "failed");
    if (file.status === "failed" && failed.length === 0) {
      names.add(`${rel} :: <suite failed>`);
    }
    for (const assertion of failed) {
      const parts = [...(assertion.ancestorTitles ?? []), assertion.title]
        .map((part) => String(part ?? "").trim())
        .filter((part) => part.length > 0);
      names.add(`${rel} :: ${parts.join(" > ")}`);
    }
  }
  return [...names].sort();
}

export function compareFailingTests(headNames, baselineNames) {
  const head = new Set(headNames);
  const baseline = new Set(baselineNames);
  const newFailures = [...head].filter((name) => !baseline.has(name)).sort();
  const resolvedFailures = [...baseline].filter((name) => !head.has(name)).sort();
  return {
    headFailed: head.size,
    baselineFailed: baseline.size,
    newFailures,
    resolvedFailures,
  };
}

/**
 * A partial, empty, or aborted Vitest JSON report cannot be compared.
 * Null means the report is usable. Missing failure counts count as zero.
 */
export function vitestReportProblem(report, exitCode) {
  if (!report || typeof report !== "object") return "vitest JSON report is empty";
  if (typeof report.numTotalTests !== "number" || !Array.isArray(report.testResults)) {
    return "vitest JSON report is incomplete";
  }
  if (report.numTotalTests === 0) return "vitest JSON report contains no tests";
  if (exitCode === null) return "vitest was killed before a complete report";
  const failedTests = report.numFailedTests ?? 0;
  const failedSuites = report.numFailedTestSuites ?? 0;
  if (exitCode !== 0 && failedTests === 0 && failedSuites === 0) {
    return "vitest aborted with an unexplained nonzero exit";
  }
  return null;
}

/**
 * Playwright JSON paths are already repo-relative. Absolute paths are stripped
 * against `repoRoot`. Relative paths are left as written so a worktree report
 * parsed from another cwd does not pick up that cwd's realpath.
 */
export function normalizeE2eFile(file, repoRoot) {
  let text = String(file ?? "").replaceAll("\\", "/");
  if (text.startsWith("./")) text = text.slice(2);
  if (!text) return "<unknown>";
  if (!text.startsWith("/") || !repoRoot) return text;
  let root = String(repoRoot).replaceAll("\\", "/").replace(/\/$/, "");
  try {
    root = realpathSync(repoRoot).replaceAll("\\", "/");
  } catch {
    // The self-test uses a path that is not on disk.
  }
  try {
    text = realpathSync(text).replaceAll("\\", "/");
  } catch {
    // Keep the absolute text when the file is gone.
  }
  if (text === root) return "<root>";
  if (text.startsWith(`${root}/`)) return text.slice(root.length + 1);
  return text;
}

function e2eTestFailed(test) {
  const status = test?.status;
  if (status === "unexpected" || status === "flaky") return true;
  if (status === "expected" || status === "skipped") return false;
  return (test?.results ?? []).some(
    (result) => result?.status === "failed" || result?.status === "timedOut",
  );
}

function walkE2eInterrupted(suite) {
  for (const spec of suite?.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        if (result?.status === "interrupted") return true;
      }
    }
  }
  for (const child of suite?.suites ?? []) {
    if (walkE2eInterrupted(child)) return true;
  }
  return false;
}

/** A partial or empty JSON report cannot be compared. Null means usable. */
export function e2eReportProblem(report, exitCode) {
  if (!report || typeof report !== "object") return "playwright JSON report is empty";
  const stats = report.stats;
  const counts = [stats?.expected, stats?.unexpected, stats?.skipped, stats?.flaky];
  if (counts.some((value) => typeof value !== "number")) return "playwright JSON report has no stats";
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total === 0) return "playwright JSON report contains no tests";
  for (const suite of report.suites ?? []) {
    if (walkE2eInterrupted(suite)) {
      return "playwright run was interrupted before the suite finished";
    }
  }
  if (exitCode === null) return "playwright was killed before a complete report";
  const unexpected = stats.unexpected ?? 0;
  const flaky = stats.flaky ?? 0;
  if (exitCode !== undefined && exitCode !== 0 && unexpected === 0 && flaky === 0) {
    return "playwright aborted with an unexplained nonzero exit";
  }
  return null;
}

/**
 * HEAD must discover at least as many Vitest tests as the merge-base baseline.
 * A narrowed include that still reports a nonempty suite would otherwise green.
 * Null means usable. `baselineTotal` null skips the comparison (unknown baseline).
 */
export function vitestDiscoveryProblem(report, baselineTotal) {
  if (!report || typeof report.numTotalTests !== "number") {
    return "vitest JSON report is incomplete";
  }
  if (baselineTotal == null) return null;
  if (typeof baselineTotal !== "number" || baselineTotal < 0) {
    return "baseline vitest discovery count is invalid";
  }
  if (report.numTotalTests < baselineTotal) {
    return `vitest discovered ${report.numTotalTests} tests but the baseline discovered ${baselineTotal}`;
  }
  return null;
}

function collectE2eTests(suite, ancestors, inheritedFile, repoRoot, tests, projects) {
  const file = normalizeE2eFile(suite?.file || inheritedFile, repoRoot);
  const title = String(suite?.title ?? "").trim();
  const next = title && title !== file ? [...ancestors, title] : ancestors;
  for (const spec of suite?.specs ?? []) {
    const specTitle = String(spec?.title ?? "").trim();
    const titles = specTitle ? [...next, specTitle] : [...next];
    const specFile = normalizeE2eFile(spec?.file || file, repoRoot);
    for (const test of spec?.tests ?? []) {
      const project = String(test?.projectName ?? "").trim();
      if (project) projects.add(project);
      tests.push({ file: specFile, titles, test });
    }
  }
  for (const child of suite?.suites ?? []) {
    collectE2eTests(child, next, file, repoRoot, tests, projects);
  }
}

/**
 * Failing Playwright ids. `<file> :: <title path>`. The file-suite title is
 * dropped because Playwright sets it to the file path. With more than one
 * project, the id ends with ` [<project>]`.
 */
export function failingE2eNames(report, repoRoot) {
  const tests = [];
  const projects = new Set();
  for (const suite of report?.suites ?? []) {
    collectE2eTests(suite, [], suite?.file || "", repoRoot, tests, projects);
  }
  const qualifyProject = projects.size > 1;
  const names = new Set();
  for (const item of tests) {
    if (!e2eTestFailed(item.test)) continue;
    const project = String(item.test?.projectName ?? "").trim();
    const suffix = qualifyProject && project ? ` [${project}]` : "";
    names.add(`${item.file} :: ${item.titles.join(" > ")}${suffix}`);
  }
  return [...names].sort();
}

export function readBaselineCache(file, mergeBase, nodeVersion, expect) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!data || data.schema !== 1) return null;
  if (data.mergeBase !== mergeBase) return null;
  if (data.node !== nodeVersion) return null;
  if (expect && expect.suiteKey !== undefined && data.suiteKey !== expect.suiteKey) return null;
  if (!Array.isArray(data.failing) || data.failing.some((item) => typeof item !== "string")) {
    return null;
  }
  return data;
}

function assertEqual(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${label}\n actual: ${left}\n expected: ${right}`);
  }
}

function runSelfTest() {
  assertEqual(
    recordsFromNameStatusZ("M\0src/a.ts\0R090\0old.ts\0new.ts\0A\0src/b.ts\0D\0src/c.ts\0"),
    [
      { kind: "M", from: "src/a.ts", to: "src/a.ts" },
      { kind: "R", from: "old.ts", to: "new.ts" },
      { kind: "A", from: "src/b.ts", to: "src/b.ts" },
      { kind: "D", from: "src/c.ts", to: "src/c.ts" },
    ],
    "name-status",
  );

  const pairs = lintPairsFromRecords(
    recordsFromNameStatusZ(
      "M\0src/a.ts\0R100\0cli/old.ts\0cli/new.ts\0A\0src/fresh.ts\0D\0src/gone.ts\0M\0README.md\0",
    ),
    ["src/untracked.ts", "notes.md"],
    inLintScope,
    () => true,
  );
  assertEqual(
    pairs,
    [
      { headPath: "cli/new.ts", baselinePath: "cli/old.ts" },
      { headPath: "src/a.ts", baselinePath: "src/a.ts" },
      { headPath: "src/fresh.ts", baselinePath: null },
      { headPath: "src/untracked.ts", baselinePath: null },
    ],
    "lint pairs",
  );
  if (inLintScope("tests/fixtures/protocol-corpus/sample.json")) {
    throw new Error("fixtures are outside lint scope");
  }
  if (inLintScope(".cursor/skills/verify-councilkit/scripts/gate.sh")) {
    throw new Error("skill scripts are outside lint scope");
  }
  if (!inLintScope("playwright.config.ts")) throw new Error("playwright config is in lint scope");
  if (!isLintConfigPath("biome.json") || !isLintConfigPath("biome.jsonc")) {
    throw new Error("repo-root biome config is a lint config path");
  }
  if (isLintConfigPath("src/biome.json")) throw new Error("nested biome.json is not the lint config");
  if (inLintScope("biome.json") || inLintScope("biome.jsonc")) {
    throw new Error("biome config itself is not a linted source");
  }
  if (!lintConfigChanged([{ kind: "M", from: "biome.json", to: "biome.json" }], [])) {
    throw new Error("a biome-only diff changes lint config");
  }
  if (!lintConfigChanged([{ kind: "R", from: "biome.json", to: "biome.jsonc" }], [])) {
    throw new Error("renaming the biome config changes lint config");
  }
  if (!lintConfigChanged([], ["biome.jsonc"])) {
    throw new Error("an untracked biome.jsonc changes lint config");
  }
  if (lintConfigChanged([{ kind: "M", from: "src/a.ts", to: "src/a.ts" }], ["src/new.ts"])) {
    throw new Error("source edits are not a lint config change");
  }
  assertEqual(
    lintPairsForConfigChange(["cli/a.ts", "src/b.ts"]),
    [
      { headPath: "cli/a.ts", baselinePath: "cli/a.ts" },
      { headPath: "src/b.ts", baselinePath: "src/b.ts" },
    ],
    "config change pairs keep the head path as the baseline path",
  );

  const head = new Map([
    ["src/a.ts", 2],
    ["src/fresh.ts", 1],
    ["cli/new.ts", 4],
  ]);
  const baseline = new Map([
    ["src/a.ts", 2],
    ["cli/old.ts", 5],
  ]);
  const compared = compareLintCounts(pairs, head, baseline);
  assertEqual(compared.headDiagnostics, 7, "head total");
  assertEqual(compared.baselineDiagnostics, 7, "baseline total");
  assertEqual(
    compared.regressions,
    [{ file: "src/fresh.ts", head: 1, baseline: 0, reason: "new-file" }],
    "count can stay flat while a new file regresses",
  );

  const same = compareLintCounts(
    [{ headPath: "src/a.ts", baselinePath: "src/a.ts" }],
    new Map([["src/a.ts", 3]]),
    new Map([["src/a.ts", 4]]),
  );
  assertEqual(same.regressions, [], "a lower count passes");

  const increased = compareLintCounts(
    [{ headPath: "src/a.ts", baselinePath: "src/a.ts" }],
    new Map([["src/a.ts", 4]]),
    new Map([["src/a.ts", 3]]),
  );
  assertEqual(increased.regressions[0].reason, "increased", "increased count fails");

  assertEqual(normalizeDiagPath("./src/a.ts", "/repo"), "src/a.ts", "dot path");
  assertEqual(normalizeDiagPath("/repo/src/a.ts", "/repo"), "src/a.ts", "absolute path");
  const fromReport = diagnosticCounts(
    {
      summary: { diagnosticsNotPrinted: 0 },
      diagnostics: [
        { severity: "error", location: { path: { file: "src/a.ts" } } },
        { severity: "warning", location: { path: { file: "src/a.ts" } } },
        { severity: "fatal", location: { path: { file: "/repo/src/b.ts" } } },
      ],
    },
    "/repo",
  );
  assertEqual([...fromReport.entries()], [["src/a.ts", 1], ["src/b.ts", 1]], "error and fatal only");

  const names = failingTestNames(
    {
      testResults: [
        {
          name: "/repo/tests/host/installation-registry.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: ["", "installation registry"],
              title: "pins the path",
              status: "failed",
            },
            {
              ancestorTitles: ["installation registry"],
              title: "passes",
              status: "passed",
            },
          ],
        },
        {
          name: "/repo/cli/tests/fix-command.test.ts",
          status: "failed",
          message: "cannot find module",
          assertionResults: [],
        },
      ],
    },
    "/repo",
  );
  assertEqual(
    names,
    [
      "cli/tests/fix-command.test.ts :: <suite failed>",
      "tests/host/installation-registry.test.ts :: installation registry > pins the path",
    ],
    "failing names",
  );
  const tests = compareFailingTests(names, [
    "tests/host/installation-registry.test.ts :: installation registry > pins the path",
    "cli/tests/review-title-format.test.ts :: review finding title format > extracts",
  ]);
  assertEqual(tests.headFailed, 2, "head failed count");
  assertEqual(tests.baselineFailed, 2, "baseline failed count");
  assertEqual(tests.newFailures, ["cli/tests/fix-command.test.ts :: <suite failed>"], "new failure");
  assertEqual(
    tests.resolvedFailures,
    ["cli/tests/review-title-format.test.ts :: review finding title format > extracts"],
    "resolved failure",
  );
  const unchanged = compareFailingTests(names, names);
  assertEqual(unchanged.newFailures, [], "identical sets pass");

  assertEqual(vitestReportProblem(null, 1), "vitest JSON report is empty", "empty vitest report");
  assertEqual(
    vitestReportProblem({ numTotalTests: 1 }, 0),
    "vitest JSON report is incomplete",
    "incomplete vitest report",
  );
  assertEqual(
    vitestReportProblem({ testResults: [] }, 0),
    "vitest JSON report is incomplete",
    "vitest report missing numTotalTests",
  );
  assertEqual(
    vitestReportProblem({ numTotalTests: 0, testResults: [] }, 1),
    "vitest JSON report contains no tests",
    "vitest report contains no tests",
  );
  assertEqual(
    vitestReportProblem({ numTotalTests: 3, testResults: [] }, 1),
    "vitest aborted with an unexplained nonzero exit",
    "unexplained nonzero vitest exit",
  );
  assertEqual(
    vitestReportProblem({ numTotalTests: 3, numFailedTests: 1, testResults: [] }, null),
    "vitest was killed before a complete report",
    "vitest killed before a complete report",
  );
  assertEqual(
    vitestReportProblem(
      {
        numTotalTests: 4,
        numFailedTests: 1,
        numFailedTestSuites: 1,
        testResults: [{ name: "a.test.ts", status: "failed", assertionResults: [] }],
      },
      1,
    ),
    null,
    "a normal failing vitest report is usable",
  );

  const e2eReport = {
    stats: { expected: 1, unexpected: 2, skipped: 1, flaky: 1 },
    suites: [
      {
        title: "tests/e2e/cli-reports.spec.ts",
        file: "tests/e2e/cli-reports.spec.ts",
        specs: [
          {
            title: "侧栏有「报告」",
            ok: true,
            tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed" }] }],
          },
          {
            title: "复制报告内容",
            ok: false,
            tests: [{ projectName: "chromium", status: "unexpected", results: [{ status: "failed" }] }],
          },
        ],
      },
      {
        title: "tests/e2e/control.spec.ts",
        file: "/repo/tests/e2e/control.spec.ts",
        specs: [],
        suites: [
          {
            title: "scope controller and observer pages",
            file: "tests/e2e/control.spec.ts",
            specs: [
              {
                title: "observer is fenced",
                ok: false,
                tests: [
                  { projectName: "chromium", status: "unexpected", results: [{ status: "timedOut" }] },
                ],
              },
              {
                title: "skipped after failure",
                ok: true,
                tests: [{ projectName: "chromium", status: "skipped", results: [{ status: "skipped" }] }],
              },
              {
                title: "flaky copy",
                ok: true,
                tests: [{ projectName: "chromium", status: "flaky", results: [{ status: "failed" }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  if (e2eReportProblem(e2eReport) !== null) throw new Error("a finished report is usable");
  assertEqual(
    failingE2eNames(e2eReport, "/repo"),
    [
      "tests/e2e/cli-reports.spec.ts :: 复制报告内容",
      "tests/e2e/control.spec.ts :: scope controller and observer pages > flaky copy",
      "tests/e2e/control.spec.ts :: scope controller and observer pages > observer is fenced",
    ],
    "e2e failing ids",
  );
  const multiProject = {
    stats: { expected: 1, unexpected: 1, skipped: 0, flaky: 0 },
    suites: [
      {
        title: "tests/e2e/a.spec.ts",
        file: "tests/e2e/a.spec.ts",
        specs: [
          {
            title: "same title",
            tests: [
              { projectName: "chromium", status: "expected", results: [{ status: "passed" }] },
              { projectName: "firefox", status: "unexpected", results: [{ status: "failed" }] },
            ],
          },
        ],
      },
    ],
  };
  assertEqual(
    failingE2eNames(multiProject, "/repo"),
    ["tests/e2e/a.spec.ts :: same title [firefox]"],
    "project suffix only when more than one project is present",
  );
  const e2eCompared = compareFailingTests(failingE2eNames(e2eReport, "/repo"), [
    "tests/e2e/cli-reports.spec.ts :: 复制报告内容",
    "tests/e2e/security.spec.ts :: security gates > canonical origin",
  ]);
  assertEqual(
    e2eCompared.newFailures,
    [
      "tests/e2e/control.spec.ts :: scope controller and observer pages > flaky copy",
      "tests/e2e/control.spec.ts :: scope controller and observer pages > observer is fenced",
    ],
    "new e2e ids",
  );
  
  assertEqual(
    vitestDiscoveryProblem({ numTotalTests: 10 }, 100),
    "vitest discovered 10 tests but the baseline discovered 100",
    "truncated vitest discovery",
  );
  assertEqual(vitestDiscoveryProblem({ numTotalTests: 100 }, 100), null, "matching vitest discovery");
  assertEqual(vitestDiscoveryProblem({ numTotalTests: 120 }, 100), null, "expanded vitest discovery");
  assertEqual(vitestDiscoveryProblem({ numTotalTests: 10 }, null), null, "unknown baseline discovery skipped");
  assertEqual(
    e2eReportProblem({ stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 }, suites: [{ specs: [] }] }, 1),
    "playwright aborted with an unexplained nonzero exit",
    "unexplained playwright nonzero",
  );
  assertEqual(
    e2eReportProblem({ stats: { expected: 1, unexpected: 1, skipped: 0, flaky: 0 }, suites: [{ specs: [] }] }, 1),
    null,
    "playwright nonzero explained by unexpected",
  );

  assertEqual(e2eReportProblem({ stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 }, suites: [] }), "playwright JSON report contains no tests", "empty e2e report");
  assertEqual(
    e2eReportProblem({
      stats: { expected: 0, unexpected: 0, skipped: 1, flaky: 0 },
      suites: [
        {
          title: "tests/e2e/a.spec.ts",
          file: "tests/e2e/a.spec.ts",
          specs: [
            {
              title: "stops",
              tests: [{ projectName: "chromium", status: "skipped", results: [{ status: "interrupted" }] }],
            },
          ],
        },
      ],
    }),
    "playwright run was interrupted before the suite finished",
    "interrupted e2e report",
  );

  const cacheDir = mkdtempSync(join(tmpdir(), "verify-e2e-cache-"));
  try {
    const cacheFile = join(cacheDir, "failing-e2e.json");
    const mergeBase = "a".repeat(40);
    writeFileSync(
      cacheFile,
      JSON.stringify({
        schema: 1,
        mergeBase,
        node: "v22.20.0",
        suiteKey: "playwright.config.ts@isolated",
        failing: ["tests/e2e/a.spec.ts :: one"],
      }),
    );
    if (!readBaselineCache(cacheFile, mergeBase, "v22.20.0", { suiteKey: "playwright.config.ts@isolated" })) {
      throw new Error("suite cache should hit");
    }
    if (readBaselineCache(cacheFile, mergeBase, "v22.20.0", { suiteKey: "playwright.preview.config.ts@fixed:4179" })) {
      throw new Error("a different suiteKey is a cache miss");
    }
    if (!readBaselineCache(cacheFile, mergeBase, "v22.20.0")) {
      throw new Error("omitting suiteKey still reads the file");
    }
    if (readBaselineCache(cacheFile, mergeBase, "v22.21.0", { suiteKey: "playwright.config.ts@isolated" })) {
      throw new Error("a different node version is a cache miss");
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }

  if (isNonProductPath("src/app.tsx")) throw new Error("src is product");
  if (!isNonProductPath(".cursor/skills/verify-councilkit/SKILL.md")) {
    throw new Error("skill path is non-product");
  }
  if (!isNonProductPath("artifacts/verify/abc/summary.json")) {
    throw new Error("evidence is non-product");
  }
  if (!isNonProductPath(".gitignore")) throw new Error("gitignore is non-product");

  process.stdout.write("baseline-lib self-test passed\n");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (process.argv.includes("--self-test")) runSelfTest();
  else {
    process.stderr.write(
      "baseline-lib.mjs is a library. Run lint-baseline.mjs, test-baseline.mjs, or e2e-baseline.mjs.\n",
    );
    process.exit(2);
  }
}
