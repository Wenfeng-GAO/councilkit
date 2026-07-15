import type { GatewayError, GatewayErrorKind } from "@/types";

/**
 * @file Round error helpers (D-09 / D-11 / D-12).
 *
 * `GatewayError` 由 P02 contract 层透传至 runRound；本模块负责把 per-agent 错误
 * 归类为本轮顶层摘要 (`RoundErrorSummary`) 与 inline bubble 文案，并提供
 * fatal 判定（D-11: invalid_key 视为致命，触发同 gateway 扩散）。
 *
 * 安全说明 (T-04-01): `formatInlineBody` 不直接注入 `GatewayError.message`
 * 原文，仅插入用户自配的 gateway name / baseUrl（本地数据）。上游返回的原始
 * message 仅保留在 console 用于调试。
 */

/**
 * 单 agent 在本轮内遭遇的错误（含其 gateway 元数据，供 UI 渲染）。
 */
export interface AgentRoundError {
  agentId: string;
  error: GatewayError;
  gatewayId?: string;
  gatewayName?: string;
}

/**
 * 致命网关条目（去重 + 计数）。
 */
export interface FatalGatewayEntry {
  gatewayId: string;
  gatewayName: string;
  agentCount: number;
}

/**
 * 一轮错误汇总，驱动顶部 ErrorBanner 渲染与 runRound 控制流。
 */
export interface RoundErrorSummary {
  fatalGateways: FatalGatewayEntry[];
  recoverableCount: number;
  recoverableKinds: GatewayErrorKind[];
  allOfflineNoSummary: boolean;
  summaryFailed?: { message: string };
}

/**
 * D-11 致命判定：invalid_key 视为致命（密钥被拒绝往往持续到本机配置更新）。
 * 其余 4 类（rate_limit / upstream / timeout / network）视为可恢复，
 * 仅当前 agent 离线，其余 agent 继续。
 */
export function isFatal(error: GatewayError): boolean {
  return error.kind === "invalid_key";
}

/**
 * 把本轮 per-agent 错误列表归类为摘要。空列表返回 null（不展示空 banner）。
 */
export function classifyRoundErrors(
  agentErrors: AgentRoundError[],
  allOffline: boolean,
): RoundErrorSummary | null {
  if (agentErrors.length === 0) return null;

  const fatalMap = new Map<string, FatalGatewayEntry>();
  const recoverableKinds: GatewayErrorKind[] = [];
  let recoverableCount = 0;

  for (const entry of agentErrors) {
    if (isFatal(entry.error)) {
      const gid = entry.gatewayId ?? "unknown";
      const gname = entry.gatewayName ?? "未知网关";
      const existing = fatalMap.get(gid);
      if (existing) {
        existing.agentCount += 1;
      } else {
        fatalMap.set(gid, { gatewayId: gid, gatewayName: gname, agentCount: 1 });
      }
    } else {
      recoverableCount += 1;
      if (!recoverableKinds.includes(entry.error.kind)) {
        recoverableKinds.push(entry.error.kind);
      }
    }
  }

  return {
    fatalGateways: [...fatalMap.values()],
    recoverableCount,
    recoverableKinds,
    allOfflineNoSummary: allOffline,
  };
}

export function formatInlineHeader(error: GatewayError): string {
  switch (error.kind) {
    case "invalid_key":
      return "⚠ 密钥无效，已离线";
    case "rate_limit":
      return "⚠ 限流，已暂停";
    case "upstream":
      return "⚠ 上游故障";
    case "timeout":
      return "⚠ 请求超时";
    case "network":
      return "⚠ 网络错误";
  }
}

export interface InlineGatewayInfo {
  /** gateway 名称（用户自配）。 */
  name?: string;
  /** baseUrl（用户自配；仅用于 network 文案）。 */
  baseUrl?: string;
}

export function formatInlineBody(error: GatewayError, gateway?: InlineGatewayInfo): string {
  const name = gateway?.name ?? "未知网关";
  switch (error.kind) {
    case "invalid_key":
      return `网关 ${name} 的 API 密钥被拒绝。请在「设置」更新密钥。`;
    case "rate_limit":
      return `网关 ${name} 触发速率限制 (429)，本轮跳过该 agent。`;
    case "upstream":
      return `网关 ${name} 返回 5xx，本轮跳过该 agent。可稍后重试。`;
    case "timeout":
      return `网关 ${name} 在 10s 内未响应，本轮跳过该 agent。`;
    case "network":
      return `无法连接到 ${gateway?.baseUrl ?? name}。请检查网络或 base URL。`;
  }
}

