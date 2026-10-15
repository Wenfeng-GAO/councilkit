/**
 * Built-in sample review (`councilkit demo`).
 *
 * Browser-safe: the report page imports this module. The filesystem index
 * re-exports the helpers so CLI tests can read them from one place.
 *
 * CI-03 calls `councilkit demo --json` and greps `"demo": true`.
 */

export const DEMO_SAMPLE_TITLE = "示例 PR：给登录接口加限流";

/** First two lines of a demo report.md and of any demo export/copy. */
export function demoSampleHeader(runId: string): string {
  return [
    "> ⚠️ 示例数据 / SAMPLE DATA — 由内置示例 AI 生成，非真实模型输出。",
    `> 只读审查 · run ${runId} · demo: true`,
  ].join("\n");
}

/** Prefix the SAMPLE DATA lines once. A report that already has them is unchanged. */
export function withDemoSampleHeader(runId: string, markdown: string): string {
  const header = demoSampleHeader(runId);
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (text === header || text.startsWith(`${header}\n`)) return text;
  const body = text.replace(/^\n+/, "");
  return body.length > 0 ? `${header}\n\n${body}` : `${header}\n`;
}

export function isDemoRun(run: { demo?: boolean | null } | null | undefined): boolean {
  return run?.demo === true;
}

export interface RunAttentionInput {
  demo?: boolean | null;
  status?: string | null;
  businessResult?: string | null;
  pipeline?: { phase?: string | null; applyStatus?: string | null } | null;
  reviewEvidence?: { blockingIds?: readonly string[] | null } | null;
}

/** Real runs that still need a person. Demo runs never count, even with blocking findings. */
export function realRunNeedsAttention(run: RunAttentionInput): boolean {
  if (isDemoRun(run)) return false;
  if (
    run.status === "failed" ||
    run.status === "interrupted" ||
    run.status === "running" ||
    run.status === "awaiting_orchestrator"
  ) {
    return true;
  }
  if (run.businessResult === "needs_attention" || run.businessResult === "stopped") return true;
  if (run.pipeline?.applyStatus === "failure") return true;
  if (run.pipeline?.phase && run.pipeline.phase !== "done") return true;
  return (run.reviewEvidence?.blockingIds?.length ?? 0) > 0;
}

export function countRealRunsNeedingAttention(runs: readonly RunAttentionInput[]): number {
  let count = 0;
  for (const run of runs) {
    if (realRunNeedsAttention(run)) count += 1;
  }
  return count;
}

/** Markdown a download or copy should emit. Demo runs keep the SAMPLE DATA prefix. */
export function exportRunMarkdown(run: {
  demo?: boolean | null;
  runId: string;
  markdown: string;
}): string {
  if (!isDemoRun(run)) return run.markdown;
  return withDemoSampleHeader(run.runId, run.markdown);
}
