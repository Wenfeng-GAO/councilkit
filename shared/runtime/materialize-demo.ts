/**
 * Write (or reuse) the built-in sample review. Shared by `councilkit demo`
 * and the Host「先看示例」 button (UI-03 / #281 fold into #274).
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveCliRunsRoot } from "./cli-home";
import { findingsFileSchema } from "./cli-ledger";
import { cliReportUrl } from "./cli-runs-index";
import { DEMO_SAMPLE_TITLE, withDemoSampleHeader } from "./demo-report";
import { REPORT_SECTION_HEADINGS } from "./report-sections";

const SECTION_BODY: Record<(typeof REPORT_SECTION_HEADINGS)[number], string> = {
  "## Background（背景）":
    "登录接口 `POST /v1/auth/login` 现在每来一次请求就校验口令，没有频率限制。示例 PR「给登录接口加限流」打算按来源 IP 和账号做滑动窗口：同一 IP 每分钟最多 30 次，同一账号每分钟最多 10 次失败。这是内置示例，没有读取任何仓库。",
  "## Discussion goal（讨论目标）":
    "判断这版限流能不能挡住撞库，同时不误伤正常用户、公司出口和健康检查。只讨论示例 diff 里的三处改动：计数器、超限状态码、探针是否计入窗口。",
  "## Participating agents（参与角色）":
    "三席都是内置示例 AI，不是已登录的真实模型。安全席看撞库路径，接口席看调用方能不能识别限流，汇总席把两边的意见收成一份决定。没有席位实际执行过。",
  "## Discussion summary（讨论摘要）":
    "三席都同意登录失败必须计入限流，超限不能再伪装成口令错误。分歧在计数放在哪里。安全席指出进程内 map 在多副本下会失效；接口席补充超限仍返回 401，客户端会继续重试；汇总席另外记下健康检查走同一条登录路径，会被账号窗口挤掉真实用户。",
  "## Key consensus（关键共识）":
    "限流方向成立，但这版还不能合并。计数必须跨实例共享；超过阈值返回 429 并带 Retry-After；健康检查不得占用登录配额。这三条对得上账本里的三个示例发现。",
  "## Remaining disagreements（未决分歧）":
    "共享 NAT 下按 IP 还是按账号计数，席间没有统一。安全席要 IP 与账号同时生效，接口席担心公司出口被一个账号打满。示例没有足够的流量数据来裁定，先把上面三条共识落地再谈阈值。",
  "## Recommendation（推荐）":
    "建议修改后再合并。不要把进程内计数器和 401 响应直接合进主干。先补共享计数、429 和探针排除，再做一次对照审查。示例结论不代表任何真实模型的判断。",
  "## Risks and objections（风险与异议）":
    "1. 限流计数只存在进程内存（demo-limiter-memory）。两个副本各记各的，撞库流量按副本数放大。\n2. 触发限流后仍返回 401（demo-limit-status）。调用方分不清口令错误和已被限流，会按错误密码继续打。\n3. 健康检查走登录接口（demo-health-probe）。探针每 10 秒用固定账号访问，和真实用户共用账号窗口。",
  "## Next actions（下一步行动）":
    "1. 把滑动窗口放到共享存储，登录失败和成功都递增，并给成功登录更宽的上限。\n2. 超限改为 429，响应里带 Retry-After，停止使用 401。\n3. 健康检查改走独立路径，或从登录限流里排除。\n这三条都是示例发现，不能在此页直接修复或交给 Squad。",
};

export function buildDemoReportMarkdown(runId: string): string {
  const body = REPORT_SECTION_HEADINGS.map(
    (heading) => `${heading}\n\n${SECTION_BODY[heading]}`,
  ).join("\n\n");
  return withDemoSampleHeader(runId, `# ${DEMO_SAMPLE_TITLE}\n\n${body}\n`);
}

function demoFindings(runId: string, extractedAt: string) {
  return findingsFileSchema.parse({
    version: 1,
    runId,
    extractedAt,
    sha: null,
    againstRunId: null,
    againstRange: null,
    findings: [
      {
        id: "demo-limiter-memory",
        severity: "major",
        status: "open",
        title: "限流计数只存在进程内存，多实例下会失效",
        text: "示例 PR 把登录限流计数放在进程内 map。两个副本同时处理 /v1/auth/login 时，各自的窗口互不可见，撞库流量按副本数被放大。应改成共享存储里的滑动窗口，登录失败也要递增。",
        source: "consensus",
        reviewer: "示例 AI",
        files: ["internal/auth/login_limiter.go"],
      },
      {
        id: "demo-limit-status",
        severity: "major",
        status: "open",
        title: "触发限流后仍返回 401，客户端会继续重试",
        text: "超过阈值时处理函数仍走口令错误分支，响应码是 401。调用方无法区分口令错误和已被限流，会按错误密码策略继续打。应返回 429，并带 Retry-After。",
        source: "unique",
        reviewer: "示例 AI",
        files: ["internal/auth/login_handler.go"],
      },
      {
        id: "demo-health-probe",
        severity: "minor",
        status: "open",
        title: "健康检查走登录接口，会被同一套限流算进去",
        text: "探针每 10 秒用固定账号访问 /v1/auth/login，和真实用户共用账号维度的窗口。探针密集时会把正常登录挤出配额。探针应走独立路径，或从登录限流里排除。",
        source: "unique",
        reviewer: "示例 AI",
        files: ["internal/auth/routes.go"],
      },
    ],
  });
}

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function existingDemoRunId(runsRoot: string): string | null {
  let names: string[];
  try {
    names = readdirSync(runsRoot)
      .filter((n) => n.startsWith("ck-review-demo-"))
      .sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = join(runsRoot, name);
    try {
      const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as {
        demo?: unknown;
        status?: unknown;
      };
      if (
        status.demo === true &&
        status.status === "completed" &&
        existsSync(join(dir, "report.md"))
      ) {
        return name;
      }
    } catch {
      /* ignore half-written */
    }
  }
  return null;
}

export interface MaterializeDemoResult {
  runId: string;
  demo: true;
  reportUrl: string;
  title: string;
  reused: boolean;
}

/** Reuse an existing sample, or write a fresh one under the CLI runs root. */
export function materializeDemo(
  options: {
    forceNew?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): MaterializeDemoResult {
  const runsRoot = resolveCliRunsRoot(options.env);
  const reuse = options.forceNew === true ? null : existingDemoRunId(runsRoot);
  if (reuse !== null) {
    return {
      runId: reuse,
      demo: true,
      reportUrl: cliReportUrl(reuse),
      title: DEMO_SAMPLE_TITLE,
      reused: true,
    };
  }
  const runId = `ck-review-demo-${randomUUID()}`;
  const now = new Date().toISOString();
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(
    join(dir, "status.json"),
    `${JSON.stringify(
      {
        version: 1,
        status: "completed",
        kind: "review",
        demo: true,
        readonly: true,
        title: DEMO_SAMPLE_TITLE,
        startedAt: now,
        endedAt: now,
        progress: { phase: "done", attempts: [], updatedAt: now },
      },
      null,
      2,
    )}\n`,
  );
  writeAtomic(join(dir, "findings.json"), `${JSON.stringify(demoFindings(runId, now), null, 2)}\n`);
  const markdown = buildDemoReportMarkdown(runId);
  writeAtomic(join(dir, "report.md"), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return {
    runId,
    demo: true,
    reportUrl: cliReportUrl(runId),
    title: DEMO_SAMPLE_TITLE,
    reused: false,
  };
}