/**
 * D-11 propagation 文案 helper —— 同 gateway 致命时，后续 agent 在 bubble
 * 内联展示「网关已离线」而非重复请求上游。
 *
 * 返回 `{ header, body(gatewayName) }`：header 固定，body 是函数以调用方
 * 注入 gatewayName（runRound 已经从 cached gateway 取到名）。
 */
export function formatGatewayOfflineInline(): {
  header: string;
  body: (gatewayName: string) => string;
} {
  return {
    header: "⚠ 网关已离线",
    body: (gatewayName) => `网关 ${gatewayName} 已被标记离线，本轮跳过该 agent。`,
  };
}

/**
 * 一轮里「出错且无发言消息」的 agent —— runRound 对出错 agent 不创建 message
 * (D-10/D-12)，故这些 agent 没有 MessageBubble 可挂 inline error。UI 层需为它们
 * 单独渲染 error-only bubble（TC-5）。本函数纯逻辑计算该列表，供 DiscussionStream
 * 消费并单测覆盖（不引入组件渲染测试依赖）。
 *
 * @param agentErrors runRound 记录的 agentId -> GatewayError
 * @param renderedSenderIds 已被渲染为 MessageBubble 的 senderId 集合（即有 message 的 agent）
 */
export function enumerateErrorOnlyAgents(
  agentErrors: Record<string, GatewayError>,
  renderedSenderIds: ReadonlySet<string>,
): string[] {
  return Object.keys(agentErrors).filter((id) => !renderedSenderIds.has(id));
}

/**
 * TC-5 渲染序列项 —— message（成功发言）或 errorOnly（出错无发言）或非 agent（user 等）。
 * DiscussionStream 不能「先全渲染 message 再全渲染 error」，否则「前序 agent 失败、后序
 * 成功」会时序反转（失败跑到成功后面）。本函数把本轮渲染项按 agent 执行顺序统一编排，
 * 非 agent 消息（user 追问等）按原顺序保留在前。纯逻辑 + 单测覆盖。
 */
export type RenderItem =
  | { kind: "message"; key: string; agentOrder: number; message: unknown }
  | { kind: "errorOnly"; key: string; agentOrder: number; agentId: string }
  | { kind: "other"; key: string; order: number; message: unknown };

interface MessageLike {
  id: string;
  senderId: string;
  senderType: string;
}

/**
 * @param messages 本轮消息列表（含 agent 发言 + user 消息等）
 * @param agents agent 列表（顺序 = runRound 执行顺序）
 * @param agentErrors runRound 记录的 agentId -> GatewayError
 * @returns 按 agent 执行顺序排列的 RenderItem[]，非 agent 消息保序在前
 */
export function buildRenderSequence(
  messages: MessageLike[],
  agents: { id: string }[],
  agentErrors: Record<string, GatewayError>,
): RenderItem[] {
  const agentOrder = new Map<string, number>();
  agents.forEach((a, i) => agentOrder.set(a.id, i));

  const items: RenderItem[] = [];
  // 非 agent 消息（user 等）保序排在前
  let otherOrder = 0;
  for (const m of messages) {
    if (m.senderType === "agent") continue;
    items.push({ kind: "other", key: m.id, order: otherOrder++, message: m });
  }

  // 本轮 agent：有 message 取其 agentOrder 为排序键；无 message 但出错 → errorOnly
  const errOnlyAgentIds = enumerateErrorOnlyAgents(
    agentErrors,
    new Set(messages.filter((m) => m.senderType === "agent").map((m) => m.senderId)),
  );

  type AgentItem = Extract<RenderItem, { agentOrder: number }>;
  const agentItems: AgentItem[] = [];
  for (const m of messages) {
    if (m.senderType !== "agent") continue;
    agentItems.push({
      kind: "message",
      key: m.id,
      agentOrder: agentOrder.get(m.senderId) ?? Number.MAX_SAFE_INTEGER,
      message: m,
    });
  }
  for (const agentId of errOnlyAgentIds) {
    agentItems.push({
      kind: "errorOnly",
      key: `error-${agentId}`,
      agentOrder: agentOrder.get(agentId) ?? Number.MAX_SAFE_INTEGER,
      agentId,
    });
  }
  agentItems.sort((a, b) => a.agentOrder - b.agentOrder);

  return [...items, ...agentItems];
}
