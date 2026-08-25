import { cliRunPhaseHeading, cliRunStatusPill } from "@/lib/cli-run-status";
import type { CliRunHandoffDto, CliRunSummaryDto } from "@shared/runtime/schemas";
import { Link } from "react-router-dom";

const CANDIDATE_STATUS = {
  intended: "已声明",
  completed: "已冻结",
  invalidated: "已作废",
} as const;

type SquadRun = Pick<CliRunSummaryDto, "kind" | "status" | "progress" | "handoff">;

export function SquadHandoffCard({ run }: { run: SquadRun }) {
  if (run.kind !== "squad") return null;
  const handoff = run.handoff;
  const phase = run.progress?.phase;
  if (handoff === null && phase === undefined) return null;
  const pill = cliRunStatusPill("squad", run.status);
  const heading = phase !== undefined ? cliRunPhaseHeading("squad", run.status, phase) : pill.text;
  return (
    <section className="ck-report mb-6 border border-edge bg-surface px-4 py-4">
      <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">班组</p>
      <p className="mt-1 text-sm text-fg">{heading}</p>
      <dl className="mt-3 grid gap-3 text-sm leading-6 sm:grid-cols-2">
        {handoff?.epoch !== undefined ? (
          <HandoffField label="epoch" value={String(handoff.epoch)} />
        ) : null}
        {phase !== undefined ? <HandoffField label="phase" value={phase} /> : null}
        <ShaField label="task_base_sha" sha={handoff?.taskBaseSha} />
        <ShaField label="parent_candidate_sha" sha={handoff?.parentCandidateSha} />
        <ShaField
          label="candidate_sha"
          sha={handoff?.candidateSha}
          extra={handoff?.candidateStatus ? CANDIDATE_STATUS[handoff.candidateStatus] : undefined}
        />
        {handoff?.invalidatedReason ? (
          <HandoffField label="作废原因" value={handoff.invalidatedReason} wide />
        ) : null}
        {fixLabel(handoff) ? <HandoffField label="当前修复轮" value={fixLabel(handoff)} /> : null}
        {handoff?.reviewerVerdict ? (
          <HandoffField label="Reviewer" value={handoff.reviewerVerdict} />
        ) : null}
        {handoff?.verifierVerdict ? (
          <HandoffField label="Verifier" value={handoff.verifierVerdict} />
        ) : null}
        {handoff?.approved !== undefined ? (
          <HandoffField label="能不能合" value={handoff.approved ? "可以合" : "不能合"} />
        ) : null}
        {handoff?.next ? <HandoffField label="next" value={handoff.next} wide /> : null}
        {handoff?.remainingBlockers && handoff.remainingBlockers.length > 0 ? (
          <HandoffField label="剩余阻塞" value={handoff.remainingBlockers.join(" · ")} wide />
        ) : null}
        {handoff?.reviewRunId ? (
          <div className="sm:col-span-2">
            <dt className="font-command text-[0.62rem] uppercase tracking-[0.12em] text-brass">
              陪审
            </dt>
            <dd className="mt-1 text-muted">
              <Link to={`/reports/${handoff.reviewRunId}`} className="text-accent hover:underline">
                {handoff.reviewRunId}
              </Link>
            </dd>
          </div>
        ) : null}
      </dl>
      {handoff?.seatNotes && handoff.seatNotes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {handoff.seatNotes.map((note) => (
            <li key={note.attemptId}>
              <code className="font-command text-parchment">{note.attemptId}</code>
              {note.purpose ? ` · ${note.purpose}` : ""}
              {note.note ? ` · ${note.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function HandoffField({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string | undefined;
  wide?: boolean;
}) {
  if (!value) return null;
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="font-command text-[0.62rem] uppercase tracking-[0.12em] text-brass">
        {label}
      </dt>
      <dd className="mt-1 break-words text-muted">{value}</dd>
    </div>
  );
}

function ShaField({
  label,
  sha,
  extra,
}: {
  label: string;
  sha: string | undefined;
  extra?: string;
}) {
  if (!sha) return null;
  const short = sha.length > 8 ? sha.slice(0, 8) : sha;
  return (
    <div>
      <dt className="font-command text-[0.62rem] uppercase tracking-[0.12em] text-brass">
        {label}
      </dt>
      <dd className="mt-1 font-command text-muted" title={sha}>
        {short}
        {extra ? <span className="ml-2 text-fg">{extra}</span> : null}
      </dd>
    </div>
  );
}

function fixLabel(handoff: CliRunHandoffDto | null | undefined): string | undefined {
  if (!handoff?.currentFix) return undefined;
  if (typeof handoff.currentFix === "string") return handoff.currentFix;
  const parts: string[] = [];
  if (handoff.currentFix.round !== undefined) parts.push(`round ${handoff.currentFix.round}`);
  if (handoff.currentFix.operationId) parts.push(handoff.currentFix.operationId);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
