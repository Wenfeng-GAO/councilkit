/**
 * Baseline-relative Playwright.
 *
 * Runs `pnpm exec playwright test -c <config> --reporter=json` on the working
 * tree and compares failing ids to the merge-base set. The merge-base set is
 * cached under artifacts/verify/baseline-<sha>/failing-e2e.json. A new failing
 * id fails the step. Pre-existing failures that also fail at the merge-base
 * do not. Screenshots and traces stay in test-results and are copied to
 * --artifacts-out.
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
import { pathToFileURL } from "node:url";
import {
  assertNode22,
  compareFailingTests,
  e2eReportProblem,
  failingE2eNames,
  parseArgs,
  productPathsDiffer,
  readBaselineCache,
  resolveMergeBase,
} from "./baseline-lib.mjs";

const SUITES = new Set([
  "playwright.config.ts",
  "playwright.review-explainer.config.ts",
  "playwright.repair-observability.config.ts",
  "playwright.repair-ui.config.ts",
  "playwright.preview.config.ts",
]);

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

function cleanPlaywrightOutput(cwd) {
  rmSync(join(cwd, "test-results"), { recursive: true, force: true });
  rmSync(join(cwd, "playwright-report"), { recursive: true, force: true });
}

function copyArtifacts(repo, dest) {
  if (!dest) return;
  mkdirSync(dest, { recursive: true });
  for (const name of ["test-results", "playwright-report"]) {
    const from = join(repo, name);
    const to = join(dest, name);
    rmSync(to, { recursive: true, force: true });
    if (!existsSync(from)) continue;
    copyTree(from, to);
    console.log(`copied ${name} to ${to}`);
  }
}

function playwrightEnv(outputFile, portMode) {
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: outputFile };
  if (portMode !== "isolated") delete env.COUNCILKIT_E2E_PORT;
  return env;
}

function runPlaywright(cwd, outputFile, suite, portMode) {
  mkdirSync(dirname(outputFile), { recursive: true });
  rmSync(outputFile, { force: true });
  cleanPlaywrightOutput(cwd);
  const args = ["exec", "playwright", "test", "-c", suite, "--reporter=json"];
  console.log(
    `command: pnpm ${args.join(" ")}${portMode === "isolated" ? ` COUNCILKIT_E2E_PORT=${process.env.COUNCILKIT_E2E_PORT}` : ""}`,
  );
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd,
      env: playwrightEnv(outputFile, portMode),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!existsSync(outputFile)) {
        reject(new Error(`playwright did not write ${outputFile} (exit ${code ?? "null"})`));
        return;
      }
      let report;
      try {
        report = JSON.parse(readFileSync(outputFile, "utf8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`playwright JSON report is unreadable (${outputFile}): ${message}`));
        return;
      }
      const problem = e2eReportProblem(report, code);
      if (problem) {
        reject(new Error(`${problem} (playwright exit ${code ?? "null"})`));
        return;
      }
      resolve({ report, code });
    });
  });
}

function writeCache(file, mergeBase, suiteKey, failing, source) {
  mkdirSync(dirname(file), { recursive: true });
  writeExtra(file, {
    schema: 1,
    mergeBase,
    node: process.version,
    createdAt: new Date().toISOString(),
    source,
    suiteKey,
    failing,
  });
}

function parsePortMode(value) {
  if (value === "isolated") return { kind: "isolated" };
  const match = /^fixed:([0-9]+)$/.exec(String(value ?? ""));
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 43127) return null;
  return { kind: "fixed", port };
}

function assertPort(portMode) {
  if (portMode !== "isolated") return;
  const raw = process.env.COUNCILKIT_E2E_PORT ?? "";
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `isolated e2e requires COUNCILKIT_E2E_PORT set to a free port other than 43127 (got ${JSON.stringify(raw)})`,
    );
  }
  const port = Number(raw);
  if (port < 1 || port > 65535 || port === 43127) {
    throw new Error(
      `isolated e2e requires COUNCILKIT_E2E_PORT set to a free port other than 43127 (got ${JSON.stringify(raw)})`,
    );
  }
}

async function baselineFromWorktree(repo, sha, cacheDir, suite, portMode) {
  const work = mkdtempSync(join(tmpdir(), "verify-councilkit-e2e-"));
  rmSync(work, { recursive: true, force: true });
  const added = spawnSync("git", ["worktree", "add", "--detach", work, sha], {
    cwd: repo,
    encoding: "utf8",
  });
  if (added.status !== 0) {
    throw new Error(`git worktree add --detach ${work} ${sha} failed: ${(added.stderr || "").trim()}`);
  }
  try {
    if (!existsSync(join(work, suite))) {
      throw new Error(`playwright config ${suite} is not in the merge-base tree`);
    }
    const how = provisionDeps(repo, work);
    console.log(`baseline deps: ${how}`);
    const reportPath = join(cacheDir, "playwright.json");
    console.log(`running playwright at merge-base ${sha} in ${work}`);
    const { report, code } = await runPlaywright(work, reportPath, suite, portMode);
    const names = failingE2eNames(report, work);
    console.log(`baseline worktree playwright exit ${code}; failing ids ${names.length}`);
    return names;
  } finally {
    removeWorktree(repo, work);
  }
}

function detailLine(base, compared, cacheState, suiteKey) {
  return `playwright test --reporter=json vs ${base.ref} ${base.sha}; headFailed=${compared.headFailed} baselineFailed=${compared.baselineFailed}; newFailures=${compared.newFailures.length}; baseline cache ${cacheState}; suite=${suiteKey}`;
}

async function main() {
  assertNode22();
  const args = parseArgs(process.argv.slice(2));
  const extraOut = args["extra-out"];
  const reportOut = args["report-out"];
  const artifactsOut = args["artifacts-out"];
  const suite = args.suite;
  const portMode = args["port-mode"];
  if (
    !extraOut ||
    extraOut === true ||
    !reportOut ||
    reportOut === true ||
    !suite ||
    suite === true ||
    !portMode ||
    portMode === true
  ) {
    process.stderr.write(
      "usage: e2e-baseline.mjs --extra-out FILE --report-out FILE --suite CONFIG --port-mode isolated|fixed:PORT [--artifacts-out DIR]\n",
    );
    process.exit(2);
  }
  if (!SUITES.has(suite) || !parsePortMode(portMode)) {
    process.stderr.write(
      `e2e baseline refused suite ${JSON.stringify(suite)} port-mode ${JSON.stringify(portMode)}\n`,
    );
    process.exit(2);
  }
  assertPort(portMode);
  const repo = process.cwd();
  if (!existsSync(join(repo, suite))) {
    throw new Error(`playwright config not found: ${suite}`);
  }
  const suiteKey = `${suite}@${portMode}`;
  const base = resolveMergeBase(repo);
  if (!base) {
    const detail =
      "no merge-base with origin/main (tried origin/master, main, master). E2E baseline cannot be computed.";
    writeExtra(extraOut, {
      detail,
      mergeBase: null,
      headFailed: null,
      baselineFailed: null,
      newFailures: [],
      suiteKey,
    });
    process.stderr.write(`${detail}\n`);
    process.exit(2);
  }

  console.log(`node=${process.version} repo=${repo}`);
  console.log(`merge-base ${base.ref} ${base.sha}`);
  console.log(`suite=${suiteKey}`);

  const cacheDir = join(repo, "artifacts", "verify", `baseline-${base.sha}`);
  const cacheFile = join(cacheDir, "failing-e2e.json");
  const cached = readBaselineCache(cacheFile, base.sha, process.version, { suiteKey });
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
    console.log("baseline cache miss; running playwright in a merge-base worktree");
    baselineNames = await baselineFromWorktree(repo, base.sha, cacheDir, suite, portMode);
    writeCache(cacheFile, base.sha, suiteKey, baselineNames, "worktree");
    cacheState = "miss-worktree";
    console.log(`wrote baseline cache ${cacheFile}`);
  } else {
    console.log(
      "baseline cache miss; the HEAD playwright run is the merge-base result and will be cached",
    );
    cacheState = "miss-same-tree";
  }

  console.log("running playwright at HEAD");
  const { report: headReport, code: headCode } = await runPlaywright(repo, reportOut, suite, portMode);
  const headNames = failingE2eNames(headReport, repo);
  console.log(`HEAD playwright exit ${headCode}; failing ids ${headNames.length}`);
  if (artifactsOut && artifactsOut !== true) copyArtifacts(repo, artifactsOut);

  if (baselineNames == null) {
    baselineNames = headNames;
    writeCache(cacheFile, base.sha, suiteKey, headNames, "head-same-tree");
    console.log(`wrote baseline cache ${cacheFile}`);
  }

  const compared = compareFailingTests(headNames, baselineNames);
  const detail = detailLine(base, compared, cacheState, suiteKey);
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
    suiteKey,
    playwrightExit: headCode,
  });
  console.log(detail);
  for (const name of compared.newFailures) console.log(`NEW ${name}`);
  if (compared.newFailures.length > 0) process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`e2e baseline could not be computed: ${message}\n`);
    const parsed = parseArgs(process.argv.slice(2));
    const extraOut = parsed["extra-out"];
    if (typeof extraOut === "string") {
      writeExtra(extraOut, {
        detail: `e2e baseline could not be computed: ${message}`,
        headFailed: null,
        baselineFailed: null,
        newFailures: [],
        suiteKey: typeof parsed.suite === "string" ? `${parsed.suite}@${parsed["port-mode"] ?? ""}` : null,
      });
    }
    process.exit(2);
  });
}
