import { buildContext } from "@/lib/context";
import { addMessage, addRoom, getMessagesByRound, getRoom } from "@/lib/db";
import { db } from "@/lib/db";
import { generateSummary } from "@/lib/summary";
import { type Agent, type Room, createMessage, createRound, createSummary } from "@/models";
import { dispatchStream } from "@/services/dispatch";
import type { GatewayError } from "@/types";
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
 *
 * P02: dispatchStream 现在按 agent.gatewayId resolve adapter；遇 GatewayError chunk
 *   即 throw（catch→offline 维持旧行为等价）。P04 再按 kind 分类处理。
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

  if (agents.length === 0) {
    store.setRunning(false);
    return;
  }
  const summaryAgent = agents[0];

  try {
    for (const agent of agents) {
      store.setAgentStatus(agent.id, "typing");
      const ctx = buildContext(allMessages, getPriorSummary(), room.topic);
      const systemContent = `${ctx.system}\n\n你的角色立场: ${agent.role}。请从该立场参与讨论，可质疑或补充其他发言者。`;
      let local = "";
      try {
        for await (const chunk of dispatchStream(agent, {
          model: agent.model,
          stream: true,
          messages: [{ role: "system", content: systemContent }, ...ctx.messages],
        })) {
          if (typeof chunk === "string") {
            local += chunk;
            store.appendDelta(agent.id, chunk);
          } else {
            const err: GatewayError = chunk;
            throw new Error(err.message);
          }
        }
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
      gatewayId: summaryAgent.gatewayId,
      model: summaryAgent.model,
      topic: room.topic,
      messages: allMessages,
      priorSummary: getPriorSummary(),
    });
    const summary = createSummary({
      roundId: round.id,
      content: summaryText,
      gatewayId: summaryAgent.gatewayId,
      model: summaryAgent.model,
    });
    await db.summaries.add(summary);
    await setSummary(round.id, summaryText);
  } finally {
    store.setRunning(false);
  }
}
