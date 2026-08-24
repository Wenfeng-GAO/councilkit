/**
 * Build a paste-ready prompt so another agent can apply a CouncilKit
 * review (or discussion) report and update the same PR.
 */

export interface FixPromptInput {
  markdown: string;
  title: string;
  kind: "review" | "discuss" | "squad" | "unknown";
  truncated: boolean;
  verdict?: "approve" | "changes-requested" | "comment" | null;
}

const ANTCODE_HOST = "code.alipay.com";
const GITHUB_HOST = "github.com";

export function buildReviewResumeCommand(
  runId: string,
  ...texts: Array<string | undefined>
): string {
  const pr = extractPrUrl(...texts);
  if (pr) return `councilkit review ${pr} --resume ${runId}`;
  return `councilkit review --resume ${runId}`;
}

export function extractPrUrl(...texts: Array<string | undefined>): string | null {
  for (const text of texts) {
    if (!text) continue;
    const match = /https:\/\/[^\s)\]>'"]+/u.exec(text);
    if (match) return match[0].replace(/[.,;]+$/, "");
  }
  return null;
}

export function buildFixFromReviewPrompt(input: FixPromptInput): string {
  const prUrl = extractPrUrl(input.title, input.markdown);
  const lines: string[] = [];

  lines.push(
    "你是这个仓库的实现 agent。下面是 CouncilKit 多模型陪审团产出的 Markdown 报告。",
    "按报告落实修改，并更新同一条 PR，不要另开 PR。",
    "",
    "## 你要做的事",
    "",
    "1. 先读完整报告，再改代码。优先落实 critical / major；minor 一并修；nit 只在不扩大无关 diff 时处理。",
    "2. 不要改报告未覆盖的文件，不要顺手重构。",
    "3. 对每条采纳的 finding：改实现，并补能钉住该缺陷的最小回归测试（仓库已有同类测试时跟它的风格）。",
    "4. 跑与改动相关的既有测试；全量套件过重就跑定向测试，并在 PR 回复里写明跑了什么。",
    "5. 把提交推回这条 PR 的源分支。不要 force-push，除非该分支只有你自己的未审提交且历史需要整理。",
    "6. 在 PR 里留一条中文评论：改了什么、对应哪些 finding、哪些未采纳及原因、验证命令与结果。",
    "7. 报告与代码冲突时，以代码和可复现事实为准，并在评论里写明。",
  );

  if (input.verdict === "approve") {
    lines.push(
      "8. 裁决是 approve：只修你确认仍成立的问题；没有实质问题就不要空提交，只在 PR 里说明已核对。",
    );
  } else if (input.verdict === "comment") {
    lines.push("8. 裁决是 comment：只落实有复现路径的问题，不要把讨论项当成必须改。");
  } else {
    lines.push("8. 裁决是 changes-requested 或未给出：在合并前必须处理完所有 critical / major。");
  }

  if (input.truncated) {
    lines.push("", "注意：报告在 2MB 处被截断，附录可能不完整。缺的 finding 不要臆造。");
  }

  lines.push("", "## PR", "");
  if (prUrl) {
    lines.push(prUrl, "", prAccessHint(prUrl));
  } else {
    lines.push(
      "报告里没有可解析的 PR URL。请在当前仓库找到对应的已打开 PR / 源分支，改完后更新那一条。",
    );
  }

  if (input.kind === "discuss") {
    lines.push(
      "",
      "## 报告类型",
      "",
      "这是讨论报告，不是并行审查。按「建议 / 后续行动」落地，不要把发言分歧当成必须全改。",
    );
  }

  lines.push(
    "",
    "## 审查报告（Markdown 原文）",
    "",
    "----- BEGIN REVIEW REPORT -----",
    input.markdown.trimEnd(),
    "----- END REVIEW REPORT -----",
    "",
  );

  return lines.join("\n");
}

function prAccessHint(prUrl: string): string {
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return "用该仓库惯用的 CLI 查看 diff 并评论。";
  }
  if (url.host === ANTCODE_HOST) {
    const parsed = parseAntCodePr(url);
    const spec = parsed ? `${parsed.iid} -P ${parsed.project}` : "<iid> -P <group/project>";
    return [
      "这是 AntCode PR。调用内部 CLI 时只在该条命令前清代理：",
      "`NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY=''`",
      "模型 API 不要改代理。",
      `查看：\`antcode pr show ${spec} --no-pager\``,
      `差异：\`antcode pr diff ${spec} --no-pager\``,
      "评论：先 `antcode pr --help` 找评论子命令；没有就用仓库惯用入口写回 PR。",
    ].join("\n");
  }
  if (url.host === GITHUB_HOST) {
    return [
      "这是 GitHub PR。",
      `查看：\`gh pr view '${prUrl}'\``,
      `差异：\`gh pr diff '${prUrl}'\``,
      `评论：\`gh pr comment '${prUrl}' --body "..."\``,
    ].join("\n");
  }
  return "用该仓库惯用的 CLI 查看 diff、推送源分支并在 PR 里评论。";
}

function parseAntCodePr(url: URL): { project: string; iid: string } | null {
  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const prIdx = segments.indexOf("pull_requests");
  if (prIdx < 1 || prIdx !== segments.length - 2) return null;
  const iid = segments[prIdx + 1];
  if (!/^[0-9]+$/.test(iid)) return null;
  const project = segments.slice(0, prIdx).join("/");
  if (project.length === 0) return null;
  return { project, iid };
}
