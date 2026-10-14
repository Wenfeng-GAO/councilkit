import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExplainerExecutorInput,
  ExplanationAgents,
  ExplanationResult,
} from "@shared/runtime/review-explainer/contracts";
import { ExplainerError } from "@shared/runtime/review-explainer/io";
import { afterEach, describe, expect, it } from "vitest";
import { decodeExplanationOutput } from "../../../runtime-host/review-explainer/explanation-output";
import { FINDING, PR_URL, RUN_ID } from "../../review-explainer/contract";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";
import type { SyntheticRepo } from "../../review-explainer/fixtures/synthetic-repo";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

const homes: string[] = [];
const oldHome = process.env.COUNCILKIT_HOME;
const oldPath = process.env.PATH;
const oldUserHome = process.env.HOME;

afterEach(() => {
  if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = oldHome;
  if (oldPath === undefined) Reflect.deleteProperty(process.env, "PATH");
  else process.env.PATH = oldPath;
  if (oldUserHome === undefined) Reflect.deleteProperty(process.env, "HOME");
  else process.env.HOME = oldUserHome;
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
  const home = mkdtempSync(join(tmpdir(), "ck-explain-edge-"));
  homes.push(home);
  process.env.COUNCILKIT_HOME = home;
  return seedReviewRun(home);
}

type Explain = (
  runId: string,
  findingId: string,
  generate: boolean,
  agentId?: string,
) => Promise<ExplanationResult>;

async function load() {
  const mod = await importFeature<Record<string, unknown>>("@host/review-explainer/explanations");
  return {
    explanationAgents: requireExport<
      (runId: string, services: Record<string, unknown>) => ExplanationAgents
    >(mod, "explanationAgents", "@host/review-explainer/explanations"),
    createExplanationService: requireExport<(services: Record<string, unknown>) => Explain>(
      mod,
      "createExplanationService",
      "@host/review-explainer/explanations",
    ),
  };
}

function services(extra: Record<string, unknown> = {}) {
  return extra;
}

function writeAgents(home: string, agents: Array<Record<string, unknown>>) {
  writeFileSync(
    join(home, "agents.json"),
    `${JSON.stringify({ format: "councilkit-agents", version: 1, agents })}\n`,
  );
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function replaceFinding(
  runDir: string,
  id: string,
  patch: { text?: string; files?: string[]; title?: string },
): void {
  const path = join(runDir, "findings.json");
  const ledger = JSON.parse(readFileSync(path, "utf8")) as {
    findings: Array<Record<string, unknown>>;
  };
  const row = ledger.findings.find((finding) => finding.id === id);
  if (!row) throw new Error(`missing finding ${id}`);
  Object.assign(row, patch);
  writeJson(path, ledger);
}

function reseal(home: string, repo: SyntheticRepo): ReturnType<typeof seedReviewRun> {
  const headSha = git(repo.repo, ["rev-parse", "HEAD"]);
  const diff = execFileSync(
    "git",
    ["diff", "--no-color", "--no-ext-diff", `${repo.mergeBaseSha}...${headSha}`],
    { cwd: repo.repo, encoding: "utf8" },
  );
  return seedReviewRun(home, {
    repo: {
      ...repo,
      headSha,
      diff,
      diffHash: createHash("sha256").update(diff).digest("hex"),
    },
  });
}

const readyPayload = {
  kind: "text" as const,
  title: "重复请求可能导致同一任务执行两次",
  assertion: "冻结证据中的完整断言",
  evidence: ["原评审证据"],
  inference: [] as string[],
};

async function expectExplainer(
  run: () => Promise<unknown>,
  message: string,
  status: number,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ExplainerError);
  const error = caught as ExplainerError;
  expect(error.message).toBe(message);
  expect(error.status).toBe(status);
}

describe("explanation agent catalog edges", () => {
  it("does not invent a default agent when the invocation manifest is missing", async () => {
    const seeded = setup();
    const { explanationAgents } = await load();
    rmSync(join(seeded.runDir, "invocation-manifest.v1.json"));
    expect(explanationAgents(RUN_ID, services())).toEqual({
      agents: [],
      defaultAgentId: null,
      defaultSource: null,
      notice: "默认解释 Agent 未配置或不可用；请选择可用 Agent，不会自动换用其他席位。",
    });
  });

  it("reports a local catalog read failure without listing agents", async () => {
    const seeded = setup();
    const { explanationAgents } = await load();
    writeFileSync(join(seeded.home, "agents.json"), "{");
    expect(explanationAgents(RUN_ID, services())).toEqual({
      agents: [],
      defaultAgentId: null,
      defaultSource: null,
      notice: "解释 Agent 配置读取失败，请检查本地配置。",
    });
  });

  it("marks a non-cfuse Claude agent unavailable and does not spawn it", async () => {
    const seeded = setup();
    const { explanationAgents } = await load();
    writeAgents(seeded.home, [
      {
        id: "agent-claude",
        name: "claude-route",
        personaPrompt: "explain",
        modelId: "claude-fixture",
        color: "#abcdef",
        enabled: true,
        driverSelection: { driverId: "claude-stream-json", options: { route: "moonshot" } },
      },
    ]);
    expect(explanationAgents(RUN_ID, services())).toEqual({
      agents: [
        {
          id: "agent-claude",
          name: "claude-route",
          driverId: "claude-stream-json",
          modelId: "claude-fixture",
          available: false,
          reason: "解释仅支持 Claude 的 cfuse 路由",
        },
      ],
      defaultAgentId: "a",
      defaultSource: "run-aggregator",
      notice: "默认解释 Agent 未配置或不可用；请选择可用 Agent，不会自动换用其他席位。",
    });
  });

  it("marks an agent unavailable when its executable is not installed", async () => {
    const seeded = setup();
    const { explanationAgents } = await load();
    writeAgents(seeded.home, [
      {
        id: "agent-grok",
        name: "missing-grok",
        personaPrompt: "explain",
        modelId: "grok-fixture",
        color: "#abcdef",
        enabled: true,
        driverSelection: { driverId: "grok-stream-json", options: {} },
      },
    ]);
    process.env.HOME = seeded.home;
    process.env.PATH = seeded.home;
    expect(explanationAgents(RUN_ID, services()).agents).toEqual([
      {
        id: "agent-grok",
        name: "missing-grok",
        driverId: "grok-stream-json",
        modelId: "grok-fixture",
        available: false,
        reason: "未找到本地 Agent 可执行程序",
      },
    ]);
  });
});

describe("explanation generation boundaries", () => {
  it("sends uncited deleted and modified files from the frozen side", async () => {
    const seeded = setup();
    replaceFinding(seeded.runDir, FINDING.busy, {
      text: "没有行号，只点了文件。",
      files: ["src/deleted.go", "README.md"],
    });
    const seen: ExplainerExecutorInput[] = [];
    const { createExplanationService } = await load();
    const explain = createExplanationService(
      services({
        reviewExplainerExecutor: {
          modelId: "injected-fixture",
          async generate(input: ExplainerExecutorInput) {
            seen.push(input);
            return readyPayload;
          },
        },
      }),
    );
    const result = await explain(RUN_ID, FINDING.busy, true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toEqual([
      {
        path: "src/deleted.go",
        side: "old",
        sha: seeded.repo.mergeBaseSha,
        text: seeded.repo.blobs.old["src/deleted.go"],
      },
      {
        path: "README.md",
        side: "new",
        sha: seeded.repo.headSha,
        text: seeded.repo.blobs.new["README.md"],
      },
    ]);
    expect(result.payload).toEqual(readyPayload);
    expect(result.cached).toBe(false);
    expect(result.provenance).toMatchObject({
      runId: RUN_ID,
      findingId: FINDING.busy,
      headSha: seeded.repo.headSha,
      modelId: "injected-fixture",
      driverId: "injected",
      agentId: "injected-explainer",
      agentName: "解释 Agent",
      mode: "injected",
      schemaVersion: 2,
    });
    expect(seen[0]?.prUrl).toBe(PR_URL);
  });

  it("refuses an oversized file that has no cited line", async () => {
    const seeded = setup();
    const body = `${Array.from({ length: 1500 }, (_, index) => `pad-${index + 1}-${"x".repeat(40)}`).join("\n")}\n`;
    writeFileSync(join(seeded.repo.repo, "src/wide.go"), body);
    git(seeded.repo.repo, ["add", "src/wide.go"]);
    git(seeded.repo.repo, ["commit", "-m", "add wide file"]);
    const resealed = reseal(seeded.home, seeded.repo);
    replaceFinding(resealed.runDir, FINDING.busy, {
      text: "文件很大，但没有行号。",
      files: ["src/wide.go"],
    });
    let calls = 0;
    const { createExplanationService } = await load();
    const explain = createExplanationService(
      services({
        reviewExplainerExecutor: {
          async generate() {
            calls += 1;
            return readyPayload;
          },
        },
      }),
    );
    await expectExplainer(
      () => explain(RUN_ID, FINDING.busy, true),
      "代码过大且缺少明确引用，无法生成解读",
      409,
    );
    expect(calls).toBe(0);
  });

  it("sends only the cited window of an oversized file", async () => {
    const seeded = setup();
    const lines = Array.from({ length: 1500 }, (_, index) => {
      const number = index + 1;
      if (number === 1) return "LINE_ONE_MARKER";
      if (number === 100) return "LINE_100_MARKER";
      if (number === 400) return "LINE_400_MARKER";
      return `pad-${number}-${"x".repeat(40)}`;
    });
    writeFileSync(join(seeded.repo.repo, "src/wide.go"), `${lines.join("\n")}\n`);
    git(seeded.repo.repo, ["add", "src/wide.go"]);
    git(seeded.repo.repo, ["commit", "-m", "add cited wide file"]);
    const resealed = reseal(seeded.home, seeded.repo);
    replaceFinding(resealed.runDir, FINDING.busy, {
      text: "src/wide.go:100",
      files: ["src/wide.go"],
    });
    const seen: ExplainerExecutorInput[] = [];
    const { createExplanationService } = await load();
    const explain = createExplanationService(
      services({
        reviewExplainerExecutor: {
          async generate(input: ExplainerExecutorInput) {
            seen.push(input);
            return readyPayload;
          },
        },
      }),
    );
    await explain(RUN_ID, FINDING.busy, true);
    const expected = lines
      .slice(69, 130)
      .map((text, index) => `${index + 70}: ${text}`)
      .join("\n");
    expect(seen[0]?.source).toEqual([
      {
        path: "src/wide.go",
        side: "new",
        sha: resealed.repo.headSha,
        text: expected,
      },
    ]);
    expect(seen[0]?.source[0]?.text).not.toContain("LINE_ONE_MARKER");
    expect(seen[0]?.source[0]?.text).not.toContain("LINE_400_MARKER");
  });

  it("refuses more than eight cited files", async () => {
    const seeded = setup();
    const names = Array.from({ length: 9 }, (_, index) => `src/e${index + 1}.go`);
    for (const name of names) writeFileSync(join(seeded.repo.repo, name), "package extra\n");
    git(seeded.repo.repo, ["add", ...names]);
    git(seeded.repo.repo, ["commit", "-m", "add nine files"]);
    const resealed = reseal(seeded.home, seeded.repo);
    replaceFinding(resealed.runDir, FINDING.busy, {
      text: names.map((name) => `${name}:1`).join(" "),
      files: names,
    });
    let calls = 0;
    const { createExplanationService } = await load();
    const explain = createExplanationService(
      services({
        reviewExplainerExecutor: {
          async generate() {
            calls += 1;
            return readyPayload;
          },
        },
      }),
    );
    await expectExplainer(
      () => explain(RUN_ID, FINDING.busy, true),
      "引用代码超过解读范围上限",
      413,
    );
    expect(calls).toBe(0);
  });

  it("refuses to read a damaged explanation cache", async () => {
    const seeded = setup();
    let calls = 0;
    const { createExplanationService } = await load();
    const explain = createExplanationService(
      services({
        reviewExplainerExecutor: {
          async generate() {
            calls += 1;
            return readyPayload;
          },
        },
      }),
    );
    const first = await explain(RUN_ID, FINDING.busy, true);
    expect(first.cached).toBe(false);
    expect(first.payload).toEqual(readyPayload);
    const cacheDir = join(seeded.runDir, "review-explainer", "explanations");
    const [name] = readdirSync(cacheDir);
    if (!name) throw new Error("missing cache file");
    writeFileSync(join(cacheDir, name), "{");
    await expectExplainer(
      () => explain(RUN_ID, FINDING.busy, false),
      "解释缓存损坏，无法读取",
      500,
    );
    expect(calls).toBe(1);
    expect(readFileSync(join(cacheDir, name), "utf8")).toBe("{");
  });

  it("rejects a canvas location that is not in the frozen source and accepts one that is", async () => {
    const seeded = setup();
    const line = seeded.repo.busyNewLine;
    const good = {
      kind: "flow" as const,
      title: "所有权检查失败后请求被拒绝",
      assertion: "冻结证据中的完整断言",
      evidence: ["原评审证据"],
      inference: ["条件推演"],
      canvas: {
        template: "flow" as const,
        nodes: [
          {
            id: "n1",
            label: "检查所有权",
            evidence: "assertion" as const,
            location: { path: "src/busy.go", side: "new" as const, line },
          },
        ],
        edges: [],
      },
    };
    const bad = {
      ...good,
      canvas: {
        ...good.canvas,
        nodes: [
          {
            ...good.canvas.nodes[0],
            location: { path: "src/busy.go", side: "new" as const, line: 4000 },
          },
        ],
      },
    };
    let mode: "bad" | "good" = "bad";
    const { createExplanationService } = await load();
    const explain = createExplanationService(
      services({
        reviewExplainerExecutor: {
          modelId: "injected-fixture",
          async generate() {
            return mode === "bad" ? bad : good;
          },
        },
      }),
    );
    await expectExplainer(
      () => explain(RUN_ID, FINDING.busy, true),
      "模型引用了无法验证的代码位置",
      502,
    );
    const cacheDir = join(seeded.runDir, "review-explainer", "explanations");
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
    mode = "good";
    const saved = await explain(RUN_ID, FINDING.busy, true);
    expect(saved.payload).toEqual(good);
    expect(saved.cached).toBe(false);
    const [name] = readdirSync(cacheDir);
    if (!name) throw new Error("missing cache file");
    expect(JSON.parse(readFileSync(join(cacheDir, name), "utf8")).payload).toEqual(good);
  });
});

const decodedPayload = {
  kind: "text",
  title: "重复请求可能导致同一任务执行两次",
  assertion: '请求中包含 }、{、转义引号"和反斜线\\，仍需保留。',
  evidence: ["已有证据"],
  inference: [] as string[],
  canvas: {
    template: "flow" as const,
    nodes: [{ id: "n1", label: "嵌套对象中的 }", evidence: "assertion" as const }],
    edges: [] as [],
  },
};

describe("explanation output decoding", () => {
  it("reads strict JSON, one trailing closing brace, and fenced JSON", () => {
    expect(decodeExplanationOutput(JSON.stringify(decodedPayload))).toEqual({
      value: decodedPayload,
      normalization: "none",
    });
    expect(decodeExplanationOutput(`${JSON.stringify(decodedPayload)}\n}`)).toEqual({
      value: decodedPayload,
      normalization: "single-trailing-closing-brace",
    });
    expect(
      decodeExplanationOutput(`\n\`\`\`json\n${JSON.stringify(decodedPayload)}\n}\n\`\`\`\n`).value,
    ).toEqual(decodedPayload);
    expect(
      decodeExplanationOutput(`\`\`\`\n${JSON.stringify(decodedPayload)}\n\`\`\``).value,
    ).toEqual(decodedPayload);
  });

  it("rejects oversized, ambiguous, and internally invalid model output", () => {
    expect(() =>
      decodeExplanationOutput(JSON.stringify({ assertion: "a".repeat(256000) })),
    ).toThrow("模型输出超过解读大小限制");
    for (const raw of [
      `${JSON.stringify(decodedPayload)}\n{ "other": true }`,
      `${JSON.stringify(decodedPayload)}\n} trailing text`,
      `${JSON.stringify(decodedPayload)}\n}}`,
      `prefix ${JSON.stringify(decodedPayload)}\n}`,
      '{"a": [1,]}\n}',
      '{"a": "unterminated}\n}',
      '{"a": "bad\\q"}\n}',
      '{"a": {"b": true}',
      '[{"a": true}]\n}',
      `\`\`\`json\n${JSON.stringify(decodedPayload)}\n}`,
      "",
      "\n}",
    ]) {
      expect(() => decodeExplanationOutput(raw)).toThrow("模型返回无效解释 JSON，请重试");
    }
  });
});
