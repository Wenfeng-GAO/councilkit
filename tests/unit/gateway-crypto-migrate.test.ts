import { describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { createGateway, validateGateway, type Gateway } from "@/models";

describe("createGateway", () => {
  const validInput = {
    name: "Claude 主账号",
    type: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4",
  };

  it("creates a gateway with id and createdAt, validateGateway passes", () => {
    const g = createGateway(validInput);
    expect(g.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof g.createdAt).toBe("number");
    expect(g.name).toBe("Claude 主账号");
    expect(g.type).toBe("anthropic");
    expect(g.baseUrl).toBe("https://api.anthropic.com");
    expect(g.defaultModel).toBe("claude-sonnet-4");
    expect(validateGateway(g).ok).toBe(true);
  });

  it("throws when name is empty", () => {
    expect(() =>
      createGateway({ ...validInput, name: "" }),
    ).toThrow();
  });

  it("throws when type is not in the allowed set", () => {
    expect(() =>
      createGateway({ ...validInput, type: "gemini" as never }),
    ).toThrow();
  });

  it("throws when baseUrl is empty", () => {
    expect(() =>
      createGateway({ ...validInput, baseUrl: "" }),
    ).toThrow();
  });

  it("throws when baseUrl is not http(s)://", () => {
    expect(() =>
      createGateway({ ...validInput, baseUrl: "ftp://api.anthropic.com" }),
    ).toThrow();
  });

  it("throws when defaultModel is empty", () => {
    expect(() =>
      createGateway({ ...validInput, defaultModel: "" }),
    ).toThrow();
  });

  it("throws when name exceeds 50 chars", () => {
    expect(() =>
      createGateway({ ...validInput, name: "x".repeat(51) }),
    ).toThrow();
  });

  it("accepts openai-compatible type", () => {
    const g = createGateway({ ...validInput, type: "openai-compatible" });
    expect(g.type).toBe("openai-compatible");
    expect(validateGateway(g).ok).toBe(true);
  });
});

describe("validateGateway", () => {
  const base: Gateway = {
    id: "g1",
    name: "OpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    createdAt: 0,
  };

  it("returns ok:false for empty name", () => {
    const r = validateGateway({ ...base, name: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it("returns ok:false for bad type", () => {
    const r = validateGateway({ ...base, type: "gemini" as never });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false for non-http baseUrl", () => {
    const r = validateGateway({ ...base, baseUrl: "ws://x" });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false for empty defaultModel", () => {
    const r = validateGateway({ ...base, defaultModel: "" });
    expect(r.ok).toBe(false);
  });
});

describe("CouncilKitDB v2 schema", () => {
  it("exposes a gateways table", () => {
    expect(db.gateways).toBeTruthy();
    expect(db.gateways.name).toBe("gateways");
  });

  it("gateways table has id and type indexes", () => {
    const schema = db.gateways.schema;
    expect(schema.primKey.keyPath).toBe("id");
    const indexNames = schema.indexes.map((i) => i.keyPath);
    expect(indexNames).toContain("type");
  });
});
