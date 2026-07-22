import { AgentConfigCard } from "@/components/agent/AgentConfigCard";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { exportAgents } from "@/lib/agent-io";
import {
  type AgentRealCallErrorCategory,
  type AgentRealCallResult,
  runAgentRealCallTest,
} from "@/lib/agent-real-call";
import type { DiscussionAgent } from "@/models/discussion/entities";
import { type ExecutionProfileRecord, toDto } from "@/models/execution-profile";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { ProfileReadiness } from "@shared/runtime/schemas";
import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useMemo,
  useRef,
  useState,
} from "react";
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

/** 真实调用结果记录（行内展示区；局部 state，不进 TanStack）。
 *
 * G4: 每条记录绑定一个单调递增的 callToken（每 agent 独立计数，发起调用时分配），
 * 而非 agent.revision。Agent 编辑后 revision 会 +1，旧方案用 revision 守卫会把
 * 编辑后新发起的调用结果（startedRevision 与现有记录 revision 不同）误判为过期
 * 结果而拒绝写入，导致界面无可见结果。改为按 callToken 判断：只有当一个更晚的
 * 请求（更大 token）已落记录时，才拒绝更早完成者的覆盖；编辑后再调用分配更大的
 * token，可直接覆盖旧 revision 记录展示。展示层仍按 agent.revision 隐藏编辑前的
 * 旧结果（编辑后 revision +1，旧记录的 revision 自动失效隐藏，无需落库）。 */
export interface AgentRealCallRecord {
  revision: number;
  callToken: number;
  result: AgentRealCallResult;
}

/**
 * G4: pure commit predicate for a real-call result. Returns true when a
 * completer carrying `token` is still the latest dispatch for this agent (no
 * existing record, or the existing record's callToken is not strictly greater
 * than this one). Editing an agent bumps its revision but does NOT allocate a
 * call token, so a fresh post-edit dispatch always commits and overwrites the
 * stale record — the bug where a completed post-edit result was silently
 * dropped because `existing.revision !== startedRevision` no longer occurs.
 *
 * An earlier completer (token < existing.callToken) is suppressed so it cannot
 * overwrite a later dispatch's slot out of completion order.
 */
export function shouldCommitRealCallResult(
  existing: AgentRealCallRecord | undefined,
  token: number,
): boolean {
  if (!existing) return true;
  return token >= existing.callToken;
}

/** 真实调用结果区内容：pill + canonical/effective/modelVerdict/toolState +
 * 首帧/总耗时 + usage + 输出预览 + 失败分类提示。 */
function AgentRealCallResultRow({ result }: { result: AgentRealCallResult }) {
  const pill =
    result.verdict === "completed"
      ? { tone: "success" as const, text: "真实调用成功" }
      : result.verdict === "timeout"
        ? { tone: "warn" as const, text: "真实调用超时" }
        : result.verdict === "cancelled"
          ? { tone: "muted" as const, text: "真实调用已取消" }
          : { tone: "error" as const, text: "真实调用失败" };
  return (
    <>
      <StatusPill tone={pill.tone} text={pill.text} />
      <span className="break-words text-xs text-muted">
        canonical: {result.canonical ?? "未知"} · effective: {result.effective ?? "未知"} ·
        modelVerdict: {result.modelVerdict ?? "未知"} · toolState: {result.toolState ?? "未知"}
      </span>
      <span className="text-xs text-muted">
        首帧 {result.ttftMs ?? "—"} ms · 总耗时 {result.totalMs} ms
      </span>
      <span className="text-xs text-muted">
        usage：
        {result.usage && (result.usage.inputTokens !== null || result.usage.outputTokens !== null)
          ? `input ${result.usage.inputTokens ?? "?"} / output ${result.usage.outputTokens ?? "?"}${result.usage.costUsd !== null && result.usage.costUsd !== undefined ? ` / cost $${result.usage.costUsd}` : ""}`
          : "Driver 未提供"}
      </span>
      {result.outputPreview ? (
        <span className="break-words whitespace-pre-wrap text-xs text-fg">
          {result.outputPreview}
        </span>
      ) : null}
      {result.error ? (
        <span className="break-words text-xs text-error">
          [{result.error.category}] {result.error.code} · {result.error.message} ·{" "}
          {realCallHint(result.error.category)}
        </span>
      ) : null}
    </>
  );
}

