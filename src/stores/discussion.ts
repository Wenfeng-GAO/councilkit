import type { Message } from "@/models";
import type { AgentStatus } from "@/types";
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
  /** 最近一次错误（如某 agent 超时离线）。 */
  lastError: string | null;

  reset: () => void;
  appendMessage: (m: Message) => void;
  appendDelta: (agentId: string, delta: string) => void;
  flushDraft: (agentId: string, finalMessage: Message) => void;
  setAgentStatus: (agentId: string, status: AgentStatus) => void;
  setRunning: (running: boolean) => void;
  setError: (err: string | null) => void;
}

export const useDiscussionStore = create<DiscussionState>((set) => ({
  stream: [],
  drafting: {},
  agentStatus: {},
  running: false,
  lastError: null,

  reset: () => set({ stream: [], drafting: {}, agentStatus: {}, running: false, lastError: null }),
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
}));
