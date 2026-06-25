import type { Agent, Gateway, GatewayError, Room } from "@/models";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (hoisted so they apply before queries.ts is imported) ---
const mocks = vi.hoisted(() => ({
  dispatchStream: vi.fn(),
  generateSummary: vi.fn(),
  addMessage: vi.fn(),
  roundsAdd: vi.fn(),
  summariesAdd: vi.fn(),
  gatewaysGet: vi.fn(),
}));

vi.mock("@/services/dispatch", () => ({ dispatchStream: mocks.dispatchStream }));
vi.mock("@/lib/summary", () => ({ generateSummary: mocks.generateSummary }));
vi.mock("@/lib/db", () => ({
  db: {
    rounds: { add: mocks.roundsAdd },
    summaries: { add: mocks.summariesAdd },
    gateways: { get: mocks.gatewaysGet },
  },
  addMessage: mocks.addMessage,
  getMessagesByRound: vi.fn(),
  getRoom: vi.fn(),
  getRoundsByRoom: vi.fn(),
}));

import {
  classifyRoundErrors,
  formatGatewayOfflineInline,
  formatInlineBody,
  formatInlineHeader,
  isFatal,
  type AgentRoundError,
} from "@/lib/round-errors";
import { useDiscussionStore } from "@/stores/discussion";
import { runRound } from "@/stores/queries";

// --- Test helpers ---
function makeAgent(id: string, gatewayId: string): Agent {
  return {
    id,
    gatewayId,
    model: `model-${id}`,
    role: `role-${id}`,
    color: "#6366f1",
    roomId: "room-1",
    status: "online",
  };
}

function makeGateway(id: string, name: string): Gateway {
  return {
    id,
    name,
    type: "anthropic",
    baseUrl: `https://${id}.example.com`,
    defaultModel: "model-x",
    createdAt: 0,
  };
}

function makeRoom(): Room {
  return {
    id: "room-1",
    topic: "讨论话题",
    createdAt: 0,
    lastActiveAt: 0,
    agentIds: [],
    roundIds: [],
    status: "idle",
  };
}

function ge(kind: GatewayError["kind"], message = "err"): GatewayError {
  return { kind, message };
}

function streamFrom(chunks: Array<string | GatewayError>): AsyncIterable<string | GatewayError> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++] as string | GatewayError, done: false };
          return { value: undefined, done: true } as const;
        },
      };
    },
  };
}

function setPlan(plan: Record<string, Array<string | GatewayError>>): void {
  mocks.dispatchStream.mockImplementation((agent: Agent) => streamFrom(plan[agent.id] ?? []));
}

function resetMocks(): void {
  mocks.dispatchStream.mockReset();
  mocks.generateSummary.mockReset();
  mocks.addMessage.mockReset().mockResolvedValue("msg-id");
  mocks.roundsAdd.mockReset().mockResolvedValue("round-id");
  mocks.summariesAdd.mockReset().mockResolvedValue("summary-id");
  mocks.gatewaysGet.mockReset();
}

describe("round-errors helpers", () => {
  describe("isFatal", () => {
    it("invalid_key is fatal", () => {
      expect(isFatal(ge("invalid_key"))).toBe(true);
    });
    it("recoverable kinds are not fatal", () => {
      for (const k of ["rate_limit", "upstream", "timeout", "network"] as const) {
        expect(isFatal(ge(k))).toBe(false);
      }
    });
  });

  describe("classifyRoundErrors", () => {
    it("returns null on empty input", () => {
      expect(classifyRoundErrors([], false)).toBeNull();
    });

    it("collects fatal gateway (deduped + counted) and recoverable kinds", () => {
      const errs: AgentRoundError[] = [
        { agentId: "a1", error: ge("invalid_key"), gatewayId: "g1", gatewayName: "Claude" },
        { agentId: "a2", error: ge("invalid_key"), gatewayId: "g1", gatewayName: "Claude" },
        { agentId: "a3", error: ge("timeout"), gatewayId: "g2", gatewayName: "OpenAI" },
      ];
      const summary = classifyRoundErrors(errs, false);
      expect(summary).not.toBeNull();
      expect(summary?.fatalGateways).toHaveLength(1);
      expect(summary?.fatalGateways[0]).toEqual({
        gatewayId: "g1",
        gatewayName: "Claude",
        agentCount: 2,
      });
      expect(summary?.recoverableKinds).toEqual(["timeout"]);
      expect(summary?.recoverableCount).toBe(1);
      expect(summary?.allOfflineNoSummary).toBe(false);
    });

    it("preserves allOfflineNoSummary flag", () => {
      const summary = classifyRoundErrors(
        [{ agentId: "a1", error: ge("network") }],
        true,
      );
      expect(summary?.allOfflineNoSummary).toBe(true);
    });
  });

  describe("formatInlineHeader / formatInlineBody", () => {
    it("renders 5 distinct headers", () => {
      expect(formatInlineHeader(ge("invalid_key"))).toBe("⚠ 密钥无效，已离线");
      expect(formatInlineHeader(ge("rate_limit"))).toBe("⚠ 限流，已暂停");
      expect(formatInlineHeader(ge("upstream"))).toBe("⚠ 上游故障");
      expect(formatInlineHeader(ge("timeout"))).toBe("⚠ 请求超时");
      expect(formatInlineHeader(ge("network"))).toBe("⚠ 网络错误");
    });

    it("renders body with gateway name", () => {
      expect(formatInlineBody(ge("invalid_key"), { name: "Claude" })).toContain("Claude");
      expect(formatInlineBody(ge("network"), { name: "OpenAI", baseUrl: "https://x" })).toContain(
        "https://x",
      );
    });
  });

  describe("formatGatewayOfflineInline", () => {
    it("renders propagation header + body(gatewayName)", () => {
      const fmt = formatGatewayOfflineInline();
      expect(fmt.header).toBe("⚠ 网关已离线");
      expect(fmt.body("Claude")).toBe("网关 Claude 已被标记离线，本轮跳过该 agent。");
    });
  });
});

