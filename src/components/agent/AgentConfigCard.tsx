import type { Agent } from "@/models";

interface AgentConfigCardProps {
  agent: Agent;
  onRemove?: () => void;
}

export function AgentConfigCard({ agent, onRemove }: AgentConfigCardProps) {
  return (
    <div className="flex items-center justify-between rounded border border-edge bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs text-white"
          style={{ backgroundColor: agent.color }}
          aria-hidden="true"
        >
          {agent.role.slice(0, 1)}
        </span>
        <div>
          <p className="text-sm font-medium text-fg">{agent.role}</p>
          <p className="text-xs text-muted">{agent.model}</p>
        </div>
      </div>
      {onRemove ? (
        <button type="button" onClick={onRemove} className="text-xs text-muted hover:text-red-400">
          移除
        </button>
      ) : null}
    </div>
  );
}
