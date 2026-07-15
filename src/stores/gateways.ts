import { clearGatewayApiKey, saveGatewayApiKey } from "@/lib/crypto";
import { addGateway, db, deleteGateway, listGateways, updateGateway } from "@/lib/db";
import { type TestConnectionResult, testGatewayConnection } from "@/lib/gateway-test";
import { type Gateway, type GatewayType, createGateway } from "@/models";
import type { GatewayError } from "@/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type { Gateway };

export const gatewayKeys = {
  list: ["gateways"] as const,
  detail: (id: string) => ["gateway", id] as const,
};

export type { TestConnectionResult };

export type TestStatus = "idle" | "testing" | "success" | "failed-fatal" | "failed-other";

export type TestConnectionError = GatewayError;

// --- action 函数（hooks 内复用，单测直接驱动） ---------------------------

export interface CreateGatewayActionInput {
  name: string;
  type: GatewayType;
  baseUrl: string;
  defaultModel: string;
  apiKey: string;
}

/** 创建 gateway 元数据 + 落库 + 加密保存 apiKey（D-07 localStorage）。 */
export async function createGatewayAction(input: CreateGatewayActionInput): Promise<Gateway> {
  const g = createGateway({
    name: input.name,
    type: input.type,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
  });
  await addGateway(g);
  saveGatewayApiKey(g.id, input.apiKey);
  return g;
}

export interface UpdateGatewayActionInput {
  id: string;
  changes: Partial<Omit<Gateway, "id" | "createdAt">>;
  /** 编辑态：未填则保留既有 cipher（不动 localStorage）。空串不可。 */
  apiKey?: string;
}

export async function updateGatewayAction(input: UpdateGatewayActionInput): Promise<void> {
  await updateGateway(input.id, input.changes);
  if (input.apiKey !== undefined && input.apiKey.length > 0) {
    saveGatewayApiKey(input.id, input.apiKey);
  }
}

/**
 * 删除 gateway：先清空所有引用该 gateway 的 agent.gatewayId 为空串
 * （匹配 UI-SPEC DeleteGatewayModal 文案「gatewayId 将被清空」；T-03-03 mitigate），
 * 再删 gateway 元数据 + 清 localStorage cipher。
 */
export async function deleteGatewayAction(id: string): Promise<void> {
  await db.agents.where("gatewayId").equals(id).modify({ gatewayId: "" });
  await deleteGateway(id);
  clearGatewayApiKey(id);
}

/** 测试连接 helper 透传（仅在 store 模块统一导出，便于组件直接 import）。 */
export { testGatewayConnection };

// --- hooks（TanStack Query） --------------------------------------------

export function useGateways() {
  return useQuery({
    queryKey: gatewayKeys.list,
    queryFn: () => listGateways(),
  });
}

export function useCreateGateway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createGatewayAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: gatewayKeys.list });
    },
  });
}

export function useUpdateGateway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateGatewayAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: gatewayKeys.list });
    },
  });
}

export function useDeleteGateway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteGatewayAction,
    onSuccess: () => {
      // 清空 agent.gatewayId 影响 room/agent 视图，invalidate 兜底全 agent + gateways
      qc.invalidateQueries({ queryKey: gatewayKeys.list });
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["rooms"] });
    },
  });
}
