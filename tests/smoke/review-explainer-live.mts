/**
 * Opt-in A07/A12: actual model → production route → disk cache → built UI.
 * Uses synthetic code and a newly allocated home. Never writes the user's home.
 * CK_EXPLAINER_LIVE_OUT must name a task artifact directory.
 * Default runtime matches an existing configured user model, without changing it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { Store } from "../../cli/src/store/store";
import type { ExplanationResult } from "../../shared/runtime/review-explainer/contracts";
import { createExplainerHttpHost } from "../host/review-explainer/http-helpers";
import { seedReviewRun, writeFrozenIdentity } from "../review-explainer/fixtures/seed-run";

if (process.env.CK_EXPLAINER_LIVE !== "1" || !process.env.CK_EXPLAINER_LIVE_OUT) {
  throw new Error("Opt in with CK_EXPLAINER_LIVE=1 and CK_EXPLAINER_LIVE_OUT=<artifact directory>");
}
assert.equal(Number(process.versions.node.split(".")[0]), 22, "Live acceptance requires Node 22");
assert.equal(
  execFileSync("git", ["status", "--porcelain", "--", "src", "shared", "runtime-host", "cli/src"], {
    encoding: "utf8",
  }).trim(),
  "",
  "Commit the candidate before live acceptance; do not attribute dirty code to an old SHA",
);
const out = resolve(process.env.CK_EXPLAINER_LIVE_OUT);
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(out, "home-"));
process.env.COUNCILKIT_HOME = home;
const seeded = seedReviewRun(home);
const repo = seeded.repo.repo;
const baseSha = seeded.repo.headSha;
const code = {
  "src/errors.ts": [
    "export function errorFor(kind: string) {",
    "  if (kind === 'connect') return new Error('request unavailable');",
    "  if (kind === 'resume') return new Error('request unavailable');",
    "  return null;",
    "}",
    "",
  ].join("\n"),
  "src/submit.ts": [
    "export async function submit(payload: string) {",
    "  if (recovery.active) return { accepted: false };",
    "  const id = await remote.accept(payload);",
    "  if (recovery.active) return { accepted: false };",
    "  await records.markAccepted(id);",
    "  return { accepted: true, id };",
    "}",
    "",
  ].join("\n"),
};
for (const [path, text] of Object.entries(code)) writeFileSync(join(repo, path), text);
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("add", "src/errors.ts", "src/submit.ts");
git("-c", "commit.gpgsign=false", "commit", "-m", "Add synthetic explanation smoke cases");
const headSha = git("rev-parse", "HEAD");
const diff = execFileSync(
  "git",
  ["diff", "--no-color", "--no-ext-diff", `${baseSha}...${headSha}`],
  { cwd: repo, encoding: "utf8" },
);
const diffHash = createHash("sha256").update(diff).digest("hex");
writeFrozenIdentity(
  seeded.runDir,
  { ...seeded.repo, baseSha, mergeBaseSha: baseSha, headSha, diff, diffHash },
  seeded.prUrl,
);
const manifestPath = join(seeded.runDir, "invocation-manifest.v1.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.reviewedSha = headSha;
manifest.repoRealpath = repo;
writeFileSync(manifestPath, JSON.stringify(manifest));
// Remove only this synthetic run's previous fixture anchors.
rmSync(join(seeded.runDir, "review-explainer", "anchors.json"), { force: true });

const evidence = { acceptedCalls: 0, recorded: 0, returnedAccepted: true };
const recovery = { active: false };
const sandbox = vm.createContext({
  recovery,
  remote: {
    accept: async () => {
      evidence.acceptedCalls += 1;
      recovery.active = true;
      return "synthetic-turn";
    },
  },
  records: {
    markAccepted: async () => {
      evidence.recorded += 1;
    },
  },
});
// Execute our fixed fixture only, never a model-generated code suggestion.
vm.runInContext(
  code["src/submit.ts"].replace("export ", "").replace("payload: string", "payload"),
  sandbox,
);
const observed = await vm.runInContext('submit("synthetic")', sandbox);
evidence.returnedAccepted = observed.accepted;
assert.equal(evidence.acceptedCalls, 1);
assert.equal(evidence.recorded, 0);
assert.equal(evidence.returnedAccepted, false);
writeFileSync(
  join(out, "controlled-source-evidence.json"),
  JSON.stringify({ headSha, evidence, secondSubmitTested: false }, null, 2),
);

const findings = [
  {
    id: "F-live-style",
    severity: "nit",
    status: "open",
    source: "consensus",
    reviewer: "synthetic-input",
    title: "可选整理重复错误消息",
    files: ["src/errors.ts"],
    text: "src/errors.ts:2-3 — 两处分支重复错误消息；可提取消息常量以避免后续只改一处。这是可选整理，不是已复现的功能故障。必须保留每次新建 Error 对象的语义。",
  },
  {
    id: "F-live-interleaving",
    severity: "major",
    status: "open",
    source: "consensus",
    reviewer: "synthetic-input",
    title: "远端接收后却返回未接收",
    files: ["src/submit.ts"],
    text: "src/submit.ts:3-5 — 若 recovery.active 在 remote.accept 已接收后、第二次检查前变为 true，调用者收到 accepted:false，但远端已接收且 records 没有记录。给定受控测试证据：remote.acceptCount=1、返回 accepted:false、records.count=0。没有执行第二次提交。若调用方据此重试且无幂等保护，可能重复执行，这只是追加条件推演。生产入口是否允许此交错尚未确认，发生概率未知。",
  },
];
writeFileSync(
  join(seeded.runDir, "findings.json"),
  JSON.stringify(
    {
      version: 1,
      runId: seeded.runId,
      extractedAt: new Date().toISOString(),
      sha: headSha,
      againstRunId: null,
      againstRange: null,
      findings,
    },
    null,
    2,
  ),
);
writeFileSync(
  join(seeded.runDir, "report.md"),
  `# 合成验收样本 · 非真实 PR 审查\n\n## 概览\n仅用于验证解释链路。\n\n## 共识发现\n${findings.map((f) => `- [${f.severity}] ${f.text}`).join("\n")}\n\n## 结论\ncomment\n`,
);

const store = new Store();
const modelId = process.env.CK_EXPLAINER_LIVE_MODEL ?? "gpt-5.6-sol";
const agent = store.createAgent({
  name: "live-explainer",
  personaPrompt: "解释评审，区分已有证据与条件推演。",
  modelId,
  color: "#c9b18a",
  driverSelection:
    process.env.CK_EXPLAINER_LIVE_DRIVER === "claude-stream-json"
      ? { driverId: "claude-stream-json", options: { route: "cfuse" } }
      : { driverId: "codex-app-server", options: {} },
});
store.createCouncil({
  name: "pr-jury",
  topic: "Synthetic explanation acceptance",
  agentIds: [agent.id],
  reporterAgentId: agent.id,
  rounds: 1,
});

// No reviewExplainerExecutor is injected: this must use the production default.
const host = await createExplainerHttpHost({ home, uiDistDir: resolve("dist") });
const candidate = git("-C", process.cwd(), "rev-parse", "HEAD");
const info = {
  baseUrl: host.baseUrl,
  runId: seeded.runId,
  url: `${host.baseUrl}/reports/${seeded.runId}`,
  home,
  headSha,
  candidate,
  modelId,
  driverId: agent.driverSelection.driverId,
};
writeFileSync(join(out, "host.json"), JSON.stringify(info, null, 2));
process.stdout.write(`${JSON.stringify({ stage: "live-host-ready", ...info })}\n`);
const executionsDir = join(seeded.runDir, "review-explainer", "executions");
const executions = () => {
  try {
    return readdirSync(executionsDir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
};
const results: ExplanationResult[] = [];
try {
  for (const finding of findings) {
    const path = `/api/v1/cli-runs/${seeded.runId}/review-explainer/explanations/${finding.id}`;
    const response = await fetch(`${host.baseUrl}${path}`, {
      method: "POST",
      headers: host.headers(),
      body: "{}",
    });
    const body = (await response.json()) as {
      ok: boolean;
      data?: ExplanationResult;
      error?: { message?: string };
    };
    writeFileSync(join(out, `${finding.id}-response.json`), JSON.stringify(body, null, 2));
    assert.equal(
      response.status,
      200,
      `explanation ${finding.id}: ${body.error?.message ?? response.status}`,
    );
    const first = body.data;
    assert.ok(first);
    assert.equal(first.provenance.mode, "model");
    assert.equal(first.provenance.headSha, headSha);
    assert.equal(first.cached, false);
    const before = executions();
    assert.ok(before.some((name) => name.includes(first.provenance.executionId)));
    const cachedResponse = await fetch(`${host.baseUrl}${path}`, {
      method: "POST",
      headers: host.headers(),
      body: "{}",
    });
    const cachedBody = (await cachedResponse.json()) as { data?: ExplanationResult };
    assert.equal(cachedResponse.status, 200);
    assert.equal(cachedBody.data?.cached, true);
    assert.equal(cachedBody.data?.provenance.executionId, first.provenance.executionId);
    assert.deepEqual(executions(), before, "cache lookup must not start another model execution");
    results.push(first);
    writeFileSync(
      join(out, "api-receipt.json"),
      JSON.stringify(
        {
          ...info,
          status: "api-cache-verified",
          results,
          uiVerified: false,
          qualityVerified: false,
        },
        null,
        2,
      ),
    );
    process.stdout.write(
      `${JSON.stringify({ stage: "model-cache-verified", findingId: finding.id, executionId: first.provenance.executionId })}\n`,
    );
  }
} catch (error) {
  writeFileSync(
    join(out, "live-failure.json"),
    JSON.stringify(
      {
        ...info,
        error: error instanceof Error ? error.message : String(error),
        completed: results.map((r) => r.provenance.findingId),
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `${JSON.stringify({ stage: "live-smoke-failed", findingIdsCompleted: results.map((r) => r.provenance.findingId) })}\n`,
  );
}
// Keep the isolated built UI available for the independent browser evidence.
const close = async () => {
  await host.close();
  process.exit(0);
};
process.on("SIGINT", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
process.stdout.write(`${JSON.stringify({ stage: "awaiting-ui-acceptance", url: info.url })}\n`);
