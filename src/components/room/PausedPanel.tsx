import { pauseReasonCopy } from "@/components/room/pause-reasons";
import { resolveSpeaker } from "@/components/room/round-timeline";
import { Modal } from "@/components/ui/Modal";
import type {
  DiscussionAgent,
  DiscussionRound,
  Participant,
  RoundPausedFrom,
} from "@/models/discussion/entities";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
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
 * Paused-round panel (U6): exact pauseReason.code mapped copy, the affected
 * Participant/Profile, what was kept (committed Messages) and what was
 * dropped (uncommitted preview), repair entries, and the danger action
 * 终止本轮（不生成总结）behind a confirm modal.
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const dangerButtonRef = useRef<HTMLButtonElement>(null);

  const reason = round.pauseReason;
  if (!reason) return null;
  const copy = pauseReasonCopy(reason.code);

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

  const closeConfirm = () => {
    setConfirmOpen(false);
    // a11y: return focus to the danger action that opened the modal.
    setTimeout(() => dangerButtonRef.current?.focus(), 0);
  };

  return (
    <section
      className="mx-auto w-full max-w-3xl rounded border border-warn bg-warn/10 px-6 py-4"
      aria-label="本轮已暂停"
      data-testid="paused-panel"
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
      {copy.repair.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {copy.repair.map((entry) => (
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
        <button
          ref={dangerButtonRef}
          type="button"
          disabled={!controlling || abortPending}
          onClick={() => setConfirmOpen(true)}
          title={controlling ? undefined : "只读观察中，无法操作"}
          className="rounded border border-error bg-error/10 px-3 py-1.5 text-sm font-medium text-error hover:bg-error/20 disabled:opacity-50"
        >
          {abortPending ? "正在终止…" : "终止本轮（不生成总结）"}
        </button>
        <span className="text-xs text-muted">终止后可随时开始新一轮。</span>
      </div>
      <Modal open={confirmOpen} onClose={closeConfirm} title="终止本轮？">
        <p className="text-sm text-fg">
          终止后本轮不会再生成总结，未提交的生成预览将被丢弃；已提交的发言会保留。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={closeConfirm}
            className="rounded border border-edge px-3 py-1.5 text-sm text-fg hover:bg-surface"
          >
            取消
          </button>
          <button
            type="button"
            disabled={abortPending}
            onClick={() => {
              onAbort();
              closeConfirm();
            }}
            className="rounded border border-error bg-error/10 px-3 py-1.5 text-sm font-medium text-error hover:bg-error/20 disabled:opacity-50"
          >
            确认终止
          </button>
        </div>
      </Modal>
    </section>
  );
}
