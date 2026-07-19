import { MessageBubble } from "@/components/message/MessageBubble";
import { ExecutionFailureRecord } from "@/components/room/ExecutionFailureRecord";
import { SummaryBlock } from "@/components/room/SummaryBlock";
import { UsageBadge, type UsageTotals, aggregateUsageByRound } from "@/components/room/UsageBadge";
import {
  USER_SPEAKER,
  isFailedExecution,
  resolveSpeaker,
  roundPhaseLabel,
  roundPhaseTone,
} from "@/components/room/round-timeline";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import type { DiscussionAgent, DiscussionRound, Participant } from "@/models/discussion/entities";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import {
  useRoomRecoveryFacts,
  useRoundExecutions,
  useRoundMessages,
  useRoundSummary,
} from "@/stores/runtime-queries";
import { useMemo, useState } from "react";

/**
 * Round-grouped timeline (U6): one ascending list of Rounds. Each Round
 * section shows committed Messages in order, the committed Summary, and one
 * collapsed failure record per discarded/failed execution. Historical Rounds
 * default collapsed; the current (or latest) Round defaults expanded, with
 * the active streaming preview pinned at its tail.
 */

interface DiscussionStreamProps {
  roomId: string;
  rounds: DiscussionRound[];
  participants: Participant[];
  agents: DiscussionAgent[];
  /** room.activeRoundId — the Round that owns the active preview. */
  activeRoundId: string | null;
  tick: number;
}

export function DiscussionStream({
  roomId,
  rounds,
  participants,
  agents,
  activeRoundId,
  tick,
}: DiscussionStreamProps) {
  // S7: 每轮用量徽标。自接线 useRoomRecoveryFacts——与 RoomHeader 同 key 共享
  // 缓存，零新 hook（hooks 必须先于下方的早退 return）。
  const { data: recovery } = useRoomRecoveryFacts(roomId, tick);
  const usageByRound = useMemo(() => aggregateUsageByRound(recovery?.executions ?? []), [recovery]);

  if (rounds.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-4">
        <EmptyState title="还没有讨论" hint="点击「开始新一轮」，参与者会依次发言。" />
      </div>
    );
  }
  const participantsById = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const expandedRoundId = activeRoundId ?? rounds[rounds.length - 1]?.id ?? null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-4">
      {rounds.map((round) => (
        <RoundSection
          key={round.id}
          roomId={roomId}
          round={round}
          isCurrent={round.id === activeRoundId}
          defaultOpen={round.id === expandedRoundId}
          participantsById={participantsById}
          agentsById={agentsById}
          tick={tick}
          usageTotals={usageByRound.get(round.id)}
        />
      ))}
    </div>
  );
}

interface RoundSectionProps {
  roomId: string;
  round: DiscussionRound;
  isCurrent: boolean;
  defaultOpen: boolean;
  participantsById: ReadonlyMap<string, Participant>;
  agentsById: ReadonlyMap<string, DiscussionAgent>;
  tick: number;
  /** S7: 该轮的累计用量（含 discarded/failed，裁决 #6）；undefined/全 null 不渲染。 */
  usageTotals?: UsageTotals;
}

function RoundSection({
  roomId,
  round,
  isCurrent,
  defaultOpen,
  participantsById,
  agentsById,
  tick,
  usageTotals,
}: RoundSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded border border-edge bg-surface"
      data-testid={`round-section-${round.roundNumber}`}
    >
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-2 px-4 py-3">
        <span className="text-sm font-semibold text-fg">第 {round.roundNumber} 轮</span>
        <StatusPill tone={roundPhaseTone(round.phase)} text={roundPhaseLabel(round.phase)} />
        {isCurrent ? <span className="text-xs text-muted">（当前轮）</span> : null}
        {/* 挂在 summary 行：折叠态也可见（放 Body 里折叠就看不见了）。 */}
        {usageTotals ? <UsageBadge totals={usageTotals} /> : null}
      </summary>
      {open ? (
        <RoundSectionBody
          roomId={roomId}
          round={round}
          isCurrent={isCurrent}
          participantsById={participantsById}
          agentsById={agentsById}
          tick={tick}
        />
      ) : null}
    </details>
  );
}

function RoundSectionBody({
  round,
  isCurrent,
  participantsById,
  agentsById,
  tick,
}: Omit<RoundSectionProps, "defaultOpen">) {
  const { data: messages } = useRoundMessages(round.id, tick);
  const { data: summary } = useRoundSummary(round.id, tick);
  const { data: executions } = useRoundExecutions(round.id, tick);

  const activeExecutionId = isCurrent ? round.activeExecutionId : null;
  const previewText = useRuntimeDiscussionStore((state) =>
    activeExecutionId ? state.previewByExecution[activeExecutionId] : undefined,
  );

  const failed = (executions ?? [])
    .filter(isFailedExecution)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const activeExecution = activeExecutionId
    ? (executions ?? []).find((execution) => execution.executionId === activeExecutionId)
    : undefined;

  return (
    <div className="flex flex-col gap-2 border-t border-edge px-4 py-3">
      {(messages ?? []).map((message) => {
        const speaker =
          message.role === "user"
            ? USER_SPEAKER
            : resolveSpeaker(message.participantId, participantsById, agentsById);
        return (
          <MessageBubble
            key={message.id}
            name={speaker.name}
            color={speaker.color}
            content={message.content}
            timestamp={message.createdAt}
          />
        );
      })}
      <SummaryBlock content={summary?.content ?? null} />
      {failed.map((execution) => (
        <ExecutionFailureRecord
          key={execution.executionId}
          execution={execution}
          participantsById={participantsById}
          agentsById={agentsById}
        />
      ))}
      {activeExecutionId ? (
        <ActivePreview
          previewText={previewText ?? ""}
          isSummary={activeExecution?.resultKind === "summary"}
          speaker={resolveSpeaker(activeExecution?.participantId, participantsById, agentsById)}
        />
      ) : null}
    </div>
  );
}

/** Streaming preview pinned at the current Round's tail (U6): disposable
 * display state only — on commit the store clears it and the committed
 * Message appears in its place; on discard it vanishes and a collapsed
 * failure record is left behind. */
function ActivePreview({
  previewText,
  isSummary,
  speaker,
}: {
  previewText: string;
  isSummary: boolean;
  speaker: { name: string; color: string };
}) {
  const badge = isSummary ? "总结生成中·尚未保存" : "生成中·尚未保存";
  return (
    <div data-testid="active-preview" aria-label={badge}>
      {previewText.length > 0 ? (
        <MessageBubble
          name={speaker.name}
          color={speaker.color}
          content={previewText}
          badge={badge}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2 py-2 text-sm text-muted">
          <span aria-hidden="true">⟳</span>
          <span>{speaker.name} 正在生成…</span>
          <span className="rounded border border-info bg-info/10 px-2 py-0.5 text-xs text-info">
            {badge}
          </span>
        </div>
      )}
    </div>
  );
}
