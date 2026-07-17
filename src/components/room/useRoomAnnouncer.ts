import { pauseReasonCopy } from "@/components/room/pause-reasons";
import { resolveSpeaker, roundPhaseLabel } from "@/components/room/round-timeline";
import type {
  DiscussionAgent,
  DiscussionMessage,
  DiscussionRound,
  Participant,
} from "@/models/discussion/entities";
import { useEffect, useRef, useState } from "react";

interface AnnouncementSignature {
  roundId: string | null;
  phase: string | null;
  lastMessageId: string | null;
  failedCount: number;
}

/**
 * aria-live announcer (U6 a11y gate): speaks ONLY semantic transitions —
 * Round phase changes, a Participant's committed speech, and terminal
 * failures/discards — never streaming deltas. Refetches with identical
 * content are filtered by the signature comparison; the announcement clears
 * itself after a few seconds so a later identical transition announces again.
 */
export function useRoomAnnouncer(input: {
  currentRound: DiscussionRound | null;
  /** Committed messages of the current Round (chronological). */
  messages: DiscussionMessage[] | undefined;
  /** Discarded/failed/interrupted execution count of the current Round. */
  failedCount: number;
  participants: Participant[];
  agents: DiscussionAgent[];
}): string {
  const { currentRound, messages, failedCount, participants, agents } = input;
  const [announcement, setAnnouncement] = useState("");
  const prevRef = useRef<AnnouncementSignature>({
    roundId: null,
    phase: null,
    lastMessageId: null,
    failedCount: 0,
  });

  const roundId = currentRound?.id ?? null;
  const phase = currentRound?.phase ?? null;
  const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : undefined;
  const lastMessageId = lastMessage?.id ?? null;

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { roundId, phase, lastMessageId, failedCount };
    if (!currentRound || !phase) {
      setAnnouncement("");
      return;
    }

    if (prev.roundId !== roundId || prev.phase !== phase) {
      // Phase transitions take priority (they subsume message/failure noise).
      if (phase === "paused" && currentRound.pauseReason) {
        setAnnouncement(
          `第 ${currentRound.roundNumber} 轮已暂停：${pauseReasonCopy(currentRound.pauseReason.code).title}`,
        );
      } else {
        setAnnouncement(`第 ${currentRound.roundNumber} 轮${roundPhaseLabel(currentRound.phase)}`);
      }
      return;
    }
    if (failedCount > prev.failedCount) {
      setAnnouncement(`第 ${currentRound.roundNumber} 轮出现一次失败或被丢弃的执行`);
      return;
    }
    if (lastMessageId && lastMessageId !== prev.lastMessageId && lastMessage) {
      const participantsById = new Map(participants.map((p) => [p.id, p]));
      const agentsById = new Map(agents.map((a) => [a.id, a]));
      const name =
        lastMessage.role === "user"
          ? "你"
          : resolveSpeaker(lastMessage.participantId, participantsById, agentsById).name;
      setAnnouncement(`${name} 已发言`);
    }
  }, [currentRound, roundId, phase, lastMessage, lastMessageId, failedCount, participants, agents]);

  // Clear so the next identical transition announces again.
  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(""), 4000);
    return () => clearTimeout(timer);
  }, [announcement]);

  return announcement;
}
