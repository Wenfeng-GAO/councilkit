import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  clearApiKey,
  clearGatewayApiKey,
  loadApiKey,
  loadGatewayApiKey,
  saveApiKey,
  saveGatewayApiKey,
} from "@/lib/crypto";
import { createGateway, validateGateway, type Gateway } from "@/models";

// Node test env has no localStorage — provide a minimal Map-backed shim.
class LocalStorageShim {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? this.store.get(k) as string : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

describe("crypto multi-key (per-gatewayId)", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).localStorage = new LocalStorageShim();
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("saveGatewayApiKey writes non-plaintext cipher to localStorage[gatewayKey]", () => {
    saveGatewayApiKey("g1", "sk-abc");
    const stored = localStorage.getItem("councilkit.gateways.g1.enc");
    expect(stored).toBeTruthy();
    expect(stored).not.toBe("sk-abc");
    // AES output contains cipher meta (U2FsdGVkX1 prefix is crypto-js OpenSSL salted format)
    expect(stored.length).toBeGreaterThan(10);
  });

  it("loadGatewayApiKey returns plaintext", () => {
    saveGatewayApiKey("g1", "sk-abc");
    expect(loadGatewayApiKey("g1")).toBe("sk-abc");
  });

  it("loadGatewayApiKey returns null when not stored", () => {
    expect(loadGatewayApiKey("nope")).toBeNull();
  });

  it("loadGatewayApiKey returns null for corrupt cipher (no throw)", () => {
    localStorage.setItem("councilkit.gateways.g1.enc", "not-a-valid-cipher");
    expect(loadGatewayApiKey("g1")).toBeNull();
  });

  it("clearGatewayApiKey removes the key", () => {
    saveGatewayApiKey("g1", "sk-abc");
    clearGatewayApiKey("g1");
    expect(loadGatewayApiKey("g1")).toBeNull();
  });

  it("different gatewayIds do not interfere", () => {
    saveGatewayApiKey("g1", "sk-one");
    saveGatewayApiKey("g2", "sk-two");
    expect(loadGatewayApiKey("g1")).toBe("sk-one");
    expect(loadGatewayApiKey("g2")).toBe("sk-two");
    clearGatewayApiKey("g1");
    expect(loadGatewayApiKey("g1")).toBeNull();
    expect(loadGatewayApiKey("g2")).toBe("sk-two");
  });

  it("legacy saveApiKey/loadApiKey still work on councilkit.key.enc", () => {
    saveApiKey("legacy-key");
    expect(localStorage.getItem("councilkit.key.enc")).toBeTruthy();
    expect(localStorage.getItem("councilkit.key.enc")).not.toBe("legacy-key");
    expect(loadApiKey()).toBe("legacy-key");
    clearApiKey();
    expect(loadApiKey()).toBeNull();
  });
});

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
