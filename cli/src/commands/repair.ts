import { realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { isCliRunId, readCliRun } from "@shared/runtime/cli-runs-index";
import { type RepairPackage, buildRepairPackage } from "@shared/runtime/repair-package";
import { isCompleteReviewRun } from "@shared/runtime/review-case";
import { errors } from "../errors";
import type { OutputSink } from "../output";
import { resolvePaths } from "../store/paths";
import { parseFlags } from "./parse";

/** Export only. No extraction, agent execution, landing or push side effects. */
export async function runRepair(argv: string[], out: OutputSink): Promise<void> {
  if (argv[0] !== "export")
    throw errors.usage("repair requires: export --run <id> --out <file> [--cluster <id>]");
  const { values } = parseFlags(
    {
      flags: {
        run: { type: "string" },
        out: { type: "string" },
        cluster: { type: "string" },
        json: { type: "boolean" },
      },
      allowPositionals: 0,
    },
    argv.slice(1),
  );
  const runId = typeof values.run === "string" ? values.run : "";
  const output = typeof values.out === "string" ? values.out.trim() : "";
  if (!isCliRunId(runId) || !runId.startsWith("ck-review-"))
    throw errors.usage("--run must identify a review run");
  if (!output) throw errors.usage("--out is required");
  const run = readCliRun(runId);
  if (!run) throw errors.usage("review run not found");
  if (run.hasPlanLock && !run.planLock)
    throw errors.usage("plan.lock.json is invalid or truncated");
  let task: RepairPackage;
  try {
    task = buildRepairPackage({
      runId,
      complete: isCompleteReviewRun(run),
      prUrl: run.reviewEvidence?.prUrl ?? null,
      ledger: { runId, sha: run.reviewEvidence?.sha ?? null, findings: run.findings },
      planLock: run.planLock,
      clusterId: typeof values.cluster === "string" ? values.cluster : undefined,
    });
  } catch (error) {
    throw errors.usage(error instanceof Error ? error.message : "invalid repair source");
  }
  const path = resolve(output);
  try {
    const parent = realpathSync(dirname(path));
    const runsRoot = realpathSync(resolvePaths().runsRoot);
    if (parent === runsRoot || parent.startsWith(runsRoot + sep)) {
      throw errors.usage("--out must be outside the runs history directory");
    }
    // Exclusive creation: export must never overwrite a report, ledger or user file.
    writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
    throw errors.io("cannot create repair package; use a new file in an existing output directory");
  }
  await out.finish(
    { runId, path, findings: task.findings.length, deferred: task.constraints.deferred.length },
    () =>
      `已导出 ${task.findings.length} 个问题：${path}\n仅包含修复范围和验收约束，不授予 push 或合并权限。`,
  );
}
