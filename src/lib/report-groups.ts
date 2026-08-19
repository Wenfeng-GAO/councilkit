import { extractPrUrl } from "@/lib/fix-prompt";
import type { ParsedReviewReport } from "@/lib/review-report";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";

export interface RunGroup {
  key: string;
  label: string;
  runs: CliRunSummaryDto[];
}

export function groupCliRuns(runs: readonly CliRunSummaryDto[]): RunGroup[] {
  const groups = new Map<string, CliRunSummaryDto[]>();
  const order: string[] = [];
  for (const run of runs) {
    const key = extractPrUrl(run.title) ?? run.title;
    if (!groups.has(key)) {
      order.push(key);
      groups.set(key, []);
    }
    groups.get(key)?.push(run);
  }
  return order.map((key) => ({
    key,
    label: key,
    runs: groups.get(key) ?? [],
  }));
}

export interface FindingFingerprint {
  id: string;
  severity: string;
  qualifier: string;
  text: string;
  section: string;
}

export function flattenFindings(report: ParsedReviewReport): FindingFingerprint[] {
  const out: FindingFingerprint[] = [];
  for (const section of report.sections) {
    if (!section.findings) continue;
    if (section.title !== "共识发现" && section.title !== "独有发现") continue;
    for (const finding of section.findings) {
      const text = finding.text.replace(/`/g, "").replace(/\s+/g, " ").trim();
      const head = text.split(/[。.\n]/)[0]?.slice(0, 120) ?? text.slice(0, 120);
      out.push({
        id: `${section.title}|${finding.severity ?? ""}|${head}`,
        severity: finding.severity ?? "",
        qualifier: finding.qualifier ?? "",
        text: finding.text,
        section: section.title,
      });
    }
  }
  return out;
}

export interface FindingDiff {
  onlyA: FindingFingerprint[];
  onlyB: FindingFingerprint[];
  both: Array<{ a: FindingFingerprint; b: FindingFingerprint }>;
}

export function diffFindings(a: FindingFingerprint[], b: FindingFingerprint[]): FindingDiff {
  const bById = new Map(b.map((item) => [item.id, item]));
  const used = new Set<string>();
  const onlyA: FindingFingerprint[] = [];
  const both: Array<{ a: FindingFingerprint; b: FindingFingerprint }> = [];
  for (const item of a) {
    const match = bById.get(item.id);
    if (match) {
      both.push({ a: item, b: match });
      used.add(item.id);
    } else {
      onlyA.push(item);
    }
  }
  const onlyB = b.filter((item) => !used.has(item.id));
  return { onlyA, onlyB, both };
}

export function buildPrComment(title: string, report: ParsedReviewReport): string {
  const findings = flattenFindings(report).filter((item) => item.section === "共识发现");
  const lines = [`CouncilKit Jury：${report.verdict ?? "comment"}`, "", title, "", "## 共识发现"];
  if (findings.length === 0) {
    lines.push("（报告里没有解析出共识发现条目。）");
  } else {
    for (const finding of findings) {
      const head = finding.text.split("\n")[0] ?? finding.text;
      const sev = finding.severity ? `[${finding.severity}]` : "";
      const qual = finding.qualifier ? `[${finding.qualifier}]` : "";
      lines.push(`- ${sev}${qual} ${head}`.trim());
    }
  }
  lines.push("", "请按 critical/major 优先修复，并在评论里说明验证命令。");
  return `${lines.join("\n")}\n`;
}

export function siblingRuns(
  runs: readonly CliRunSummaryDto[],
  current: CliRunSummaryDto,
): CliRunSummaryDto[] {
  const key = extractPrUrl(current.title) ?? current.title;
  return runs.filter(
    (run) => run.runId !== current.runId && (extractPrUrl(run.title) ?? run.title) === key,
  );
}
