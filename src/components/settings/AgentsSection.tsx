import { AgentConfigCard } from "@/components/agent/AgentConfigCard";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { exportAgents } from "@/lib/agent-io";
import type { DiscussionAgent } from "@/models/discussion/entities";
import { type ExecutionProfileRecord, toDto } from "@/models/execution-profile";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { ProfileReadiness } from "@shared/runtime/schemas";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { AgentFormModal, type AgentFormValues } from "./AgentFormModal";
import { formatCheckedAgo, profileReadinessView } from "./view-model";

/**
 * Settings section 4 — Agents (U6). Agents are created, viewed and edited
 * HERE, not in New Room. Deletion is blocked while any Participant references
 * the agent (discussion records stay intact).
 *
 * S7 资产化：行操作组扩展启停（enabled=false 在新建房间选择器隐藏）、复制、
 * 导出与测试调用；段顶新增「导入」。职责划分（plan-a §5-7）：Dexie 写仍全走
 * SettingsPage props（onCreate/onUpdate/onDelete/onToggleEnabled/onDuplicate/
 * onImport）；section 自接线仅限导出（Blob 下载，ReportView 先例）与测试调用
 * （一次 readiness handshake，refresh:true 绕过 Host 探针缓存——不烧模型生成）。
 * 「待绑定」判定 = dangling executionProfileId（既有 needsProfile 语义，无新字段）。
 */
export interface AgentsSectionProps {
  hostOnline: boolean;
  agents: DiscussionAgent[];
  profiles: ExecutionProfileRecord[];
  onCreate: (values: AgentFormValues) => Promise<string | null>;
  /** S7 fix-2 #3: enteredRevision 是「打开编辑框时」捕获的 revision（乐观锁期望值）。 */
  onUpdate: (
    id: string,
    enteredRevision: number,
    values: AgentFormValues,
  ) => Promise<string | null>;
  /** Returns a blocking explanation, or null when the delete happened. */
  onDelete: (id: string) => Promise<string | null>;
  /** S7: toggle the enabled flag; returns an error message, or null on success. */
  onToggleEnabled: (id: string, enabled: boolean) => Promise<string | null>;
  /** S7: duplicate persona/profile/model (new id, revision=1). */
  onDuplicate: (id: string) => Promise<string | null>;
  /** S7: import a councilkit-agents JSON file; returns the result copy shown inline. */
  onImport: (file: File) => Promise<string>;
}

/** 测试调用结果（行内展示区；局部 state，不进 TanStack——避免与同键 observer
 * 的 queryFn 降级问题，SettingsPage 的 S5 教训）。 */
type AgentTestResult =
  | { ok: true; readiness: ProfileReadiness; cachedAt: string }
  | { ok: false; error: string };

/** 行内测试结果区内容：StatusPill + detail + 固定尾注 + cachedAt 相对时间。 */
function AgentTestResultRow({ result }: { result: AgentTestResult }) {
  if (!result.ok) {
    return (
      <>
        <StatusPill tone="error" text="测试失败" />
        <span className="break-words text-xs text-muted">{result.error}</span>
      </>
    );
  }
  const view = profileReadinessView(result.readiness.state);
  return (
    <>
      <StatusPill tone={view.tone} text={view.label} />
      {result.readiness.detail ? (
        <span className="break-words text-xs text-muted">{result.readiness.detail}</span>
      ) : null}
      <span className="text-xs text-muted">
        仅验证执行环境，未调用模型生成 · 检查于 {formatCheckedAgo(result.cachedAt, Date.now())}
      </span>
    </>
  );
}

