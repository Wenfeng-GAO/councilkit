import { readFindings, writeFindings } from "../auto/ledger";
/**
 * `councilkit findings accept --run <id> --id <findingId> --reason "..."`
 * Record an explicit "won't fix" decision on the ledger. Absence from a later
 * report is not an accept.
 */
import { errors } from "../errors";
import type { OutputSink } from "../output";
import { resolvePaths } from "../store/paths";
import { parseFlags } from "./parse";

const RUN_ID_PATTERN = /^ck-review-[0-9a-fA-F-]+$/;

export interface FindingsAcceptOutcome {
  runId: string;
  findingId: string;
  status: "accepted";
  reason: string;
}

export async function runFindings(argv: string[], out: OutputSink): Promise<void> {
  const sub = argv[0];
  if (sub !== "accept") {
    throw errors.usage(
      sub === undefined
        ? "findings requires a subcommand: accept"
        : `unknown findings subcommand "${sub}" (accept)`,
    );
  }
  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        run: { type: "string" },
        id: { type: "string" },
        reason: { type: "string" },
      },
      allowPositionals: 0,
    },
    argv.slice(1),
  );
  const runId = (values.run as string | undefined)?.trim() ?? "";
  const findingId = (values.id as string | undefined)?.trim() ?? "";
  const reason = (values.reason as string | undefined)?.trim() ?? "";
  if (!RUN_ID_PATTERN.test(runId)) {
    throw errors.usage("--run <ck-review-…> is required");
  }
  if (findingId.length === 0) {
    throw errors.usage("--id <finding-id> is required");
  }
  if (reason.length === 0) {
    throw errors.usage("--reason <text> is required");
  }
  const runDir = resolvePaths().runDir(runId);
  const file = readFindings(runDir);
  if (!file) {
    throw errors.usage(`run ${runId} has no findings.json`);
  }
  const row = file.findings.find((item) => item.id === findingId);
  if (!row) {
    throw errors.usage(`finding ${findingId} is not in ${runId}`);
  }
  const next = {
    ...file,
    findings: file.findings.map((item) =>
      item.id === findingId
        ? {
            ...item,
            status: "accepted" as const,
            acceptedReason: reason,
            acceptedAt: new Date().toISOString(),
          }
        : item,
    ),
  };
  writeFindings(runDir, next);
  const outcome: FindingsAcceptOutcome = {
    runId,
    findingId,
    status: "accepted",
    reason,
  };
  await out.finish(outcome, () => `accepted ${findingId} on ${runId}\n  ${reason}`);
}
