import { failureRecordDisplay, resolveSpeaker } from "@/components/room/round-timeline";
import type { Participant } from "@/models/discussion/entities";
import type { DiscussionAgent } from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";

interface ExecutionFailureRecordProps {
  execution: ModelExecution;
  participantsById: ReadonlyMap<string, Participant>;
  agentsById: ReadonlyMap<string, DiscussionAgent>;
}

/**
 * Collapsed structured failure record (U6): one discarded/failed/interrupted
 * ModelExecution rendered as code + state + participant + detail. The
 * generated body text is NEVER shown — it was intentionally not committed.
 */
export function ExecutionFailureRecord({
  execution,
  participantsById,
  agentsById,
}: ExecutionFailureRecordProps) {
  const display = failureRecordDisplay(execution);
  const speaker = resolveSpeaker(execution.participantId, participantsById, agentsById);
  const toneClass =
    display.tone === "error" ? "border-error bg-error/10" : "border-warn bg-warn/10";

  return (
    <details className={`rounded border p-2 text-sm ${toneClass}`} data-testid="failure-record">
      <summary className="cursor-pointer select-none text-fg">
        <span className="font-medium">{display.stateLabel}</span>
        {" · "}
        <span>{display.codeLabel}</span>
        {" · "}
        <span className="text-muted">{speaker.name}</span>
      </summary>
      <dl className="mt-2 flex flex-col gap-1 pl-4 text-xs text-fg">
        <div className="flex flex-wrap gap-1">
          <dt className="text-muted">结果类型：</dt>
          <dd>{execution.resultKind === "summary" ? "总结" : "发言"}</dd>
        </div>
        {execution.error ? (
          <div className="flex flex-wrap gap-1">
            <dt className="text-muted">错误代码：</dt>
            <dd className="break-all">{execution.error.code}</dd>
          </div>
        ) : null}
        {display.detail ? (
          <div className="flex flex-wrap gap-1">
            <dt className="text-muted">详情：</dt>
            {/* Untrusted detail: plain text node, wrapped — never markdown HTML. */}
            <dd className="break-words">{display.detail}</dd>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1">
          <dt className="text-muted">executionId：</dt>
          <dd className="break-all">{execution.executionId}</dd>
        </div>
      </dl>
    </details>
  );
}
