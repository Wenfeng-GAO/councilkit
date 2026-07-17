import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextInput";
import { Textarea } from "@/components/ui/Textarea";
import { runtimeDb } from "@/lib/runtime-db";
import type { DiscussionAgent, Participant } from "@/models/discussion/entities";
import { createDiscussionRoom } from "@/models/discussion/factories";
import { profileDigestOf } from "@/models/execution-profile";
import { initializeRoomDigest } from "@/orchestrator/context-snapshot";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useAgents, useExecutionProfiles } from "@/stores/runtime-queries";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * New Room (U6): only selects existing Agents, their speaking order and an
 * explicit Facilitator — Agent creation and Profile editing live in Settings.
 * Join snapshots each Agent's Profile digest via `profileDigestOf`.
 */

interface GateProps {
  title: string;
  hint: string;
  ctaLabel: string;
  onCta: () => void;
}

function Gate({ title, hint, ctaLabel, onCta }: GateProps) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-xl font-semibold">新建讨论房间</h1>
      <EmptyState title={title} hint={hint} />
      <div className="flex justify-center">
        <Button onClick={onCta}>{ctaLabel}</Button>
      </div>
    </div>
  );
}

export function NewRoomPage() {
  const navigate = useNavigate();
  const agentsQuery = useAgents();
  const profilesQuery = useExecutionProfiles();
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const profiles = useMemo(() => profilesQuery.data ?? [], [profilesQuery.data]);

  const [topic, setTopic] = useState("");
  const [background, setBackground] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [facilitatorId, setFacilitatorId] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ topic?: string; agents?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const orderedSelected = selectedIds
    .map((id) => agentsById.get(id))
    .filter((agent): agent is DiscussionAgent => !!agent);

  const toggleAgent = (agent: DiscussionAgent) => {
    setErrors((prev) => ({ ...prev, agents: undefined }));
    if (selectedIds.includes(agent.id)) {
      const next = selectedIds.filter((id) => id !== agent.id);
      setSelectedIds(next);
      if (facilitatorId === agent.id) setFacilitatorId(next[0] ?? null);
    } else {
      setSelectedIds([...selectedIds, agent.id]);
      if (facilitatorId === null) setFacilitatorId(agent.id);
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= selectedIds.length) return;
    const next = [...selectedIds];
    [next[index], next[target]] = [next[target], next[index]];
    setSelectedIds(next);
  };

  const submit = async () => {
    const nextErrors: { topic?: string; agents?: string } = {};
    if (topic.trim().length === 0) nextErrors.topic = "请输入话题";
    if (orderedSelected.length < 2) nextErrors.agents = "请至少选择 2 个 Agent";
    setErrors(nextErrors);
    if (nextErrors.topic || nextErrors.agents) return;
    setPending(true);
    setSubmitError(null);
    try {
      const room = initializeRoomDigest(
        createDiscussionRoom({
          topic: topic.trim(),
          background: background.trim(),
          facilitatorParticipantId: "pending",
        }),
      );
      await runtimeDb.rooms.add(room);
      const orchestrator = getAppRuntime().orchestrator;
      const participants: Participant[] = [];
      for (const agent of orderedSelected) {
        const profile = profilesById.get(agent.executionProfileId);
        if (!profile) {
          throw new Error(`Agent「${agent.name}」引用的 Execution Profile 已被删除`);
        }
        participants.push(
          await orchestrator.joinAgent(room.id, agent.id, profileDigestOf(profile)),
        );
      }
      const facilitatorIndex = Math.max(
        0,
        orderedSelected.findIndex((agent) => agent.id === facilitatorId),
      );
      room.facilitatorParticipantId = participants[facilitatorIndex].id;
      await runtimeDb.rooms.put(room);
      navigate(`/rooms/${room.id}`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
      setPending(false);
    }
  };

  if (agentsQuery.isPending || profilesQuery.isPending) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        <EmptyState title="加载中…" />
      </div>
    );
  }

  if (agentsQuery.isError || profilesQuery.isError) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        <EmptyState title="无法读取本地 Runtime 数据" hint="目标数据库打开失败，请刷新页面重试。" />
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <Gate
        title="尚未配置 Execution Profile"
        hint="讨论由 Runtime Host 执行模型，每个 Agent 必须引用一个 Execution Profile。请先在 Runtime 设置中创建 Profile。"
        ctaLabel="前往 Runtime 设置"
        onCta={() => navigate("/settings")}
      />
    );
  }

  if (agents.length === 0) {
    return (
      <Gate
        title="还没有可用的 Agent"
        hint="房间只能选用已有 Agent，不能在创建时临时新建。请在设置的 Agents 段创建至少 2 个 Agent（例如一个 claude-stream-json、一个 codex-app-server）。"
        ctaLabel="前往 Agents 段"
        onCta={() => navigate("/settings#agents")}
      />
    );
  }

  if (agents.length === 1) {
    return (
      <Gate
        title="还需要再创建一个 Agent"
        hint={`讨论至少需要 2 个 Agent；当前只有「${agents[0].name}」。请在设置的 Agents 段再创建一个。`}
        ctaLabel="前往 Agents 段"
        onCta={() => navigate("/settings#agents")}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-xl font-semibold">新建讨论房间</h1>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <TextInput
            label="话题"
            value={topic}
            onChange={(e) => {
              setTopic(e.target.value);
              setErrors((prev) => ({ ...prev, topic: undefined }));
            }}
            placeholder="例: 给新项目起个名字"
          />
          {errors.topic ? (
            <p role="alert" className="text-xs text-error">
              {errors.topic}
            </p>
          ) : null}
        </div>
        <Textarea
          label="背景（可选）"
          rows={3}
          value={background}
          onChange={(e) => setBackground(e.target.value)}
        />
        <div>
          <span className="text-sm text-muted">参与 Agent（至少 2 个）</span>
          <p className="mt-1 text-xs text-muted">
            勾选顺序即初始发言顺序，可在下方调整；Agent 在设置的 Agents 段创建。
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {agents.map((agent) => {
              const profile = profilesById.get(agent.executionProfileId);
              return (
                <label
                  key={agent.id}
                  className={`flex items-center gap-3 rounded border border-edge bg-surface px-3 py-2 text-sm ${
                    profile ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(agent.id)}
                    disabled={!profile}
                    onChange={() => toggleAgent(agent)}
                  />
                  <span
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs text-white"
                    style={{ backgroundColor: agent.color }}
                    aria-hidden="true"
                  >
                    {agent.name.slice(0, 1)}
                  </span>
                  <span className="flex-1">
                    <span className="block font-medium text-fg">{agent.name}</span>
                    <span className="block text-xs text-muted">
                      {profile
                        ? `${profile.name} · ${agent.modelId}`
                        : "引用的 Execution Profile 已被删除，请在设置的 Agents 段重新绑定"}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {errors.agents ? (
            <p role="alert" className="mt-1 text-xs text-error">
              {errors.agents}
            </p>
          ) : null}
        </div>
        <div>
          <span className="text-sm text-muted">发言顺序（自上而下）</span>
          {orderedSelected.length > 0 ? (
            <ol className="mt-2 flex flex-col gap-2">
              {orderedSelected.map((agent, index) => (
                <li
                  key={agent.id}
                  className="flex items-center gap-2 rounded border border-edge bg-surface px-3 py-2"
                >
                  <span className="w-5 text-center text-xs text-muted" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs text-white"
                    style={{ backgroundColor: agent.color }}
                    aria-hidden="true"
                  >
                    {agent.name.slice(0, 1)}
                  </span>
                  <span className="flex-1 text-sm text-fg">{agent.name}</span>
                  <button
                    type="button"
                    aria-label={`上移 ${agent.name}`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    className="rounded border border-edge px-2 py-1 text-xs text-fg hover:bg-surface-2 disabled:opacity-40"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`下移 ${agent.name}`}
                    disabled={index === orderedSelected.length - 1}
                    onClick={() => move(index, 1)}
                    className="rounded border border-edge px-2 py-1 text-xs text-fg hover:bg-surface-2 disabled:opacity-40"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleAgent(agent)}
                    className="text-xs text-muted hover:text-error"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-xs text-muted">尚未选择 Agent。</p>
          )}
        </div>
        {orderedSelected.length > 0 ? (
          <Select
            label="Facilitator（负责生成每轮总结）"
            options={orderedSelected.map((agent) => ({ value: agent.id, label: agent.name }))}
            value={facilitatorId ?? orderedSelected[0].id}
            onChange={(e) => setFacilitatorId(e.target.value)}
          />
        ) : null}
        {submitError ? (
          <p role="alert" className="text-sm text-error">
            创建房间失败: {submitError}
          </p>
        ) : null}
        <Button onClick={submit} disabled={pending}>
          {pending ? "创建中…" : "创建并进入"}
        </Button>
      </div>
    </div>
  );
}
