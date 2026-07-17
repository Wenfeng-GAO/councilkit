import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import type { ProfileSectionItem } from "@/runtime/readiness";
import type { InstallationDto } from "@shared/runtime/schemas";
import { useState } from "react";
import { ProfileFormModal, type ProfileFormValues } from "./ProfileFormModal";
import { driverDisplayName, profileReadinessView } from "./view-model";

/**
 * Settings section 3 — Execution Profiles (U6). CRUD over the runtime Dexie
 * table plus a per-profile dynamic readiness row (same Driver handshake as
 * execution) with the Readiness table's single repair action.
 */
export interface ProfilesSectionProps {
  hostOnline: boolean;
  profiles: ExecutionProfileRecord[];
  /** Readiness rows keyed by profile id (from buildSettingsReadiness). */
  items: ProfileSectionItem[];
  installations: InstallationDto[];
  onCreate: (values: ProfileFormValues) => Promise<string | null>;
  onUpdate: (id: string, values: ProfileFormValues) => Promise<string | null>;
  /** Returns a blocking explanation, or null when the delete happened. */
  onDelete: (id: string) => Promise<string | null>;
}

export function ProfilesSection({
  hostOnline,
  profiles,
  items,
  installations,
  onCreate,
  onUpdate,
  onDelete,
}: ProfilesSectionProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ExecutionProfileRecord | undefined>(undefined);
  const [deleteBlockReason, setDeleteBlockReason] = useState<string | null>(null);
  const [chooseModelHint, setChooseModelHint] = useState(false);

  const readinessOf = (profileId: string): ProfileSectionItem | undefined =>
    items.find((item) => item.profileId === profileId);

  const openCreate = () => {
    setEditing(undefined);
    setFormOpen(true);
  };

  const openEdit = (profile: ExecutionProfileRecord) => {
    setEditing(profile);
    setFormOpen(true);
  };

  const handleDelete = async (profile: ExecutionProfileRecord) => {
    const blocked = await onDelete(profile.id);
    if (blocked) setDeleteBlockReason(blocked);
  };

  return (
    <section aria-labelledby="settings-profiles" className="flex flex-col gap-3">
      <div>
        <h2 id="settings-profiles" className="text-base font-semibold">
          3. Execution Profiles
        </h2>
        <p className="mt-1 text-sm text-muted">
          Profile 是无秘密的执行配置：绑定一个内置 Driver 与一个可信 Installation，只含 Driver
          声明的类型化选项；模型由 Agent 的 modelId 指定。
        </p>
      </div>

      <div className="flex justify-end">
        <Button onClick={openCreate} disabled={!hostOnline}>
          + 新建 Profile
        </Button>
      </div>

      {profiles.length === 0 ? (
        <EmptyState
          title="还没有 Execution Profile"
          hint="新建一个 Profile 以引用本机可信 Installation；之后 Agent 才能绑定它发言。"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {profiles.map((profile) => {
            const readiness = readinessOf(profile.id);
            const view = readiness ? profileReadinessView(readiness.status) : null;
            return (
              <li
                key={profile.id}
                className="flex flex-col gap-1 rounded border border-edge bg-surface px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{profile.name}</span>
                  <span className="text-xs text-muted">{driverDisplayName(profile.driverId)}</span>
                  {view ? <StatusPill tone={view.tone} text={view.label} /> : null}
                </div>
                <p className="break-all text-xs text-muted">
                  Installation：{profile.installationId} · 修订 v{profile.revision}
                </p>
                {!hostOnline ? (
                  <p className="text-xs text-muted">本地执行服务不可用，无法探测 readiness。</p>
                ) : readiness?.detail ? (
                  <p className="break-words text-xs text-muted">{readiness.detail}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {readiness?.action === "edit-binding" ? (
                    <Button variant="ghost" onClick={() => openEdit(profile)}>
                      编辑绑定
                    </Button>
                  ) : null}
                  {readiness?.action === "choose-model" ? (
                    <Button variant="ghost" onClick={() => setChooseModelHint(true)}>
                      选择可用模型
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => openEdit(profile)}>
                    编辑
                  </Button>
                  <Button variant="ghost" onClick={() => void handleDelete(profile)}>
                    删除
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ProfileFormModal
        open={formOpen}
        mode={editing ? "edit" : "create"}
        initial={editing}
        installations={installations}
        onClose={() => setFormOpen(false)}
        onSubmit={(values) => (editing ? onUpdate(editing.id, values) : onCreate(values))}
      />

      <Modal
        open={deleteBlockReason !== null}
        onClose={() => setDeleteBlockReason(null)}
        title="无法删除 Profile"
      >
        <p className="text-sm text-fg">{deleteBlockReason}</p>
      </Modal>

      <Modal open={chooseModelHint} onClose={() => setChooseModelHint(false)} title="选择可用模型">
        <p className="text-sm text-fg">
          该 Profile 探测到的模型目录已变化。请在下方「4. Agents」段检查引用此 Profile 的 Agent，把
          modelId 改为当前目录中的 canonical ID。
        </p>
      </Modal>
    </section>
  );
}
