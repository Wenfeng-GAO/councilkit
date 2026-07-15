import { MessageBubble } from "@/components/message/MessageBubble";
import { ErrorBanner } from "@/components/room/ErrorBanner";
import { EmptyState } from "@/components/shared/EmptyState";
import { buildRenderSequence } from "@/lib/round-errors";
import type { Agent, Message } from "@/models";
import { useDiscussionStore } from "@/stores/discussion";

interface DiscussionStreamProps {
  messages: Message[];
  agents: Agent[];
}

export function DiscussionStream({ messages, agents }: DiscussionStreamProps) {
  const { drafting, agentErrors, agentErrorGateway, roundErrorSummary, clearRoundErrorSummary } =
    useDiscussionStore();

  const draftEntries = Object.entries(drafting).filter(([, text]) => text.length > 0);

  const isEmpty = messages.length === 0 && draftEntries.length === 0 && !roundErrorSummary;

  // TC-5: 单一渲染序列 —— agent 发言(message) 与 出错(error-only) 按 agent 执行顺序
  // 交错编排，避免「先全渲染成功、再全渲染失败」造成的时序反转（前序失败跑到后序成功后）。
  const renderItems = buildRenderSequence(messages, agents, agentErrors);

  return (
    <div className="mx-auto max-w-3xl px-6 py-4">
      <ErrorBanner summary={roundErrorSummary} onDismiss={clearRoundErrorSummary} />
      {isEmpty ? <EmptyState title="还没有讨论" hint="发起讨论后，agent 会依次发言。" /> : null}
      {renderItems.map((item) => {
        if (item.kind === "errorOnly") {
          return (
            <MessageBubble
              key={item.key}
              agent={agents.find((a) => a.id === item.agentId)}
              error={agentErrors[item.agentId]}
              gateway={agentErrorGateway[item.agentId]}
              errorPropagated={!!agentErrors[item.agentId]?.message?.includes("网关已离线")}
            />
          );
        }
        const m = item.message as Message;
        return (
          <MessageBubble
            key={item.key}
            message={m}
            agent={agents.find((a) => a.id === m.senderId)}
            error={m.senderType === "agent" ? agentErrors[m.senderId] : undefined}
            gateway={m.senderType === "agent" ? agentErrorGateway[m.senderId] : undefined}
            errorPropagated={
              m.senderType === "agent" && !!agentErrors[m.senderId]?.message?.includes("网关已离线")
            }
          />
        );
      })}
      {draftEntries.map(([agentId, text]) => {
        const agent = agents.find((a) => a.id === agentId);
        return (
          <MessageBubble
            key={`draft-${agentId}`}
            message={{
              id: `draft-${agentId}`,
              senderId: agentId,
              senderType: "agent",
              content: text,
              roundId: "draft",
              timestamp: Date.now(),
            }}
            agent={agent}
          />
        );
      })}
    </div>
  );
}
