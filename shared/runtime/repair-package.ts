import { z } from "zod";
import {
  FINDING_SEVERITIES,
  type FindingsFile,
  type PlanLockFile,
  isFindingBlocking,
  isFindingVerifiedClosed,
} from "./cli-ledger";
import { type FindingGroupsFile, resolveRootCause, validateFindingGroups } from "./finding-groups";

const text = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      Array.from(value).every((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code !== 0 && !(code >= 0xd800 && code <= 0xdfff);
      }),
    "Invalid text",
  );
const repoPath = text
  .max(400)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("-") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !Array.from(value).some(
        (char) => (char.codePointAt(0) ?? 0) < 32 || char.codePointAt(0) === 127,
      ) &&
      !value.split("/").some((part) => ["", ".", "..", ".git"].includes(part)),
    "Files must be canonical repo-relative paths",
  );
const httpUrl = text
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "PR URL must use HTTP(S) without credentials");
export const repairPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("councilkit-repair"),
    source: z
      .object({
        runId: text.max(160),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        prUrl: httpUrl.nullable(),
      })
      .strict(),
    findings: z
      .array(
        z
          .object({
            id: text.max(160),
            title: text.max(400),
            severity: z.enum(FINDING_SEVERITIES),
            rootCause: text.max(400),
            invariant: text.max(8000),
            evidence: text.max(8000),
            files: z.array(repoPath).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    constraints: z
      .object({
        invariants: z.array(text.max(8000)).max(200),
        forbidden: z.array(text.max(8000)).max(200),
        acceptance: z.array(text.max(8000)).max(200),
        deferred: z
          .array(z.object({ id: text.max(160), reason: text.max(8000) }).strict())
          .max(264),
      })
      .strict(),
    convergence: z
      .object({ maxFixRounds: z.literal(3), repeatedRootCauseLimit: z.literal(2) })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 4 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Repair package exceeds the 4 MiB intake limit" });
    const scoped = new Set(value.findings.map((row) => row.id));
    const deferred = new Set<string>();
    for (const row of value.constraints.deferred) {
      if (scoped.has(row.id) || deferred.has(row.id))
        ctx.addIssue({
          code: "custom",
          path: ["constraints", "deferred"],
          message: "Deferred IDs must be unique and outside repair scope",
        });
      deferred.add(row.id);
    }
    if (new Set(value.findings.map((row) => row.id)).size !== value.findings.length) {
      ctx.addIssue({ code: "custom", path: ["findings"], message: "Duplicate finding id" });
    }
  });
export type RepairPackage = z.infer<typeof repairPackageSchema>;

/** A portable task boundary, never an authorization to push or mutate a PR. */
export function buildRepairPackage(input: {
  runId: string;
  complete: boolean;
  prUrl: string | null;
  ledger: Pick<FindingsFile, "runId" | "sha" | "findings"> | null;
  planLock: PlanLockFile | null;
  clusterId?: string;
  findingGroups?: FindingGroupsFile | null;
}): RepairPackage {
  const { ledger, planLock, clusterId } = input;
  if (!input.complete)
    throw new Error("需要完整成功的独立审查；失败或不完整的 run 不能导出修复任务。");
  if (!ledger || ledger.runId !== input.runId || !/^[0-9a-f]{40}$/i.test(ledger.sha ?? "")) {
    throw new Error("修复任务需要与本次 run 对应的 findings.json 和完整候选 SHA。");
  }
  if (input.findingGroups) {
    validateFindingGroups(
      input.findingGroups,
      new Set(ledger.findings.map((row) => row.id)),
    );
    if (
      input.findingGroups.source.runId !== input.runId ||
      input.findingGroups.source.sha !== ledger.sha?.toLowerCase()
    ) {
      throw new Error("finding-groups sidecar does not match this run");
    }
  }
  if (planLock && (planLock.sourceRunId !== input.runId || planLock.verdict !== "approve")) {
    throw new Error("修复方案尚未获准，或 plan.lock 不属于本次 run。");
  }
  const clusters = planLock?.clusters ?? [];
  const selected = clusterId ? clusters.filter((row) => row.id === clusterId) : clusters;
  if (clusterId && selected.length === 0) throw new Error(`找不到已批准的 cluster: ${clusterId}`);
  const selectedIds = new Set(selected.flatMap((row) => row.closes));
  const remaining = ledger.findings.filter(
    (row) =>
      !isFindingVerifiedClosed(row, ledger.sha) &&
      (row.status !== "accepted" || isFindingBlocking(row, ledger.sha)),
  );
  const included = remaining.filter((row) => !clusterId || selectedIds.has(row.id));
  if (included.length === 0) throw new Error("所选范围没有待修复的问题。");
  const findings = included.map((row) => {
    const plans = selected.filter((cluster) => cluster.closes.includes(row.id));
    return {
      id: row.id,
      title: row.title,
      severity: row.severity,
      rootCause: resolveRootCause(row.id, input.findingGroups),
      invariant:
        plans
          .map((cluster) => cluster.invariants.trim())
          .filter(Boolean)
          .join("\n") || `修复 ${row.id}：${row.title}`,
      evidence: row.text.trim() || row.title,
      files: unique([...row.files, ...plans.flatMap((cluster) => cluster.files)]),
    };
  });
  const deferred = remaining
    .filter((row) => !included.includes(row))
    .map((row) => ({
      id: row.id,
      reason: `${isFindingBlocking(row, ledger.sha) ? "重大项仍未验证关闭，不可据此批准 PR；" : ""}不在所选 cluster 范围，需单独处理。`,
    }));
  for (const row of ledger.findings) {
    if (row.status === "accepted" && !isFindingBlocking(row, ledger.sha)) {
      deferred.push({
        id: row.id,
        reason: `来源账本标记 accepted，未表示已验证修复；沿用前须核实原裁决及适用条件。${row.severity === "critical" || row.severity === "major" ? ` ${row.severity} 重大风险残余。` : ""}`,
      });
    }
  }
  for (const item of planLock?.deferred ?? []) {
    const match = ledger.findings.find((row) => row.title === item.title || row.id === item.title);
    deferred.push({
      id: match?.id ?? `plan-deferred-${deferred.length + 1}`,
      reason: `${item.title}：${item.reason}`,
    });
  }
  return repairPackageSchema.parse({
    schemaVersion: 1,
    kind: "councilkit-repair",
    source: { runId: input.runId, sha: ledger.sha?.toLowerCase(), prUrl: input.prUrl },
    findings,
    constraints: {
      invariants: unique(findings.map((row) => row.invariant)),
      forbidden: unique([
        "未经单独授权不得 push、合并 PR、访问生产或扩大修改范围。",
        ...selected.map((row) => row.forbidden.trim()).filter(Boolean),
      ]),
      acceptance: unique([
        "独立复审同一候选 SHA，逐条提供关闭证据；apply 声明或未再报告不等于关闭。",
        "所有范围外重大项保持未决，不以本任务完成声明整体 PR 已通过。",
        ...selected.flatMap((row) => [...row.gates, row.tests.trim()]).filter(Boolean),
      ]),
      deferred: mergeDeferred(deferred, new Set(findings.map((row) => row.id))),
    },
    convergence: { maxFixRounds: 3, repeatedRootCauseLimit: 2 },
  });
}

function mergeDeferred(rows: { id: string; reason: string }[], scoped: Set<string>) {
  const merged = new Map<string, string[]>();
  for (const row of rows) {
    if (scoped.has(row.id)) continue;
    merged.set(row.id, unique([...(merged.get(row.id) ?? []), row.reason]));
  }
  return [...merged].map(([id, reasons]) => ({ id, reason: reasons.join("\n") }));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function repairExportCommand(runId: string, clusterId?: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `councilkit repair export --run ${quote(runId)} --out ${quote(`repair-${runId}.json`)}${clusterId ? ` --cluster ${quote(clusterId)}` : ""}`;
}
