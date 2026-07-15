import { MessageBubble } from "@/components/message/MessageBubble";
import { ErrorBanner } from "@/components/room/ErrorBanner";
import { EmptyState } from "@/components/shared/EmptyState";
import { enumerateErrorOnlyAgents } from "@/lib/round-errors";
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

  // 已被渲染为发言 bubble 的 agent（有 message）；其余出错 agent 需补 error-only bubble (TC-5)
  const renderedSenderIds = new Set(
    messages.filter((m) => m.senderType === "agent").map((m) => m.senderId),
  );
  const errorOnlyAgentIds = enumerateErrorOnlyAgents(agentErrors, renderedSenderIds);

  return (
    <div className="mx-auto max-w-3xl px-6 py-4">
      <ErrorBanner summary={roundErrorSummary} onDismiss={clearRoundErrorSummary} />
      {isEmpty ? <EmptyState title="还没有讨论" hint="发起讨论后，agent 会依次发言。" /> : null}
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          agent={agents.find((a) => a.id === m.senderId)}
          error={m.senderType === "agent" ? agentErrors[m.senderId] : undefined}
          gateway={m.senderType === "agent" ? agentErrorGateway[m.senderId] : undefined}
          errorPropagated={
            m.senderType === "agent" && !!agentErrors[m.senderId]?.message?.includes("网关已离线")
          }
        />
      ))}
      {errorOnlyAgentIds.map((agentId) => (
        <MessageBubble
          key={`error-${agentId}`}
          agent={agents.find((a) => a.id === agentId)}
          error={agentErrors[agentId]}
          gateway={agentErrorGateway[agentId]}
          errorPropagated={!!agentErrors[agentId]?.message?.includes("网关已离线")}
        />
      ))}
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
