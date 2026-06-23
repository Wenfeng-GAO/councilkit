import { buildContext } from "@/lib/context";
import { addMessage, addRoom, getMessagesByRound, getRoom } from "@/lib/db";
import { db } from "@/lib/db";
import { generateSummary } from "@/lib/summary";
import { type Agent, type Room, createMessage, createRound, createSummary } from "@/models";
import { dispatchStream } from "@/services/dispatch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDiscussionStore } from "./discussion";

export const roomKeys = {
  list: ["rooms"] as const,
  detail: (id: string) => ["room", id] as const,
  messages: (roundId: string) => ["messages", roundId] as const,
};

export function useRoom(roomId: string | undefined) {
  return useQuery({
    queryKey: roomId ? roomKeys.detail(roomId) : ["room", "none"],
    enabled: !!roomId,
    queryFn: () => getRoom(roomId as string),
  });
}

export function useRoundMessages(roundId: string | undefined) {
  return useQuery({
    queryKey: roundId ? roomKeys.messages(roundId) : ["messages", "none"],
    enabled: !!roundId,
    queryFn: () => getMessagesByRound(roundId as string),
  });
}

export function useCreateRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (room: Room) => {
      await addRoom(room);
      return room;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: roomKeys.list }),
  });
}

/**
 * R4 核心: agents 依次发言并互相看见。
 * 每个 agent 的上下文含话题 + 该轮此前所有发言（含其他 agent 的），
 * 故后发言者可质疑/补充先发言者。
 */
export async function runRound(params: {
  room: Room;
  agents: Agent[];
  getPriorSummary: () => string | null;
  setSummary: (roundId: string, content: string) => Promise<void>;
}): Promise<void> {
  const { room, agents, getPriorSummary, setSummary } = params;
  const store = useDiscussionStore.getState();
  store.reset();
  store.setRunning(true);

  const round = createRound({ roundNumber: room.roundIds.length + 1, roomId: room.id });
  await db.rounds.add(round);

  const allMessages: ReturnType<typeof createMessage>[] = [];

  try {
    for (const agent of agents) {
      store.setAgentStatus(agent.id, "typing");
      const ctx = buildContext(allMessages, getPriorSummary(), room.topic);
      const systemContent = `${ctx.system}\n\n你的角色立场: ${agent.role}。请从该立场参与讨论，可质疑或补充其他发言者。`;
      let local = "";
      try {
        await dispatchStream(
          agent.model,
          {
            model: agent.model,
            stream: true,
            messages: [{ role: "system", content: systemContent }, ...ctx.messages],
          },
          (delta) => {
            local += delta;
            store.appendDelta(agent.id, delta);
          },
        );
      } catch (err) {
        store.setError(err instanceof Error ? err.message : "agent error");
        store.setAgentStatus(agent.id, "offline");
        continue;
      }
      if (local.trim().length === 0) {
        store.setAgentStatus(agent.id, "offline");
        continue;
      }
      const msg = createMessage({
        senderId: agent.id,
        senderType: "agent",
        content: local,
        roundId: round.id,
      });
      allMessages.push(msg);
      await addMessage(msg);
      store.flushDraft(agent.id, msg);
      store.setAgentStatus(agent.id, "online");
    }

    // R5: 独立总结
    const summaryText = await generateSummary({
      model: agents[0]?.model ?? "claude",
      topic: room.topic,
      messages: allMessages,
      priorSummary: getPriorSummary(),
    });
    const summary = createSummary({
      roundId: round.id,
      content: summaryText,
      model: agents[0]?.model ?? "claude",
    });
    await db.summaries.add(summary);
    await setSummary(round.id, summaryText);
  } finally {
    store.setRunning(false);
  }
}
