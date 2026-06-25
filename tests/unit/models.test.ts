import {
  createAgent,
  createMessage,
  createRoom,
  createRound,
  createSummary,
  createTemplate,
  validateAgent,
  validateMessage,
  validateRoom,
  validateRound,
  validateTemplate,
} from "@/models";
import type { Agent, GatewayError, GatewayErrorKind, Message, Room, Round } from "@/models";
import { describe, expect, it } from "vitest";

function validRoom(over: Partial<Room> = {}): Room {
  return {
    id: "r1",
    topic: "话题",
    createdAt: 0,
    lastActiveAt: 0,
    agentIds: ["a1"],
    roundIds: [],
    status: "idle",
    ...over,
  };
}

function validAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    gatewayId: "g1",
    model: "claude-sonnet-4",
    role: "产品经理",
    color: "#6366f1",
    status: "online",
    ...over,
  };
}

describe("validateRoom", () => {
  it("accepts a valid room", () => {
    expect(validateRoom(validRoom()).ok).toBe(true);
  });
  it("rejects empty topic", () => {
    const r = validateRoom(validRoom({ topic: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("topic");
  });
  it("rejects topic over 200 chars", () => {
    const r = validateRoom(validRoom({ topic: "x".repeat(201) }));
    expect(r.ok).toBe(false);
  });
  it("rejects room with no agents", () => {
    const r = validateRoom(validRoom({ agentIds: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("agentIds");
  });
});

describe("validateAgent", () => {
  it("accepts a valid agent", () => {
    expect(validateAgent(validAgent()).ok).toBe(true);
  });
  it("rejects empty role", () => {
    expect(validateAgent(validAgent({ role: "" })).ok).toBe(false);
  });
  it("rejects role over 100 chars", () => {
    expect(validateAgent(validAgent({ role: "x".repeat(101) })).ok).toBe(false);
  });
  it("rejects non-hex color", () => {
    expect(validateAgent(validAgent({ color: "blue" })).ok).toBe(false);
  });
  it("accepts valid 6-digit hex", () => {
    expect(validateAgent(validAgent({ color: "#AbCdEf" })).ok).toBe(true);
  });
  it("rejects empty gatewayId", () => {
    const r = validateAgent(validAgent({ gatewayId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("gatewayId");
  });
  it("rejects empty model", () => {
    const r = validateAgent(validAgent({ model: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("model");
  });
});

describe("validateMessage", () => {
  function validMessage(over: Partial<Message> = {}): Message {
    return {
      id: "m1",
      senderId: "a1",
      senderType: "agent",
      content: "hi",
      roundId: "ro1",
      timestamp: 0,
      ...over,
    };
  }
  it("accepts a valid agent message", () => {
    expect(validateMessage(validMessage()).ok).toBe(true);
  });
  it("rejects empty content", () => {
    expect(validateMessage(validMessage({ content: "" })).ok).toBe(false);
  });
  it("enforces user senderId === 'user'", () => {
    const r = validateMessage(validMessage({ senderType: "user", senderId: "a1" }));
    expect(r.ok).toBe(false);
  });
  it("accepts user message with senderId 'user'", () => {
    expect(validateMessage(validMessage({ senderType: "user", senderId: "user" })).ok).toBe(true);
  });
});

describe("validateRound", () => {
  function validRound(over: Partial<Round> = {}): Round {
    return {
      id: "ro1",
      roundNumber: 1,
      roomId: "r1",
      messageIds: [],
      status: "active",
      ...over,
    };
  }
  it("accepts a valid round", () => {
    expect(validateRound(validRound()).ok).toBe(true);
  });
  it("rejects roundNumber < 1", () => {
    expect(validateRound(validRound({ roundNumber: 0 })).ok).toBe(false);
  });
  it("rejects empty roomId", () => {
    expect(validateRound(validRound({ roomId: "" })).ok).toBe(false);
  });
});

describe("validateTemplate", () => {
  it("accepts a valid template", () => {
    expect(
      validateTemplate({
        id: "t1",
        name: "技术评审团",
        agentConfigs: [{ gatewayId: "g1", model: "gpt-4o", role: "架构师", color: "#6366f1" }],
        createdAt: 0,
      }).ok,
    ).toBe(true);
  });
  it("rejects empty name", () => {
    expect(
      validateTemplate({
        id: "t1",
        name: "",
        agentConfigs: [{ gatewayId: "g1", model: "gpt-4o", role: "r", color: "#6366f1" }],
        createdAt: 0,
      }).ok,
    ).toBe(false);
  });
  it("rejects empty agentConfigs", () => {
    expect(validateTemplate({ id: "t1", name: "n", agentConfigs: [], createdAt: 0 }).ok).toBe(
      false,
    );
  });
});

describe("createSummary", () => {
  it("stamps gatewayId + model from new signature", () => {
    const s = createSummary({
      roundId: "ro1",
      content: "总结内容",
      gatewayId: "g1",
      model: "claude-sonnet-4",
    });
    expect(s.gatewayId).toBe("g1");
    expect(s.model).toBe("claude-sonnet-4");
    expect(s.id).toBeTruthy();
    expect(s.generatedAt).toBeGreaterThan(0);
  });
});

describe("GatewayError contract", () => {
  it("kind field narrows to the 5 allowed literals", () => {
    const kinds: GatewayErrorKind[] = [
      "invalid_key",
      "rate_limit",
      "upstream",
      "timeout",
      "network",
    ];
    const errors: GatewayError[] = kinds.map((k) => ({
      kind: k,
      message: `err ${k}`,
    }));
    expect(errors).toHaveLength(5);
    // httpStatus is optional and only meaningful for non-timeout/non-network.
    const withStatus: GatewayError = { kind: "invalid_key", message: "no key", httpStatus: 401 };
    expect(withStatus.httpStatus).toBe(401);
    const withoutStatus: GatewayError = { kind: "timeout", message: "10s" };
    expect(withoutStatus.httpStatus).toBeUndefined();
  });
});

describe("factories stamp + validate", () => {
  it("createRoom produces a valid room with id/timestamps", () => {
    const room = createRoom({ topic: "新项目命名", agentIds: ["a1"] });
    expect(room.id).toBeTruthy();
    expect(room.createdAt).toBeGreaterThan(0);
    expect(room.status).toBe("idle");
  });
  it("createRoom throws on invalid input", () => {
    expect(() => createRoom({ topic: "", agentIds: ["a1"] })).toThrow();
  });
  it("createAgent stamps id + default status + gatewayId/model", () => {
    const a = createAgent({
      gatewayId: "g1",
      model: "gpt-4o",
      role: "反对者",
      color: "#f85149",
    });
    expect(a.id).toBeTruthy();
    expect(a.status).toBe("online");
    expect(a.gatewayId).toBe("g1");
    expect(a.model).toBe("gpt-4o");
  });
  it("createMessage throws when user message has wrong senderId", () => {
    expect(() =>
      createMessage({ senderId: "a1", senderType: "user", content: "hi", roundId: "ro1" }),
    ).toThrow();
  });
  it("createRound stamps id + active status", () => {
    const r = createRound({ roundNumber: 2, roomId: "r1" });
    expect(r.id).toBeTruthy();
    expect(r.status).toBe("active");
    expect(r.messageIds).toEqual([]);
  });
  it("createTemplate stamps id + createdAt", () => {
    const t = createTemplate({
      name: "评审团",
      agentConfigs: [{ gatewayId: "g2", model: "deepseek-chat", role: "r", color: "#3fb950" }],
    });
    expect(t.id).toBeTruthy();
    expect(t.createdAt).toBeGreaterThan(0);
  });
});
