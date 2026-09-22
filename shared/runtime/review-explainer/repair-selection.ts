import { type FindingsFile, isFindingVerifiedClosed } from "../cli-ledger";
import { type RepairPackage, repairPackageSchema } from "../repair-package";
import type { DecisionItem, FindingDecision } from "./contracts";
import { ExplainerError } from "./io";
import { decisionForFinding } from "./pr-decisions";

export function buildRepairPackageFromSelection(input: {
  runId: string;
  complete: boolean;
  prUrl: string | null;
  ledger: Pick<FindingsFile, "runId" | "sha" | "findings"> | null;
  selectedFindingIds?: string[];
  decisions: Record<string, FindingDecision | DecisionItem>;
  builderClaimedIds?: string[];
}): RepairPackage {
  if (!input.complete || !input.ledger || input.ledger.runId !== input.runId)
    throw new Error("需要完整独立审查才能导出修复任务");
  const ledger = input.ledger;
  const state = (id: string) => {
    const item = input.decisions[id];
    if (typeof item === "string") return item;
    const finding = ledger.findings.find((row) => row.id === id);
    return item && finding
      ? decisionForFinding({ version: 1, revision: 0, items: { [id]: item } }, finding)?.decision
      : undefined;
  };
  const selected =
    input.selectedFindingIds ??
    ledger.findings.filter((row) => state(row.id) === "will_fix").map((row) => row.id);
  if (!selected.length) throw new ExplainerError("请先选择打算修复的评审点");
  if (
    new Set(selected).size !== selected.length ||
    selected.some((id) => state(id) !== "will_fix" || !ledger.findings.some((row) => row.id === id))
  )
    throw new Error("所选范围必须仅包含打算修复的现有问题");
  const findings = ledger.findings
    .filter((row) => selected.includes(row.id) && !isFindingVerifiedClosed(row, ledger.sha))
    .map((row) => {
      const decision = input.decisions[row.id];
      const original = typeof decision === "object" ? decision.originalAssertion : undefined;
      const evidence =
        !original || row.text.includes(original)
          ? row.text
          : `${original}\n\n来源评审证据：${row.text}`;
      return {
        id: row.id,
        title: row.title,
        severity: row.severity,
        rootCause: row.id,
        invariant: evidence || row.title,
        evidence: evidence || row.title,
        files: row.files,
      };
    });
  return repairPackageSchema.parse({
    schemaVersion: 1,
    kind: "councilkit-repair",
    source: { runId: input.runId, sha: ledger.sha, prUrl: input.prUrl },
    findings,
    constraints: {
      invariants: findings.map((row) => row.invariant),
      forbidden: ["不得扩大用户选择范围或推送、合并 PR"],
      acceptance: [
        "原断言、反例和预期结果保持不变；同一候选 SHA 独立验证，修复声明不等于通过",
        "未选重大项保持未决，不以本任务通过宣称整体 PR 已通过",
      ],
      deferred: ledger.findings
        .filter((row) => !selected.includes(row.id))
        .map((row) => ({
          id: row.id,
          reason:
            state(row.id) === "wont_fix"
              ? "用户选择不修复；不是已验证修复"
              : "待决定或不在此修复任务验收范围；整体 PR 仍需核对",
        })),
    },
    convergence: { maxFixRounds: 3, repeatedRootCauseLimit: 2 },
  });
}
