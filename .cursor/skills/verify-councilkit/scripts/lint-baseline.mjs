/**
 * Baseline-relative Biome check.
 *
 * Compares error-diagnostic counts on lint-scoped files changed versus the
 * merge-base. The HEAD side is the working tree. The baseline side is those
 * paths as blobs at the merge-base, checked in a temp directory with the
 * merge-base biome.json. Fails when a file's count rises or a new file has any.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
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
  changedRecords,
  chunk,
  compareLintCounts,
  diagnosticCounts,
  inLintScope,
  lintPairsFromRecords,
  mergeCounts,
  parseArgs,
  resolveMergeBase,
} from "./baseline-lib.mjs";

function writeExtra(file, data) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  rmSync(file, { force: true });
  writeFileSync(file, readFileSync(tmp));
  rmSync(tmp, { force: true });
}

function readBlob(repo, sha, path) {
  const spec = `${sha}:${path}`;
  const check = spawnSync("git", ["cat-file", "-e", spec], { cwd: repo });
  if (check.status !== 0) return null;
  const result = spawnSync("git", ["cat-file", "blob", spec], {
    cwd: repo,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git cat-file blob ${spec} failed: ${result.stderr?.toString?.() ?? ""}`);
  }
  return result.stdout;
}

function runBiome(biomeBin, cwd, files, stdoutFile) {
  return new Promise((resolve) => {
    const args = [
      "check",
      "--reporter=json",
      "--max-diagnostics=none",
      "--diagnostic-level=error",
      ...files,
    ];
    const stdout = createWriteStream(stdoutFile);
    const stderrChunks = [];
    let stderrBytes = 0;
    const child = spawn(biomeBin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(stdout);
    child.stderr.on("data", (chunk) => {
      if (stderrBytes > 200_000) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", (error) => {
      stdout.end(() => resolve({ code: 127, stderr: String(error) }));
    });
    child.on("close", (code) => {
      stdout.end(() => {
        resolve({ code: code ?? 1, stderr: Buffer.concat(stderrChunks).toString("utf8") });
      });
    });
  });
}

function interestingStderr(stderr) {
  return stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes("NO_COLOR"))
    .filter((line) => !line.includes("trace-warnings"))
    .filter((line) => !line.includes("--json option is unstable"))
    .filter((line) => !line.includes("Some errors were emitted while running checks"))
    .filter((line) => !line.startsWith("check ━"))
    .slice(0, 30);
}

async function biomeCounts(biomeBin, cwd, files, pathRoot) {
  const counts = new Map();
  for (const group of chunk(files, 80)) {
    const stdoutFile = join(
      tmpdir(),
      `verify-biome-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
    );
    try {
      const result = await runBiome(biomeBin, cwd, group, stdoutFile);
      const notes = interestingStderr(result.stderr ?? "");
      if (notes.length > 0) console.log(notes.join("\n"));
      if (!existsSync(stdoutFile)) {
        throw new Error(`biome wrote no JSON (exit ${result.code})`);
      }
      const report = JSON.parse(readFileSync(stdoutFile, "utf8"));
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(`biome exited ${result.code}`);
      }
      if ((report.diagnostics ?? []).length === 0 && /internalError/.test(result.stderr ?? "")) {
        throw new Error(`biome internal error: ${(result.stderr ?? "").slice(0, 500)}`);
      }
      mergeCounts(counts, diagnosticCounts(report, pathRoot));
    } finally {
      rmSync(stdoutFile, { force: true });
    }
  }
  return counts;
}

function detailLine(base, filesChecked, compared) {
  const regressionNote =
    compared.regressions.length === 0
      ? "regressions=0"
      : `regressions=${compared.regressions.length}: ${compared.regressions
          .slice(0, 20)
          .map((item) => `${item.file} ${item.baseline}->${item.head} (${item.reason})`)
          .join("; ")}`;
  return `biome check on ${filesChecked} changed lint-scoped files vs ${base.ref} ${base.sha}; headDiagnostics=${compared.headDiagnostics} baselineDiagnostics=${compared.baselineDiagnostics}; ${regressionNote}`;
}

async function main() {
  assertNode22();
  const args = parseArgs(process.argv.slice(2));
  const extraOut = args["extra-out"];
  if (!extraOut || extraOut === true) {
    process.stderr.write("usage: lint-baseline.mjs --extra-out FILE\n");
    process.exit(2);
  }
  const repo = process.cwd();
  const base = resolveMergeBase(repo);
  if (!base) {
    const detail =
      "no merge-base with origin/main (tried origin/master, main, master). Lint baseline cannot be computed.";
    writeExtra(extraOut, {
      detail,
      mergeBase: null,
      headDiagnostics: null,
      baselineDiagnostics: null,
      filesChecked: 0,
      regressions: [],
    });
    process.stderr.write(`${detail}\n`);
    process.exit(2);
  }

  const { records, untracked } = changedRecords(repo, base.sha);
  const pairs = lintPairsFromRecords(records, untracked, inLintScope, (path) =>
    existsSync(join(repo, path)),
  );
  console.log(`node=${process.version} repo=${repo}`);
  console.log(`merge-base ${base.ref} ${base.sha}`);
  console.log(`lint-scoped changed files: ${pairs.length}`);
  for (const pair of pairs) {
    const note =
      pair.baselinePath == null
        ? " (new file)"
        : pair.baselinePath !== pair.headPath
          ? ` (baseline ${pair.baselinePath})`
          : "";
    console.log(`  ${pair.headPath}${note}`);
  }

  if (pairs.length === 0) {
    const compared = { headDiagnostics: 0, baselineDiagnostics: 0, regressions: [] };
    const detail = detailLine(base, 0, compared);
    writeExtra(extraOut, {
      detail,
      mergeBase: base.sha,
      mergeBaseRef: base.ref,
      headDiagnostics: 0,
      baselineDiagnostics: 0,
      filesChecked: 0,
      regressions: [],
    });
    console.log(detail);
    return;
  }

  const biomeBin = join(repo, "node_modules/@biomejs/biome/bin/biome");
  if (!existsSync(biomeBin)) {
    const detail = `biome not found at ${biomeBin}`;
    writeExtra(extraOut, {
      detail,
      mergeBase: base.sha,
      mergeBaseRef: base.ref,
      headDiagnostics: null,
      baselineDiagnostics: null,
      filesChecked: pairs.length,
      regressions: [],
    });
    process.stderr.write(`${detail}\n`);
    process.exit(2);
  }

  console.log("biome check at HEAD (working tree)");
  const headCounts = await biomeCounts(
    biomeBin,
    repo,
    pairs.map((pair) => pair.headPath),
    repo,
  );

  const temp = mkdtempSync(join(tmpdir(), "verify-lint-base-"));
  try {
    const biomeJson = readBlob(repo, base.sha, "biome.json");
    if (!biomeJson) throw new Error(`merge-base ${base.sha} has no biome.json`);
    writeFileSync(join(temp, "biome.json"), biomeJson);
    const baselineFiles = [];
    for (const pair of pairs) {
      if (!pair.baselinePath) continue;
      const blob = readBlob(repo, base.sha, pair.baselinePath);
      if (!blob) {
        pair.baselinePath = null;
        continue;
      }
      const dest = join(temp, pair.baselinePath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, blob);
      baselineFiles.push(pair.baselinePath);
    }
    let baselineCounts = new Map();
    if (baselineFiles.length > 0) {
      console.log(`biome check at merge-base (${baselineFiles.length} files in ${temp})`);
      baselineCounts = await biomeCounts(biomeBin, temp, baselineFiles, temp);
    } else {
      console.log("no changed lint files exist at the merge-base");
    }
    const compared = compareLintCounts(pairs, headCounts, baselineCounts);
    const detail = detailLine(base, pairs.length, compared);
    writeExtra(extraOut, {
      detail,
      mergeBase: base.sha,
      mergeBaseRef: base.ref,
      headDiagnostics: compared.headDiagnostics,
      baselineDiagnostics: compared.baselineDiagnostics,
      filesChecked: pairs.length,
      regressions: compared.regressions,
    });
    console.log(detail);
    for (const item of compared.regressions) {
      console.log(
        `REGRESSION ${item.file} baseline=${item.baseline} head=${item.head} ${item.reason}`,
      );
    }
    if (compared.regressions.length > 0) process.exit(1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`lint baseline could not be computed: ${message}\n`);
    const extraOut = parseArgs(process.argv.slice(2))["extra-out"];
    if (typeof extraOut === "string") {
      writeExtra(extraOut, {
        detail: `lint baseline could not be computed: ${message}`,
        headDiagnostics: null,
        baselineDiagnostics: null,
        regressions: [],
      });
    }
    process.exit(2);
  });
}
