import { pauseReasonCopy } from "@/components/room/pause-reasons";
import {
  isNeedsRebasePause,
  pausedPanelBranch,
  retryCountForPause,
} from "@/components/room/round-timeline";
import { resolveSpeaker } from "@/components/room/round-timeline";
import { Modal } from "@/components/ui/Modal";
import type {
  DiscussionAgent,
  DiscussionRound,
  Participant,
  RoundPausedFrom,
} from "@/models/discussion/entities";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import { useRoomIntents } from "@/stores/runtime-intents";
import { useRoundExecutions, useRuntimeRoom } from "@/stores/runtime-queries";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";

const PAUSED_FROM_LABELS: Record<RoundPausedFrom, string> = {
  prewarming: "预热阶段",
  running: "发言阶段",
  summarizing: "总结阶段",
};

interface PausedPanelProps {
  round: DiscussionRound;
  participants: Participant[];
  agents: DiscussionAgent[];
  profiles: ExecutionProfileRecord[];
  /** Mutations are only wired for the Scope Controller page. */
  controlling: boolean;
  onAbort: () => void;
  abortPending: boolean;
}

/**
 * Paused-round panel (U6, S3 recovery): branches the affordances by
 * `pauseReason.code` + facilitator identity —
 *  - needs_rebase family → 重建执行环境（轮转）+ 终止；
 *  - recoverable failure on a non-facilitator → 重试 / 跳过并继续 / 终止；
 *  - recoverable failure on the facilitator → 重试 + 修复入口 + 终止（无跳过，ruling #1）；
 *  - prewarm/user_cancelled/facilitator_unavailable → 修复入口 + 终止（现状）。
 * New recovery actions are self-wired here (useRuntimeRoom / useRoundExecutions
 * / useRoomIntents) so RoomPage stays untouched; their errors surface inline.
 * The terminate action 终止本轮（不生成总结）stays behind a confirm modal across
 * every branch (R3): abort is irreversible, so a misclick must never fire it.
 */
