import { DiscussionStream } from "@/components/room/DiscussionStream";
import { RoomHeader } from "@/components/room/RoomHeader";
import { SummaryBlock } from "@/components/room/SummaryBlock";
import { UserInputBar } from "@/components/room/UserInputBar";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import {
  addMessage,
  getAgentsByRoom,
  getMessagesByRound,
  getRoom,
  getRoundsByRoom,
  getSummary,
} from "@/lib/db";
import { createMessage } from "@/models";
import { useDiscussionStore } from "@/stores/discussion";
import { runRound } from "@/stores/queries";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";

export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { data: room } = useQuery({
    queryKey: ["room", roomId],
    enabled: !!roomId,
    queryFn: () => getRoom(roomId as string),
  });
  const { data: agents } = useQuery({
    queryKey: ["agents", roomId],
    enabled: !!roomId,
    queryFn: () => getAgentsByRoom(roomId as string),
  });
  const { data: rounds } = useQuery({
    queryKey: ["rounds", roomId],
    enabled: !!roomId,
    queryFn: () => getRoundsByRoom(roomId as string),
  });
  const lastRoundId = rounds?.[rounds.length - 1]?.id;
  const { data: messages } = useQuery({
    queryKey: ["messages", lastRoundId],
    enabled: !!lastRoundId,
    queryFn: () => getMessagesByRound(lastRoundId as string),
  });
  const { data: summary } = useQuery({
    queryKey: ["summary", lastRoundId],
    enabled: !!lastRoundId,
    queryFn: () => getSummary(lastRoundId as string),
  });

  const running = useDiscussionStore((s) => s.running);
  const lastError = useDiscussionStore((s) => s.lastError);
  const [summaryText, setSummaryText] = useState<string | null>(null);

  if (!room) return <EmptyState title="加载中…" />;
  if (!agents || agents.length === 0) return <EmptyState title="房间无 agent" hint="请重新创建" />;

  const startRound = () => {
    if (!room || agents.length === 0) return;
    runRound({
      room,
      agents,
      getPriorSummary: () => summary?.content ?? summaryText ?? null,
      setSummary: async (_roundId, content) => setSummaryText(content),
    });
  };

  const onUserSubmit = async (text: string) => {
    if (!lastRoundId) return;
    const msg = createMessage({
      senderId: "user",
      senderType: "user",
      content: text,
      roundId: lastRoundId,
    });
    await addMessage(msg);
  };

  return (
    <div className="flex flex-col">
      <RoomHeader room={room} />
      <div className="flex justify-end px-6 py-3">
        <Button onClick={startRound} disabled={running || agents.length === 0}>
          {running ? "讨论中…" : room.roundIds.length === 0 ? "发起讨论" : "开始新一轮"}
        </Button>
      </div>
      {lastError ? <p className="px-6 text-xs text-red-400">错误: {lastError}</p> : null}
      <DiscussionStream messages={messages ?? []} agents={agents} />
      <SummaryBlock content={summary?.content ?? summaryText} />
      <UserInputBar disabled={running} onSubmit={onUserSubmit} />
    </div>
  );
}
