import type { Agent, Message } from "@/models";
import ReactMarkdown from "react-markdown";

interface MessageBubbleProps {
  message: Message;
  agent?: Agent;
}

export function MessageBubble({ message, agent }: MessageBubbleProps) {
  const isUser = message.senderType === "user";
  const name = isUser ? "你" : (agent?.role ?? "agent");
  const color = isUser ? "#8b919a" : (agent?.color ?? "#6366f1");

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium text-white"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        >
          {name.slice(0, 1)}
        </span>
        <span className="text-sm font-medium text-fg">{name}</span>
        <span className="text-xs text-muted">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>
      <div className="ml-8 text-sm leading-relaxed text-fg">
        <ReactMarkdown>{message.content}</ReactMarkdown>
      </div>
    </div>
  );
}
