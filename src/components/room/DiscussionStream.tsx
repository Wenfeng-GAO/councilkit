import { MessageBubble } from "@/components/message/MessageBubble";
import { EmptyState } from "@/components/shared/EmptyState";
import type { Agent, Message } from "@/models";
import { useDiscussionStore } from "@/stores/discussion";

interface DiscussionStreamProps {
  messages: Message[];
  agents: Agent[];
}

export function DiscussionStream({ messages, agents }: DiscussionStreamProps) {
  const { drafting, agentStatus } = useDiscussionStore();

  const draftEntries = Object.entries(drafting).filter(([, text]) => text.length > 0);

  if (messages.length === 0 && draftEntries.length === 0) {
    return <EmptyState title="还没有讨论" hint="发起讨论后，agent 会依次发言。" />;
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-4">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} agent={agents.find((a) => a.id === m.senderId)} />
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
      {Object.values(agentStatus).some((s) => s === "offline") ? (
        <p className="mt-2 text-xs text-red-400">部分 agent 离线，已跳过。</p>
      ) : null}
    </div>
  );
}
