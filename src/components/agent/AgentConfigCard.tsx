import type { DiscussionAgent } from "@/models/discussion/entities";

/**
 * Read-only Agent summary card (U6). Shared by Settings (Agents section) and
 * New Room (agent picker): it renders persona/Profile/model facts and an
 * optional edit affordance; deletion and blocking rules live in the caller.
 */
export interface AgentConfigCardProps {
  agent: DiscussionAgent;
  /** Resolved Execution Profile name (undefined = unknown/deleted profile). */
  profileName?: string;
  onEdit?: () => void;
}

export function AgentConfigCard({ agent, profileName, onEdit }: AgentConfigCardProps) {
  const subtitle = `${profileName ?? "未知 Profile"} · ${agent.modelId}`;
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-edge bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs text-white"
          style={{ backgroundColor: agent.color }}
          aria-hidden="true"
        >
          {agent.name.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-fg">{agent.name}</p>
          <p className="break-words text-xs text-muted">{subtitle}</p>
        </div>
      </div>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 text-xs text-muted hover:text-fg"
        >
          编辑
        </button>
      ) : null}
    </div>
  );
}