/** 错误分类 → 可操作中文提示（plan-a §4 UI 集成）。 */
function realCallHint(category: AgentRealCallErrorCategory): string {
  switch (category) {
    case "auth":
      return "请重新登录对应本地 CLI";
    case "installation":
      return "请重新验证 Installation / Profile";
    case "model_unavailable":
      return "请编辑 Agent 并重新选择目录内模型";
    case "timeout":
      return "请检查 provider / 网络后重试";
    case "quota":
      return "等待当前讨论结束或释放空闲运行时后重试";
    default:
      return "请导出诊断包并重启 Host / CLI";
  }
}

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
  // F3: loading state is a Set per call kind, keyed by agentId. A single-value
  // id let a row B's click wipe row A's in-flight flag and re-enable A, allowing
  // accidental concurrent paid calls. Now finally removes ONLY the current id,
  // and each button is disabled only while its own agentId is running for that
  // kind (readiness and real-call stay independent).
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, AgentTestResult>>({});
  const [realCallIds, setRealCallIds] = useState<Set<string>>(new Set());
  const [realCallResults, setRealCallResults] = useState<Record<string, AgentRealCallRecord>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  // F3: a ref mirrors the real-call in-flight set so the entry guard never reads
  // a stale closure value (a re-render hasn't happened yet when a rapid double
  // click lands). The state Set still drives the disabled-button UI.
  const realCallIdsRef = useRef<Set<string>>(new Set());
  // G4: monotonic per-agent call token. Each dispatched real call gets the next
  // token; the result is committed only if no LATER token (a newer dispatch for
  // this agent) has already committed its result. This replaces the buggy
  // revision-mismatch guard that rejected a fresh result written after an edit
  // bumped agent.revision.
  const realCallTokenRef = useRef<Record<string, number>>({});

  const markRunning = (setter: Dispatch<SetStateAction<Set<string>>>, id: string): void => {
    setter((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };
  const clearRunning = (setter: Dispatch<SetStateAction<Set<string>>>, id: string): void => {
    setter((prev) => (prev.has(id) ? new Set([...prev].filter((value) => value !== id)) : prev));
  };

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
    markRunning(setTestingIds, agent.id);
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
      // F3: remove ONLY this agent's id so a concurrently-running row keeps its
      // loading flag (and disabled button) until its own call settles.
      clearRunning(setTestingIds, agent.id);
    }
  };

  // 真实调用测试自接线：发起一次真实模型 turn（一次付费调用），经
  // agent-real-call helper 驱动 scope→activate→execute→SSE→ack→close；
  // 结果仅存内存 state，绑定 agent.revision，编辑后自动隐藏。不写 Dexie（Q15）。
  // F3: loading 按 agentId 记录（Set），入口对同一 agentId 已在运行时直接
  // 返回，避免重复付费调用。G4: 结果写入按单调 callToken 判断是否最新请求
  // （同 agent 已串行，编辑后新调用分配更大 token，可直接覆盖旧 revision 记录）；
  // 早完成请求仅在更晚请求尚未落记录时才覆盖（防错序）。
  const handleRealCallTest = async (agent: DiscussionAgent) => {
    const profile = profilesById.get(agent.executionProfileId);
    if (!profile) return;
    // Entry guard: a real call for this agentId already in flight → ignore the
    // second click rather than launching a duplicate paid call. The ref is read
    // live so a rapid double-click before re-render cannot slip through.
    if (realCallIdsRef.current.has(agent.id)) return;
    const startedRevision = agent.revision;
    // G4: allocate a monotonic per-agent call token BEFORE dispatch so a later
    // dispatch (e.g. edit-then-recall) always exceeds an in-flight earlier call.
    const token = (realCallTokenRef.current[agent.id] ?? 0) + 1;
    realCallTokenRef.current[agent.id] = token;
    realCallIdsRef.current = new Set(realCallIdsRef.current).add(agent.id);
    markRunning(setRealCallIds, agent.id);
    // G4: commit predicate — only a LATER dispatch (strictly greater token) that
    // has already written its record blocks this completer. Editing bumps
    // agent.revision but does NOT allocate a token, so a fresh post-edit call
    // (its own larger token) always commits and overwrites the stale record.
    const shouldCommit = (prev: Record<string, AgentRealCallRecord>): boolean =>
      shouldCommitRealCallResult(prev[agent.id], token);
    try {
      const result = await runAgentRealCallTest({
        client,
        profile: toDto(profile),
        modelId: agent.modelId,
        persona: agent.personaPrompt,
      });
      setRealCallResults((prev) => {
        if (!shouldCommit(prev)) return prev;
        return { ...prev, [agent.id]: { revision: startedRevision, callToken: token, result } };
      });
    } catch (error) {
      setRealCallResults((prev) => {
        if (!shouldCommit(prev)) return prev;
        return {
          ...prev,
          [agent.id]: {
            revision: startedRevision,
            callToken: token,
            result: {
              verdict: "failed",
              canonical: null,
              effective: null,
              modelVerdict: null,
              toolState: null,
              ttftMs: null,
              totalMs: 0,
              outputPreview: "",
              usage: null,
              error: {
                category: "crash",
                code: "HELPER_ERROR",
                message: error instanceof Error ? error.message : "真实调用失败",
                retryable: false,
              },
            },
          },
        };
      });
    } finally {
      // F3: remove ONLY this agent's id — another row's in-flight real call keeps
      // its loading flag and disabled button until it settles on its own.
      const next = new Set([...realCallIdsRef.current].filter((value) => value !== agent.id));
      realCallIdsRef.current = next;
      clearRunning(setRealCallIds, agent.id);
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
            const realRecord = realCallResults[agent.id];
            // 结果绑定 agent.revision：编辑后 revision +1，旧结果自动隐藏。
            const realCall =
              realRecord && realRecord.revision === agent.revision ? realRecord.result : null;
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
                      disabled={!hostOnline || unbound || testingIds.has(agent.id)}
                      title={unbound ? "待绑定 Profile，无法测试" : undefined}
                      onClick={() => void handleTest(agent)}
                    >
                      {testingIds.has(agent.id) ? "测试中…" : "测试"}
                    </Button>
                    <Button
                      className="px-2 py-1 text-xs"
                      disabled={!hostOnline || unbound || realCallIds.has(agent.id)}
                      title={
                        unbound
                          ? "待绑定 Profile，无法真实调用"
                          : "发起一次真实模型调用（授权一次付费调用）"
                      }
                      onClick={() => void handleRealCallTest(agent)}
                    >
                      {realCallIds.has(agent.id) ? "真实调用中…" : "真实调用测试"}
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
                    <span className="text-xs font-semibold text-muted">环境测试</span>
                    <AgentTestResultRow result={result} />
                  </div>
                ) : null}
                {realCall ? (
                  <div className="flex flex-wrap items-center gap-2 rounded border border-edge bg-surface-2 px-3 py-2">
                    <span className="text-xs font-semibold text-muted">真实调用</span>
                    <AgentRealCallResultRow result={realCall} />
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
