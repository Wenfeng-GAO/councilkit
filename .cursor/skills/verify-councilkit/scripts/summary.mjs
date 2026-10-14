/**
 * Atomic writer for artifacts/verify/<sha>/summary.json.
 * The gate calls this after every step so a crash still leaves a partial proof.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MERGE_RULE =
  "Merge only when gate.sh exits 0, the PR body Verify section shows CI green for this SHA, and no unresolved Codex P1 remains on the latest commit. Otherwise leave the PR open and report.";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) out[key] = true;
      else {
        out[key] = value;
        i += 1;
      }
    } else out._.push(token);
  }
  return out;
}

function summaryPath(dir) {
  return join(dir, "summary.json");
}

function load(dir) {
  try {
    return JSON.parse(readFileSync(summaryPath(dir), "utf8"));
  } catch {
    return null;
  }
}

function save(dir, data) {
  mkdirSync(dir, { recursive: true });
  const path = summaryPath(dir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

const parsed = args(process.argv.slice(2));
const command = parsed._[0];
const dir = parsed.dir;
if (!dir) {
  process.stderr.write("summary.mjs requires --dir\n");
  process.exit(2);
}

if (command === "init") {
  let dirtyText = parsed["dirty-paths"] ?? "";
  if (parsed["dirty-file"]) {
    try {
      dirtyText = readFileSync(parsed["dirty-file"], "utf8");
    } catch {
      dirtyText = "";
    }
  }
  const dirtyPaths = dirtyText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let externalText = "";
  if (parsed["external-links-file"]) {
    try {
      externalText = readFileSync(parsed["external-links-file"], "utf8");
    } catch {
      externalText = "";
    }
  }
  const externalNodeModules = externalText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  save(dir, {
    schema: 1,
    sha: parsed.sha ?? "",
    branch: parsed.branch ?? "",
    repo: parsed.repo ?? "",
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
    externalNodeModules,
    node: parsed.node ?? "",
    startedAt: parsed.started ?? new Date().toISOString(),
    finishedAt: null,
    ok: null,
    mergeRule: MERGE_RULE,
    canonicalPort: 43127,
    canonicalPortPolicy:
      "The gate and the verification host never bind 43127 and never signal whatever holds it.",
    steps: [],
  });
} else if (command === "step") {
  const data = load(dir);
  if (!data) {
    process.stderr.write("summary.json is missing; run init first\n");
    process.exit(2);
  }
  let extra = {};
  if (parsed["extra-file"]) {
    try {
      extra = JSON.parse(readFileSync(parsed["extra-file"], "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`summary.mjs: ignoring unreadable extra file: ${message}\n`);
      extra = {};
    }
  }
  const step = {
    name: parsed.name,
    status: parsed.status,
    exitCode: Number(parsed.exit ?? 0),
    log: parsed.log ?? null,
    detail: extra.detail || parsed.detail || "",
    startedAt: parsed.started ?? null,
    finishedAt: new Date().toISOString(),
  };
  const reserved = new Set([
    "detail",
    "name",
    "status",
    "exitCode",
    "log",
    "startedAt",
    "finishedAt",
    "ok",
    "steps",
    "schema",
  ]);
  for (const [key, value] of Object.entries(extra)) {
    if (reserved.has(key)) continue;
    step[key] = value;
  }
  const index = data.steps.findIndex((item) => item.name === step.name);
  if (index === -1) data.steps.push(step);
  else data.steps[index] = step;
  save(dir, data);
} else if (command === "finish") {
  const data = load(dir);
  if (!data) {
    process.stderr.write("summary.json is missing; run init first\n");
    process.exit(2);
  }
  data.ok = parsed.ok === "true";
  data.finishedAt = new Date().toISOString();
  save(dir, data);
} else {
  process.stderr.write("usage: summary.mjs init|step|finish --dir PATH\n");
  process.exit(2);
}
