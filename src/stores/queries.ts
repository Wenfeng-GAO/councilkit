import { buildContext } from "@/lib/context";
import { addMessage, addRoom, db, getMessagesByRound, getRoom } from "@/lib/db";
import {
  type AgentRoundError,
  type InlineGatewayInfo,
  classifyRoundErrors,
  isFatal,
} from "@/lib/round-errors";
import { generateSummary } from "@/lib/summary";
import {
  type Agent,
  type Gateway,
  type Room,
  createMessage,
  createRound,
  createSummary,
} from "@/models";
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
 *
 * P04 编排:
 *   - D-09 消费 5 类 GatewayError (invalid_key / rate_limit / upstream / timeout / network)
 *   - D-11 致命 (invalid_key) 扩散：同 gatewayId 后续 agent 不发请求，直接标 offline + propagated inline
 *   - D-12 全 agent 离线 → 跳过 generateSummary；部分成功 → 用首个成功 agent 的 gateway/model 出总结
 *   - D-12 generateSummary 自身失败 → catch 兜底，banner 显示 warn 「总结生成失败」
 *   - 10s 超时沿用 R7 locked (stream.ts TIMEOUT_MS 未改)
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
  // reset 已清空 agentErrors/agentErrorGateway/roundErrorSummary，防御性再清。
  store.clearRoundErrors();
  store.clearRoundErrorSummary();
  store.setRunning(true);

  const round = createRound({ roundNumber: room.roundIds.length + 1, roomId: room.id });
  await db.rounds.add(round);

  const allMessages: ReturnType<typeof createMessage>[] = [];
  const collectedErrors: AgentRoundError[] = [];
  const gatewayOffline = new Set<string>();
  const gatewayCache = new Map<string, Gateway | undefined>();

  const lookupGateway = async (gatewayId: string): Promise<Gateway | undefined> => {
    if (!gatewayCache.has(gatewayId)) {
      gatewayCache.set(gatewayId, await db.gateways.get(gatewayId));
    }
    return gatewayCache.get(gatewayId);
  };

  if (agents.length === 0) {
    store.setRunning(false);
    return;
  }

  try {
    for (const agent of agents) {
      // D-11 fatal-spread: 同 gateway 已致命 → 直接 propagated，不发请求
      if (gatewayOffline.has(agent.gatewayId)) {
        const gw = await lookupGateway(agent.gatewayId);
        const gwInfo: InlineGatewayInfo = { name: gw?.name, baseUrl: gw?.baseUrl };
        store.setAgentStatus(agent.id, "offline");
        store.setAgentError(agent.id, { kind: "invalid_key", message: "网关已离线" }, gwInfo);
        collectedErrors.push({
          agentId: agent.id,
          error: { kind: "invalid_key", message: "网关已离线" },
          gatewayId: agent.gatewayId,
          gatewayName: gw?.name,
        });
        continue;
      }

      store.setAgentStatus(agent.id, "typing");
      const ctx = buildContext(allMessages, getPriorSummary(), room.topic);
      const systemContent = `${ctx.system}\n\n你的角色立场: ${agent.role}。请从该立场参与讨论，可质疑或补充其他发言者。`;
      const gw = await lookupGateway(agent.gatewayId);
      const gwInfo: InlineGatewayInfo = { name: gw?.name, baseUrl: gw?.baseUrl };
      let local = "";
      let hadError = false;

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
            // D-09: 按 kind 分类 —— 致命放入 gatewayOffline Set；可恢复仅本 agent。
            store.setAgentError(agent.id, chunk, gwInfo);
            collectedErrors.push({
              agentId: agent.id,
              error: chunk,
              gatewayId: agent.gatewayId,
              gatewayName: gw?.name,
            });
            if (isFatal(chunk)) {
              gatewayOffline.add(agent.gatewayId);
            }
            store.setAgentStatus(agent.id, "offline");
            hadError = true;
            break;
          }
        }
      } catch (err) {
        // 防御性：dispatchStream 正常应通过 GatewayError chunk 透传错误，
        // 但保留 try/catch 兜底意外 throw 路径（按 network 分类）。
        const fallback: GatewayError = {
          kind: "network",
          message: err instanceof Error ? err.message : "agent error",
        };
        store.setAgentError(agent.id, fallback, gwInfo);
        collectedErrors.push({
          agentId: agent.id,
          error: fallback,
          gatewayId: agent.gatewayId,
          gatewayName: gw?.name,
        });
        store.setAgentStatus(agent.id, "offline");
        hadError = true;
      }

      if (hadError) continue;

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

    // D-12: 全 offline 跳过总结；部分成功正常总结。
    const allOffline = allMessages.length === 0;
    const summary_ = classifyRoundErrors(collectedErrors, allOffline);
    if (summary_) store.setRoundErrorSummary(summary_);

    if (!allOffline) {
      // D-12: 用首个成功发言的 agent 的 gateway/model 出总结（而非 agents[0] —— 后者可能本身 offline）。
      const summaryAgent = agents.find((a) => a.id === allMessages[0]?.senderId) ?? agents[0];
      try {
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
      } catch (err) {
        // D-12 容错：summary 失败 → banner 追加 warn 行，不破坏 round 完成态。
        const message = err instanceof Error ? err.message : String(err);
        if (summary_) {
          summary_.summaryFailed = { message };
          store.setRoundErrorSummary(summary_);
        } else {
          store.setRoundErrorSummary({
            fatalGateways: [],
            recoverableCount: 0,
            recoverableKinds: [],
            allOfflineNoSummary: false,
            summaryFailed: { message },
          });
        }
      }
    }
  } finally {
    store.setRunning(false);
  }
}
