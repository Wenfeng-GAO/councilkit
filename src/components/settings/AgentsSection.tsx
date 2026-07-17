import { AgentConfigCard } from "@/components/agent/AgentConfigCard";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { DiscussionAgent } from "@/models/discussion/entities";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import { useState } from "react";
import { AgentFormModal, type AgentFormValues } from "./AgentFormModal";

/**
 * Settings section 4 — Agents (U6). Agents are created, viewed and edited
 * HERE, not in New Room. Deletion is blocked while any Participant references
 * the agent (discussion records stay intact).
 */
export interface AgentsSectionProps {
  hostOnline: boolean;
  agents: DiscussionAgent[];
  profiles: ExecutionProfileRecord[];
  onCreate: (values: AgentFormValues) => Promise<string | null>;
  onUpdate: (id: string, values: AgentFormValues) => Promise<string | null>;
  /** Returns a blocking explanation, or null when the delete happened. */
  onDelete: (id: string) => Promise<string | null>;
}

export function AgentsSection({
  hostOnline,
  agents,
  profiles,
  onCreate,
  onUpdate,
  onDelete,
}: AgentsSectionProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DiscussionAgent | undefined>(undefined);
  const [deleteBlockReason, setDeleteBlockReason] = useState<string | null>(null);

  const profileNameOf = (profileId: string): string | undefined =>
    profiles.find((profile) => profile.id === profileId)?.name;

  const openCreate = () => {
    setEditing(undefined);
    setFormOpen(true);
  };

  const openEdit = (agent: DiscussionAgent) => {
    setEditing(agent);
    setFormOpen(true);
  };

  const handleDelete = async (agent: DiscussionAgent) => {
    const blocked = await onDelete(agent.id);
    if (blocked) setDeleteBlockReason(blocked);
  };

  return (
    <section aria-labelledby="settings-agents" className="flex flex-col gap-3">
      <div>
        <h2 id="settings-agents" className="text-base font-semibold">
          4. Agents
        </h2>
        <p className="mt-1 text-sm text-muted">
          Agent = 人格设定 + Execution Profile + modelId，可跨房间复用；在「新建讨论」中只选择已有
          Agent。
        </p>
      </div>

      <div className="flex justify-end">
        <Button onClick={openCreate} disabled={!hostOnline || profiles.length === 0}>
          + 新建 Agent
        </Button>
      </div>

      {agents.length === 0 ? (
        <EmptyState
          title="还没有 Agent"
          hint={
            profiles.length === 0
              ? "先在「3. Execution Profiles」段创建 Profile，然后回到这里创建 Agent。"
              : "创建一个 Agent：人格设定 + Execution Profile + modelId（来自 Driver 闭集目录）。"
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <AgentConfigCard
                  agent={agent}
                  profileName={profileNameOf(agent.executionProfileId)}
                  onEdit={() => openEdit(agent)}
                />
              </div>
              <Button variant="ghost" className="shrink-0" onClick={() => void handleDelete(agent)}>
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AgentFormModal
        open={formOpen}
        mode={editing ? "edit" : "create"}
        initial={editing}
        profiles={profiles}
        hostOnline={hostOnline}
        onClose={() => setFormOpen(false)}
        onSubmit={(values) => (editing ? onUpdate(editing.id, values) : onCreate(values))}
      />

      <Modal
        open={deleteBlockReason !== null}
        onClose={() => setDeleteBlockReason(null)}
        title="无法删除 Agent"
      >
        <p className="text-sm text-fg">{deleteBlockReason}</p>
      </Modal>
    </section>
  );
}
