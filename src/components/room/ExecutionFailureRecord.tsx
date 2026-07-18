import { failureRecordDisplay, resolveSpeaker } from "@/components/room/round-timeline";
import { isSkippedFailure, rotationDisplayFor } from "@/components/room/round-timeline";
import type { Participant } from "@/models/discussion/entities";
import type { DiscussionAgent } from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import { useRoomRecoveryFacts } from "@/stores/runtime-queries";

interface ExecutionFailureRecordProps {
  execution: ModelExecution;
  participantsById: ReadonlyMap<string, Participant>;
  agentsById: ReadonlyMap<string, DiscussionAgent>;
}

/**
 * Collapsed structured failure record (U6, S3): one discarded/failed/interrupted
 * ModelExecution rendered as code + state + participant + detail. The generated
 * body text is NEVER shown — it was intentionally not committed.
 *
 * S3 additions (self-wired via useRoomRecoveryFacts; DiscussionStream is not
 * changed): a rotation line when the environment was rebuilt after this failure
 * (a needs_rebase failure whose newer binding proves the rebuild), and a
 * 「· 已跳过」 summary marker when the cursor passed this slot without a commit.
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

  // Self-wired room-level facts (S3 ruling #2): the rotation entry and the
  // skipped marker both derive from persisted facts, never triggering execution.
  const tick = useRuntimeDiscussionStore((state) =>
    execution.roomId ? (state.changeTickByRoom[execution.roomId] ?? 0) : 0,
  );
  const { data: recovery } = useRoomRecoveryFacts(execution.roomId, tick);
  const rotation =
    recovery && rotationDisplayFor(execution, recovery.executions, recovery.bindings);
  const skipped = recovery && isSkippedFailure(execution, recovery.rounds, recovery.executions);

  return (
    <details className={`rounded border p-2 text-sm ${toneClass}`} data-testid="failure-record">
      <summary className="cursor-pointer select-none text-fg">
        <span className="font-medium">{display.stateLabel}</span>
        {" · "}
        <span>{display.codeLabel}</span>
        {" · "}
        <span className="text-muted">{speaker.name}</span>
        {skipped ? <span className="text-muted"> · 已跳过</span> : null}
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
        {rotation?.rebuilt ? (
          <div className="flex flex-wrap gap-1" data-testid="rotation-entry">
            <dt className="text-muted">执行环境：</dt>
            <dd>已重建（needs_rebase · 第 {rotation.n} 次）</dd>
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
