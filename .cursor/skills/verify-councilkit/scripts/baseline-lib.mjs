/**
 * Shared helpers for the baseline-relative lint and test steps.
 * Pure comparisons live here so a self-test can pin them without Biome or Vitest.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
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

export function readBaselineCache(file, mergeBase, nodeVersion) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!data || data.schema !== 1) return null;
  if (data.mergeBase !== mergeBase) return null;
  if (data.node !== nodeVersion) return null;
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
    process.stderr.write("baseline-lib.mjs is a library. Run lint-baseline.mjs or test-baseline.mjs.\n");
    process.exit(2);
  }
}
