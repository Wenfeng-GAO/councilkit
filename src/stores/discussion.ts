import type { InlineGatewayInfo, RoundErrorSummary } from "@/lib/round-errors";
import type { Message } from "@/models";
import type { AgentStatus, GatewayError } from "@/types";
import { create } from "zustand";

interface DiscussionState {
  /** 当前轮次的发言流（按到达顺序）。 */
  stream: Message[];
  /** agentId -> 流式中的临时拼接文本。 */
  drafting: Record<string, string>;
  /** agentId -> 状态（typing/offline 等）。 */
  agentStatus: Record<string, AgentStatus>;
  /** 当前是否在跑讨论。 */
  running: boolean;
  /** 最近一次错误（如某 agent 超时离线）—— 保留向后兼容，新代码用 agentErrors。 */
  lastError: string | null;
  /** P04: agentId -> 本轮遭遇的 GatewayError（致命或可恢复）。 */
  agentErrors: Record<string, GatewayError>;
  /** P04: agentId -> 该错误所属 gateway 的 name/baseUrl（用于 inline body 文案）。 */
  agentErrorGateway: Record<string, InlineGatewayInfo | undefined>;
  /** P04: 本轮错误汇总 —— 驱动顶部 ErrorBanner 渲染。 */
  roundErrorSummary: RoundErrorSummary | null;

  reset: () => void;
  appendMessage: (m: Message) => void;
  appendDelta: (agentId: string, delta: string) => void;
  flushDraft: (agentId: string, finalMessage: Message) => void;
  setAgentStatus: (agentId: string, status: AgentStatus) => void;
  setRunning: (running: boolean) => void;
  setError: (err: string | null) => void;
  setAgentError: (agentId: string, error: GatewayError, gateway?: InlineGatewayInfo) => void;
  setRoundErrorSummary: (summary: RoundErrorSummary | null) => void;
  clearRoundErrors: () => void;
  clearRoundErrorSummary: () => void;
}

export const useDiscussionStore = create<DiscussionState>((set) => ({
  stream: [],
  drafting: {},
  agentStatus: {},
  running: false,
  lastError: null,
  agentErrors: {},
  agentErrorGateway: {},
  roundErrorSummary: null,

  reset: () =>
    set({
      stream: [],
      drafting: {},
      agentStatus: {},
      running: false,
      lastError: null,
      agentErrors: {},
      agentErrorGateway: {},
      roundErrorSummary: null,
    }),
  appendMessage: (m) => set((s) => ({ stream: [...s.stream, m] })),
  appendDelta: (agentId, delta) =>
    set((s) => ({ drafting: { ...s.drafting, [agentId]: (s.drafting[agentId] ?? "") + delta } })),
  flushDraft: (agentId, finalMessage) =>
    set((s) => {
      const drafting = { ...s.drafting };
      delete drafting[agentId];
      return { drafting, stream: [...s.stream, finalMessage] };
    }),
  setAgentStatus: (agentId, status) =>
    set((s) => ({ agentStatus: { ...s.agentStatus, [agentId]: status } })),
  setRunning: (running) => set({ running }),
  setError: (lastError) => set({ lastError }),
  setAgentError: (agentId, error, gateway) =>
    set((s) => ({
      agentErrors: { ...s.agentErrors, [agentId]: error },
      agentErrorGateway: { ...s.agentErrorGateway, [agentId]: gateway },
    })),
  setRoundErrorSummary: (roundErrorSummary) => set({ roundErrorSummary }),
  clearRoundErrors: () => set({ agentErrors: {}, agentErrorGateway: {} }),
  clearRoundErrorSummary: () => set({ roundErrorSummary: null }),
}));