describe("runRound error orchestration", () => {
  beforeEach(() => {
    resetMocks();
    useDiscussionStore.getState().reset();
    useDiscussionStore.setState({
      agentErrors: {},
      agentErrorGateway: {},
      roundErrorSummary: null,
      lastError: null,
    });
  });

  it("fatal invalid_key spreads to other agents on same gateway (D-11)", async () => {
    const g1 = makeGateway("g1", "Claude");
    const g2 = makeGateway("g2", "OpenAI");
    mocks.gatewaysGet.mockImplementation((id: string) =>
      Promise.resolve(id === "g1" ? g1 : id === "g2" ? g2 : undefined),
    );
    setPlan({
      a1: [ge("invalid_key", "401")],
      a3: ["hello", " world"],
    });

    const agents = [makeAgent("a1", "g1"), makeAgent("a2", "g1"), makeAgent("a3", "g2")];
    await runRound({
      room: makeRoom(),
      agents,
      getPriorSummary: () => null,
      setSummary: async () => {},
    });

    const state = useDiscussionStore.getState();
    // a1: invalid_key error captured
    expect(state.agentErrors.a1?.kind).toBe("invalid_key");
    expect(state.agentStatus.a1).toBe("offline");
    // a2: NEVER called dispatchStream (propagated)
    expect(state.agentErrors.a2?.kind).toBe("invalid_key");
    expect(state.agentErrors.a2?.message).toMatch(/网关已离线/);
    expect(state.agentStatus.a2).toBe("offline");
    // a3: succeeded, online, dispatched once
    expect(state.agentStatus.a3).toBe("online");
    expect(mocks.dispatchStream).toHaveBeenCalledTimes(2); // a1 + a3 only
    // banner summary should record fatal gateway g1 with 2 affected agents
    expect(state.roundErrorSummary?.fatalGateways[0]?.gatewayId).toBe("g1");
    expect(state.roundErrorSummary?.fatalGateways[0]?.agentCount).toBe(2);
    expect(state.roundErrorSummary?.allOfflineNoSummary).toBe(false);
    // summary should still generate (a3 success)
    expect(mocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("all agents offline → skip generateSummary + allOfflineNoSummary (D-12)", async () => {
    const g1 = makeGateway("g1", "Claude");
    mocks.gatewaysGet.mockResolvedValue(g1);
    setPlan({
      a1: [ge("timeout")],
      a2: [ge("network")],
    });

    await runRound({
      room: makeRoom(),
      agents: [makeAgent("a1", "g1"), makeAgent("a2", "g1")],
      getPriorSummary: () => null,
      setSummary: async () => {},
    });

    const state = useDiscussionStore.getState();
    expect(state.roundErrorSummary?.allOfflineNoSummary).toBe(true);
    expect(mocks.generateSummary).not.toHaveBeenCalled();
    expect(mocks.summariesAdd).not.toHaveBeenCalled();
  });

  it("partial success → generateSummary uses the successful agent (not agents[0]) (D-12)", async () => {
    const g1 = makeGateway("g1", "Claude");
    const g2 = makeGateway("g2", "OpenAI");
    mocks.gatewaysGet.mockImplementation((id: string) =>
      Promise.resolve(id === "g1" ? g1 : g2),
    );
    mocks.generateSummary.mockResolvedValue("summary-text");
    setPlan({
      a1: [ge("rate_limit")],
      a2: ["部分发言内容"],
    });

    await runRound({
      room: makeRoom(),
      agents: [makeAgent("a1", "g1"), makeAgent("a2", "g2")],
      getPriorSummary: () => null,
      setSummary: async () => {},
    });

    expect(mocks.generateSummary).toHaveBeenCalledTimes(1);
    const call = mocks.generateSummary.mock.calls[0][0] as {
      gatewayId: string;
      model: string;
    };
    expect(call.gatewayId).toBe("g2");
    expect(call.model).toBe("model-a2");
  });

  it("generateSummary throw → catch fallback + summaryFailed warn (D-12)", async () => {
    const g1 = makeGateway("g1", "Claude");
    mocks.gatewaysGet.mockResolvedValue(g1);
    mocks.generateSummary.mockRejectedValue(new Error("HTTP 429"));
    setPlan({
      a1: ["成功发言"],
    });

    await runRound({
      room: makeRoom(),
      agents: [makeAgent("a1", "g1")],
      getPriorSummary: () => null,
      setSummary: async () => {},
    });

    const state = useDiscussionStore.getState();
    expect(state.roundErrorSummary?.summaryFailed?.message).toBe("HTTP 429");
    // round not crash
    expect(state.running).toBe(false);
  });
});
