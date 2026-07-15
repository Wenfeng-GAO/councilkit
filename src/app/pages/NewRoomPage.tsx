import { AgentConfigCard } from "@/components/agent/AgentConfigCard";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextInput";
import { Textarea } from "@/components/ui/Textarea";
import { addAgent, addRoom } from "@/lib/db";
import { type Agent, createAgent, createRoom } from "@/models";
import { useGateways } from "@/stores/gateways";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

const COLORS = ["#6366f1", "#3fb950", "#d29922", "#f85149", "#58a6ff", "#a371f7"];

export function NewRoomPage() {
  const navigate = useNavigate();
  const { data: gateways = [] } = useGateways();
  const [topic, setTopic] = useState("");
  const [background, setBackground] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [draftRole, setDraftRole] = useState("");
  const [draftGatewayId, setDraftGatewayId] = useState("");
  const [draftModel, setDraftModel] = useState("");

  const addAgentConfig = () => {
    if (draftRole.trim().length === 0 || !draftGatewayId) return;
    const agent = createAgent({
      gatewayId: draftGatewayId,
      model:
        (draftModel.trim() || gateways.find((g) => g.id === draftGatewayId)?.defaultModel) ?? "",
      role: draftRole.trim(),
      color: COLORS[agents.length % COLORS.length],
    });
    setAgents((prev) => [...prev, agent]);
    setDraftRole("");
    setDraftGatewayId("");
    setDraftModel("");
    setModalOpen(false);
  };

  const submit = async () => {
    if (topic.trim().length === 0 || agents.length === 0) return;
    const room = createRoom({ topic: topic.trim(), agentIds: agents.map((a) => a.id) });
    room.topic = background.trim() ? `${topic.trim()}\n\n背景: ${background.trim()}` : room.topic;
    await addRoom(room);
    for (const a of agents) {
      a.roomId = room.id;
      await addAgent(a);
    }
    navigate(`/rooms/${room.id}`);
  };

  const openModal = () => {
    setDraftGatewayId(gateways[0]?.id ?? "");
    setDraftModel(gateways[0]?.defaultModel ?? "");
    setDraftRole("");
    setModalOpen(true);
  };

  const onGatewayChange = (id: string) => {
    setDraftGatewayId(id);
    const g = gateways.find((x) => x.id === id);
    if (g) setDraftModel(g.defaultModel);
  };

  const confirmDisabled = draftRole.trim().length === 0 || !draftGatewayId;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-xl font-semibold">新建讨论房间</h1>
      <div className="flex flex-col gap-4">
        <TextInput
          label="话题"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="例: 给新项目起个名字"
        />
        <Textarea
          label="背景（可选）"
          rows={3}
          value={background}
          onChange={(e) => setBackground(e.target.value)}
        />
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-muted">参与 agent（至少 1 个）</span>
            <Button variant="ghost" onClick={openModal}>
              + 添加 agent
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {agents.map((a, i) => (
              <AgentConfigCard
                key={a.id}
                agent={a}
                gatewayName={gateways.find((g) => g.id === a.gatewayId)?.name}
                onRemove={() => setAgents((prev) => prev.filter((_, idx) => idx !== i))}
              />
            ))}
          </div>
        </div>
        <Button onClick={submit} disabled={topic.trim().length === 0 || agents.length === 0}>
          创建并进入
        </Button>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="添加 agent">
        <div className="flex flex-col gap-3">
          <TextInput
            label="角色/立场"
            value={draftRole}
            onChange={(e) => setDraftRole(e.target.value)}
            placeholder="例: 产品经理 / 反对者"
          />
          {gateways.length === 0 ? (
            <div className="rounded border border-warn bg-warn/10 p-4 text-fg">
              <p className="text-sm">尚未配置任何网关。前往「设置」添加一个网关后再创建 agent。</p>
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="mt-2 text-sm text-accent hover:underline"
              >
                前往设置
              </button>
            </div>
          ) : (
            <>
              <Select
                label="网关"
                options={gateways.map((g) => ({ value: g.id, label: g.name }))}
                value={draftGatewayId}
                onChange={(e) => onGatewayChange(e.target.value)}
              />
              <TextInput
                label="模型 ID"
                value={draftModel}
                onChange={(e) => setDraftModel(e.target.value)}
                placeholder="例: claude-sonnet-4"
              />
            </>
          )}
          <Button onClick={addAgentConfig} disabled={confirmDisabled}>
            确认添加
          </Button>
        </div>
      </Modal>
    </div>
  );
}
