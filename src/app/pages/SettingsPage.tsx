import { DeleteGatewayModal } from "@/components/gateway/DeleteGatewayModal";
import { GatewayCard } from "@/components/gateway/GatewayCard";
import { GatewayFormModal, type GatewayFormValues } from "@/components/gateway/GatewayFormModal";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { db } from "@/lib/db";
import { testGatewayConnection } from "@/lib/gateway-test";
import {
  type Gateway,
  type TestStatus,
  useCreateGateway,
  useDeleteGateway,
  useGateways,
  useUpdateGateway,
} from "@/stores/gateways";
import type { GatewayErrorKind } from "@/types";
import { useEffect, useState } from "react";

interface StatusState {
  status: TestStatus;
  failedKind?: GatewayErrorKind;
}

export function SettingsPage() {
  const { data: gateways = [] } = useGateways();
  const createMut = useCreateGateway();
  const updateMut = useUpdateGateway();
  const deleteMut = useDeleteGateway();

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<Gateway | undefined>(undefined);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Gateway | null>(null);
  const [deleteAgentCount, setDeleteAgentCount] = useState(0);

  const [statuses, setStatuses] = useState<Record<string, StatusState>>({});

  // gateways 重建后默认所有 gateway 状态 idle
  useEffect(() => {
    setStatuses((prev) => {
      const next: Record<string, StatusState> = {};
      for (const g of gateways) {
        next[g.id] = prev[g.id] ?? { status: "idle" };
      }
      return next;
    });
  }, [gateways]);

  const openCreate = () => {
    setFormMode("create");
    setEditing(undefined);
    setFormOpen(true);
  };

  const openEdit = (g: Gateway) => {
    setFormMode("edit");
    setEditing(g);
    setFormOpen(true);
  };

  const openDelete = async (g: Gateway) => {
    const count = await db.agents.where("gatewayId").equals(g.id).count();
    setDeleteAgentCount(count);
    setDeleteTarget(g);
    setDeleteOpen(true);
  };

  const handleSubmit = (vals: GatewayFormValues) => {
    if (formMode === "create") {
      createMut.mutate(
        {
          name: vals.name,
          type: vals.type,
          baseUrl: vals.baseUrl,
          defaultModel: vals.defaultModel,
          apiKey: vals.apiKey ?? "",
        },
        {
          onSuccess: () => setFormOpen(false),
        },
      );
    } else if (editing) {
      updateMut.mutate(
        {
          id: editing.id,
          changes: {
            name: vals.name,
            type: vals.type,
            baseUrl: vals.baseUrl,
            defaultModel: vals.defaultModel,
          },
          apiKey: vals.apiKey,
        },
        {
          onSuccess: () => setFormOpen(false),
        },
      );
    }
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMut.mutate(deleteTarget.id, {
      onSuccess: () => {
        setDeleteOpen(false);
        setDeleteTarget(null);
      },
    });
  };

  const handleTest = async (g: Gateway) => {
    setStatuses((s) => ({ ...s, [g.id]: { status: "testing" } }));
    const res = await testGatewayConnection(g);
    if (res.ok) {
      setStatuses((s) => ({ ...s, [g.id]: { status: "success" } }));
    } else {
      const fatal = res.error.kind === "invalid_key";
      setStatuses((s) => ({
        ...s,
        [g.id]: {
          status: fatal ? "failed-fatal" : "failed-other",
          failedKind: res.error.kind,
        },
      }));
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-xl font-semibold">设置</h1>
      <div className="mt-6 flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold">模型网关</h2>
          <p className="mt-1 text-sm text-muted">
            配置浏览器直连的模型 endpoint。密钥以 AES 加密存储在本机 localStorage，按 gateway
            分别管理。
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={openCreate} className="h-10">
            + 添加网关
          </Button>
        </div>

        {gateways.length === 0 ? (
          <EmptyState
            title="还没有网关"
            hint="添加一个网关以让浏览器直连模型端点。需要名称、类型（Anthropic / OpenAI 兼容）、base URL 与 API 密钥。"
          />
        ) : (
          <div className="flex flex-col gap-2">
            {gateways.map((g) => {
              const st = statuses[g.id] ?? { status: "idle" };
              return (
                <GatewayCard
                  key={g.id}
                  gateway={g}
                  status={st.status}
                  failedKind={st.failedKind}
                  onEdit={() => openEdit(g)}
                  onDelete={() => openDelete(g)}
                  onTest={() => handleTest(g)}
                />
              );
            })}
          </div>
        )}
      </div>

      <GatewayFormModal
        open={formOpen}
        mode={formMode}
        initial={editing}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
      />

      <DeleteGatewayModal
        open={deleteOpen}
        gateway={deleteTarget}
        agentCount={deleteAgentCount}
        onClose={() => {
          setDeleteOpen(false);
          setDeleteTarget(null);
        }}
        onConfirm={handleDelete}
      />
    </div>
  );
}