export function PausedPanel({
  round,
  participants,
  agents,
  profiles,
  controlling,
  onAbort,
  abortPending,
}: PausedPanelProps) {
  const [confirmSkipOpen, setConfirmSkipOpen] = useState(false);
  const [confirmAbortOpen, setConfirmAbortOpen] = useState(false);
  const dangerButtonRef = useRef<HTMLButtonElement>(null);

  // Self-wired reads/mutations (RoomPage is not changed; S3 ruling #2).
  const tick = useRuntimeDiscussionStore((state) =>
    round.roomId ? (state.changeTickByRoom[round.roomId] ?? 0) : 0,
  );
  const { data: room } = useRuntimeRoom(round.roomId, tick);
  const { data: executions } = useRoundExecutions(round.id, tick);
  const { retryFailedParticipant, skipFailedParticipant, rotateScope } = useRoomIntents(
    round.roomId,
  );

  const reason = round.pauseReason;
  if (!reason) return null;
  const isRebase = isNeedsRebasePause(reason);
  // needs_rebase family copy is dedicated; other codes keep their mapped copy.
  const copy = pauseReasonCopy(isRebase ? "needs_rebase" : reason.code);
  const branch = pausedPanelBranch(reason, room?.facilitatorParticipantId);
  const retries = retryCountForPause(executions ?? [], reason);

  const participantsById = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));

  const affectedParticipant = reason.participantId
    ? participantsById.get(reason.participantId)
    : undefined;
  const speaker = resolveSpeaker(reason.participantId, participantsById, agentsById);
  const profileName = affectedParticipant
    ? (profilesById.get(affectedParticipant.executionProfileId)?.name ?? "未知 Profile")
    : null;

  const roomPaused = room?.runState === "paused";
  const gateHint = roomPaused ? "（房已暂停，先点「继续」释放调度门）" : "";

  const closeConfirmSkip = () => {
    setConfirmSkipOpen(false);
    setTimeout(() => dangerButtonRef.current?.focus(), 0);
  };
  const closeConfirmAbort = () => {
    setConfirmAbortOpen(false);
    setTimeout(() => dangerButtonRef.current?.focus(), 0);
  };

  const repairEntries = branch === "rotate" ? [] : copy.repair;

  return (
    <section
      className="mx-auto w-full max-w-3xl rounded border border-warn bg-warn/10 px-6 py-4"
      aria-label="本轮已暂停"
      data-testid="paused-panel"
      data-branch={branch}
    >
      <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
        <span aria-hidden="true">⚠</span>第 {round.roundNumber} 轮已暂停：{copy.title}
      </h2>
      <p className="mt-1 text-xs text-muted">
        暂停于{round.pausedFrom ? PAUSED_FROM_LABELS[round.pausedFrom] : "未知阶段"}
        {reason.participantId ? ` · 受影响 Participant：${speaker.name}` : ""}
        {profileName ? ` · Profile：${profileName}` : ""}
      </p>
      <p className="mt-2 break-words text-sm text-fg">{copy.description}</p>
      {reason.detail ? (
        // Untrusted detail: plain text node, wraps on narrow viewports.
        <p className="mt-1 break-words text-xs text-muted">详情：{reason.detail}</p>
      ) : null}
      <ul className="mt-2 list-disc pl-5 text-xs text-muted">
        <li>本轮已提交的发言与总结已保留在上面的时间线中。</li>
        <li>未提交的生成预览已丢弃，不会写入讨论记录。</li>
      </ul>
      {repairEntries.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {repairEntries.map((entry) => (
            <Link
              key={entry.href + entry.label}
              to={entry.href}
              className="rounded border border-edge bg-surface px-3 py-1.5 text-xs text-accent hover:underline"
            >
              {entry.label}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {branch === "rotate" ? (
          <button
            type="button"
            disabled={!controlling || rotateScope.isPending || roomPaused}
            onClick={() => rotateScope.mutate()}
            title={controlling ? undefined : "只读观察中，无法操作"}
            className="rounded border border-accent bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {rotateScope.isPending ? "正在重建…" : "重建执行环境（轮转）"}
          </button>
        ) : null}
        {branch === "recoverable" || branch === "facilitator" ? (
          <button
            type="button"
            disabled={!controlling || retryFailedParticipant.isPending || roomPaused}
            onClick={() => retryFailedParticipant.mutate()}
            title={controlling ? undefined : "只读观察中，无法操作"}
            className="rounded border border-accent bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {retryFailedParticipant.isPending
              ? "正在重试…"
              : retries > 0
                ? `重试该 Participant（已重试 ${retries} 次）`
                : "重试该 Participant"}
          </button>
        ) : null}
        {branch === "recoverable" ? (
          <button
            type="button"
            disabled={!controlling || skipFailedParticipant.isPending || roomPaused}
            onClick={() => setConfirmSkipOpen(true)}
            title={controlling ? undefined : "只读观察中，无法操作"}
            className="rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-fg hover:bg-surface/80 disabled:opacity-50"
          >
            跳过并继续
          </button>
        ) : null}
        {branch === "rotate" ? (
          <span className="text-xs text-muted">
            将终止本轮、关闭当前执行环境，并从完整讨论记录冷启动新环境自动开新一轮{gateHint}
          </span>
        ) : null}
      </div>

      {retryFailedParticipant.error ? (
        <p role="alert" className="mt-2 break-words text-xs text-error">
          重试失败：{retryFailedParticipant.error.message}
        </p>
      ) : null}
      {skipFailedParticipant.error ? (
        <p role="alert" className="mt-2 break-words text-xs text-error">
          跳过失败：{skipFailedParticipant.error.message}
        </p>
      ) : null}
      {rotateScope.error ? (
        <p role="alert" className="mt-2 break-words text-xs text-error">
          轮转失败：{rotateScope.error.message}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          ref={dangerButtonRef}
          type="button"
          disabled={!controlling || abortPending}
          onClick={() => setConfirmAbortOpen(true)}
          title={controlling ? undefined : "只读观察中，无法操作"}
          className="rounded border border-error bg-error/10 px-3 py-1.5 text-sm font-medium text-error hover:bg-error/20 disabled:opacity-50"
        >
          {abortPending ? "正在终止…" : "终止本轮（不生成总结）"}
        </button>
        <span className="text-xs text-muted">终止后可随时开始新一轮。</span>
      </div>

      <Modal open={confirmAbortOpen} onClose={closeConfirmAbort} title="终止本轮？">
        <p className="text-sm text-fg">
          终止后本轮不会再生成总结，未提交的生成预览将被丢弃；已提交的发言会保留。该操作不可撤销。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={closeConfirmAbort}
            className="rounded border border-edge px-3 py-1.5 text-sm text-fg hover:bg-surface"
          >
            取消
          </button>
          <button
            type="button"
            disabled={abortPending}
            onClick={() => {
              onAbort();
              closeConfirmAbort();
            }}
            className="rounded border border-error bg-error/10 px-3 py-1.5 text-sm font-medium text-error hover:bg-error/20 disabled:opacity-50"
          >
            确认终止
          </button>
        </div>
      </Modal>

      <Modal open={confirmSkipOpen} onClose={closeConfirmSkip} title="跳过该 Participant？">
        <p className="text-sm text-fg">
          跳过后该 Participant 本轮将缺席，其发言执行失败会记录在时间线并告知总结。该操作不可撤销。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={closeConfirmSkip}
            className="rounded border border-edge px-3 py-1.5 text-sm text-fg hover:bg-surface"
          >
            取消
          </button>
          <button
            type="button"
            disabled={skipFailedParticipant.isPending}
            onClick={() => {
              skipFailedParticipant.mutate();
              closeConfirmSkip();
            }}
            className="rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-fg hover:bg-surface/80 disabled:opacity-50"
          >
            确认跳过
          </button>
        </div>
      </Modal>
    </section>
  );
}
