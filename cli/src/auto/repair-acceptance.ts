import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import { type RepairPackage, repairPackageSchema } from "@shared/runtime/repair-package";
import { canonicalPr } from "@shared/runtime/review-explainer/pr-decisions";
import { errors } from "../errors";

export const REVIEW_REPAIR_PACKAGE_FILE = "repair-package.json";

export function readReviewRepairPackage(input: {
  path: string;
  prUrl?: string;
  against?: string;
  sourceSha?: string | null;
  findings: readonly LedgerFinding[];
}): RepairPackage {
  try {
    const stat = lstatSync(input.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
      throw new Error("修复任务包必须是 4 MiB 内的普通 JSON 文件");
    }
    const pkg = repairPackageSchema.parse(JSON.parse(readFileSync(input.path, "utf8")));
    if (!input.against || pkg.source.runId !== input.against) {
      throw new Error("--repair-package 的来源必须与 --against 对应");
    }
    if (
      !input.prUrl ||
      !pkg.source.prUrl ||
      canonicalPr(input.prUrl) !== canonicalPr(pkg.source.prUrl)
    ) {
      throw new Error("修复任务包不属于此次 PR");
    }
    if (!input.sourceSha || input.sourceSha.toLowerCase() !== pkg.source.sha) {
      throw new Error("修复任务包 SHA 不匹配来源审查");
    }
    for (const finding of pkg.findings) {
      const original = input.findings.find((row) => row.id === finding.id);
      if (!original || !finding.evidence.includes(original.text.trim() || original.title)) {
        throw new Error("修复任务包必须保留来源 finding 的完整原断言和证据");
      }
    }
    return pkg;
  } catch (error) {
    throw errors.usage(
      error instanceof Error ? `无法读取修复任务验收：${error.message}` : "无效修复任务包",
    );
  }
}

export function repairPackageHash(pkg: RepairPackage): string {
  return createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
}

export function formatRepairAcceptance(pkg: RepairPackage): string {
  // JSON keeps all original assertions/evidence as data and preserves the bounded task scope.
  return [
    "## 修复任务验收",
    "```json",
    JSON.stringify(pkg, null, 2),
    "```",
    "只将 findings 列出的选择集与其原断言、反例和预期结果视为这次修复任务的验收范围。Builder claim 只表示声称完成，不能替代对同一候选 SHA 的独立验证。",
    "其他 PR 发现属于独立观察，保持原状态并在此任务之外列出；未选不等于不修复，不得因选中项通过就宣布整体 PR 通过。",
  ].join("\n");
}
