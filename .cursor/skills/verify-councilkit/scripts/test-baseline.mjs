/**
 * Baseline-relative Vitest.
 *
 * Runs `vitest run --reporter=json` on the working tree and compares failing
 * test names to the merge-base set. The merge-base set is cached under
 * artifacts/verify/baseline-<sha>/. A new failing name fails the step.
 * Pre-existing failures that also fail at the merge-base do not.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertNode22,
  compareFailingTests,
  failingTestNames,
  parseArgs,
  productPathsDiffer,
  readBaselineCache,
  resolveMergeBase,
  vitestReportProblem,
} from "./baseline-lib.mjs";

const procScript = fileURLToPath(new URL("./proc.mjs", import.meta.url));

function writeExtra(file, data) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  rmSync(file, { force: true });
  writeFileSync(file, readFileSync(tmp));
  rmSync(tmp, { force: true });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runLogged(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function copyTree(from, to) {
  const result = runLogged("cp", ["-a", from, to], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`cp -a ${from} ${to} failed (exit ${result.status})`);
  }
}

function provisionDeps(repo, work) {
  const repoLock = join(repo, "pnpm-lock.yaml");
  const workLock = join(work, "pnpm-lock.yaml");
  const repoModules = join(repo, "node_modules");
  const sameLock =
    existsSync(repoLock) && existsSync(workLock) && sha256File(repoLock) === sha256File(workLock);
  if (sameLock && existsSync(repoModules)) {
    console.log("copying node_modules into the baseline worktree (pnpm-lock.yaml matches)");
    copyTree(repoModules, join(work, "node_modules"));
    const cliModules = join(repo, "cli/node_modules");
    if (existsSync(cliModules)) copyTree(cliModules, join(work, "cli/node_modules"));
    return "copied node_modules";
  }
  console.log("pnpm install --frozen-lockfile in the baseline worktree");
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: work,
    env: process.env,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    throw new Error(`pnpm install --frozen-lockfile failed in ${work} (exit ${install.status})`);
  }
  return "pnpm install --frozen-lockfile";
}

function runVitest(cwd, outputFile) {
  mkdirSync(dirname(outputFile), { recursive: true });
  rmSync(outputFile, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${outputFile}`,
      ],
      { cwd, env: process.env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code) => {
      if (!existsSync(outputFile)) {
        reject(new Error(`vitest did not write ${outputFile} (exit ${code ?? "null"})`));
        return;
      }
      let report;
      try {
        report = JSON.parse(readFileSync(outputFile, "utf8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`vitest JSON report is unreadable (${outputFile}): ${message}`));
        return;
      }
      const problem = vitestReportProblem(report, code);
      if (problem) {
        reject(new Error(`${problem} (vitest exit ${code ?? "null"})`));
        return;
      }
      resolve(report);
    });
  });
}

function writeCache(file, mergeBase, failing, source) {
  mkdirSync(dirname(file), { recursive: true });
  const payload = {
    schema: 1,
    mergeBase,
    node: process.version,
    createdAt: new Date().toISOString(),
    source,
    failing,
  };
  writeExtra(file, payload);
}

function removeWorktree(repo, work) {
  const result = spawnSync("git", ["worktree", "remove", "--force", work], {
    cwd: repo,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(
      `git worktree remove ${work} failed: ${(result.stderr || "").trim()}\n`,
    );
  }
}

async function baselineFromWorktree(repo, sha, cacheDir) {
  const work = mkdtempSync(join(tmpdir(), "verify-councilkit-base-"));
  rmSync(work, { recursive: true, force: true });
  const added = spawnSync("git", ["worktree", "add", "--detach", work, sha], {
    cwd: repo,
    encoding: "utf8",
  });
  if (added.status !== 0) {
    throw new Error(`git worktree add --detach ${work} ${sha} failed: ${(added.stderr || "").trim()}`);
  }
  try {
    const how = provisionDeps(repo, work);
    console.log(`baseline deps: ${how}`);
    const reportPath = join(cacheDir, "vitest.json");
    console.log(`running vitest at merge-base ${sha} in ${work}`);
    const report = await runVitest(work, reportPath);
    const names = failingTestNames(report, work);
    writeCache(join(cacheDir, "failing-tests.json"), sha, names, "worktree");
    console.log(`baseline worktree failing tests: ${names.length}`);
    return names;
  } finally {
    removeWorktree(repo, work);
  }
}

function recordListeners() {
  console.log("canonical 43127 listeners (recorded, not signaled):");
  const result = spawnSync(process.execPath, [procScript, "listeners", "--port", "43127"], {
    encoding: "utf8",
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  console.log(text.length > 0 ? text : "(none)");
}

function detailLine(base, compared, cacheState) {
  return `vitest --reporter=json vs ${base.ref} ${base.sha}; headFailed=${compared.headFailed} baselineFailed=${compared.baselineFailed}; newFailures=${compared.newFailures.length}; baseline cache ${cacheState}`;
}

async function main() {
  assertNode22();
  const args = parseArgs(process.argv.slice(2));
  const extraOut = args["extra-out"];
  const reportOut = args["report-out"];
  if (!extraOut || extraOut === true || !reportOut || reportOut === true) {
    process.stderr.write("usage: test-baseline.mjs --extra-out FILE --report-out FILE\n");
    process.exit(2);
  }
  const repo = process.cwd();
  const base = resolveMergeBase(repo);
  if (!base) {
    const detail =
      "no merge-base with origin/main (tried origin/master, main, master). Test baseline cannot be computed.";
    writeExtra(extraOut, {
      detail,
      mergeBase: null,
      headFailed: null,
      baselineFailed: null,
      newFailures: [],
    });
    process.stderr.write(`${detail}\n`);
    process.exit(2);
  }

  console.log(`node=${process.version} repo=${repo}`);
  console.log(`merge-base ${base.ref} ${base.sha}`);
  recordListeners();

  const cacheDir = join(repo, "artifacts", "verify", `baseline-${base.sha}`);
  const cacheFile = join(cacheDir, "failing-tests.json");
  const cached = readBaselineCache(cacheFile, base.sha, process.version);
  const productDiff = productPathsDiffer(repo, base.sha);
  console.log(
    productDiff.length === 0
      ? "product tree matches the merge-base"
      : `product paths differing from the merge-base: ${productDiff.length}`,
  );

  let baselineNames = null;
  let cacheState = "miss";
  if (cached) {
    baselineNames = cached.failing;
    cacheState = "hit";
    console.log(`baseline cache hit ${cacheFile} (${baselineNames.length} failing)`);
  } else if (productDiff.length > 0) {
    console.log("baseline cache miss; running vitest in a merge-base worktree");
    baselineNames = await baselineFromWorktree(repo, base.sha, cacheDir);
    cacheState = "miss-worktree";
  } else {
    console.log("baseline cache miss; the HEAD vitest run is the merge-base result and will be cached");
    cacheState = "miss-same-tree";
  }

  console.log("running vitest at HEAD");
  const headReport = await runVitest(repo, reportOut);
  const headNames = failingTestNames(headReport, repo);
  console.log(`HEAD failing tests: ${headNames.length}`);

  if (baselineNames == null) {
    baselineNames = headNames;
    writeCache(cacheFile, base.sha, headNames, "head-same-tree");
    console.log(`wrote baseline cache ${cacheFile}`);
  }

  const compared = compareFailingTests(headNames, baselineNames);
  const detail = detailLine(base, compared, cacheState);
  writeExtra(extraOut, {
    detail,
    mergeBase: base.sha,
    mergeBaseRef: base.ref,
    headFailed: compared.headFailed,
    baselineFailed: compared.baselineFailed,
    newFailures: compared.newFailures,
    resolvedFailures: compared.resolvedFailures,
    baselineCache: cacheFile,
    baselineCacheState: cacheState,
  });
  console.log(detail);
  for (const name of compared.newFailures) console.log(`NEW ${name}`);
  if (compared.newFailures.length > 0) process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`test baseline could not be computed: ${message}\n`);
    const extraOut = parseArgs(process.argv.slice(2))["extra-out"];
    if (typeof extraOut === "string") {
      writeExtra(extraOut, {
        detail: `test baseline could not be computed: ${message}`,
        headFailed: null,
        baselineFailed: null,
        newFailures: [],
      });
    }
    process.exit(2);
  });
}