export function AgentsSection({
  hostOnline,
  agents,
  profiles,
  onCreate,
  onUpdate,
  onDelete,
  onToggleEnabled,
  onDuplicate,
  onImport,
}: AgentsSectionProps) {
  const { client } = getAppRuntime();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DiscussionAgent | undefined>(undefined);
  const [deleteBlockReason, setDeleteBlockReason] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AgentTestResult>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const profilesById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  );

  const profileNameOf = (profileId: string): string | undefined =>
    profilesById.get(profileId)?.name;

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

  const handleToggle = async (agent: DiscussionAgent) => {
    setActionError(await onToggleEnabled(agent.id, !agent.enabled));
  };

  const handleDuplicate = async (agent: DiscussionAgent) => {
    setActionError(await onDuplicate(agent.id));
  };

  // 导出自接线：secret-free by construction（agent-io 的 toDto 契约），单 Agent
  // 文件按 ReportView/诊断下载的 Blob 先例落盘。
  const handleExport = (agent: DiscussionAgent) => {
    const blob = new Blob([exportAgents([agent], profiles)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `councilkit-agent-${agent.name.replace(/[\\/:*?"<>|]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // 测试调用自接线：一次显式 readiness handshake（refresh:true 强制真握手、
  // 绕过 60s 缓存与失败退避，S5 handleRecheckAll 直调口径）。仅验证执行环境，
  // 不触发任何模型生成。
  const handleTest = async (agent: DiscussionAgent) => {
    const profile = profilesById.get(agent.executionProfileId);
    if (!profile) return;
    setTestingId(agent.id);
    try {
      const data = await client.profileReadiness(toDto(profile), agent.modelId, { refresh: true });
      setTestResults((prev) => ({
        ...prev,
        [agent.id]: { ok: true, readiness: data.readiness, cachedAt: data.cachedAt },
      }));
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [agent.id]: {
          ok: false,
          error: error instanceof Error ? error.message : "测试调用失败。",
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleFileChosen = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 重置 input，允许连续选择同一文件再次导入（每次导入 mint 新 id）。
    event.target.value = "";
    if (!file) return;
    setImportMessage(await onImport(file));
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

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => fileInputRef.current?.click()}>
          导入
        </Button>
        <Button onClick={openCreate} disabled={!hostOnline || profiles.length === 0}>
          + 新建 Agent
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => void handleFileChosen(event)}
        />
      </div>
      {importMessage ? <p className="text-sm text-muted">{importMessage}</p> : null}
      {actionError ? (
        <p role="alert" className="text-sm text-error">
          {actionError}
        </p>
      ) : null}

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
          {agents.map((agent) => {
            const unbound = !profilesById.has(agent.executionProfileId);
            const result = testResults[agent.id];
            return (
              <li key={agent.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {unbound || !agent.enabled ? (
                    <div className="flex shrink-0 flex-col items-start gap-1">
                      {unbound ? <StatusPill tone="warn" text="待绑定" /> : null}
                      {!agent.enabled ? <StatusPill tone="muted" text="已停用" /> : null}
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <AgentConfigCard
                      agent={agent}
                      profileName={profileNameOf(agent.executionProfileId)}
                      onEdit={() => openEdit(agent)}
                    />
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={() => void handleToggle(agent)}
                    >
                      {agent.enabled ? "停用" : "启用"}
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={() => void handleDuplicate(agent)}
                    >
                      复制
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={() => handleExport(agent)}
                    >
                      导出
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      disabled={!hostOnline || unbound || testingId === agent.id}
                      title={unbound ? "待绑定 Profile，无法测试" : undefined}
                      onClick={() => void handleTest(agent)}
                    >
                      {testingId === agent.id ? "测试中…" : "测试"}
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={() => void handleDelete(agent)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
                {result ? (
                  <div className="flex flex-wrap items-center gap-2 rounded border border-edge bg-surface-2 px-3 py-2">
                    <AgentTestResultRow result={result} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <AgentFormModal
        open={formOpen}
        mode={editing ? "edit" : "create"}
        initial={editing}
        profiles={profiles}
        hostOnline={hostOnline}
        onClose={() => setFormOpen(false)}
        // S7 fix-2 #3：editing 持有「打开编辑框时」的行，其 revision 即乐观锁
        // 期望值，随提交链传入（不在提交时重读现值当期望）。
        onSubmit={(values) =>
          editing ? onUpdate(editing.id, editing.revision, values) : onCreate(values)
        }
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
