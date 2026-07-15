import type { Gateway, GatewayError, ModelMessage } from "@/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mocks ---------------------------------------------------------------
// Tests run in node env (no DOM/IndexedDB/localStorage). We mock the
// persistence + crypto + adapter layers so we exercise only the store
// action functions + testGatewayConnection orchestration logic.

const dbMocks = {
  addGateway: vi.fn<(g: Gateway) => Promise<string>>().mockResolvedValue("ok"),
  listGateways: vi.fn<() => Promise<Gateway[]>>().mockResolvedValue([]),
  updateGateway: vi.fn().mockResolvedValue(1),
  deleteGateway: vi.fn().mockResolvedValue(undefined),
  agentsWhereModify: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/lib/db", () => ({
  addGateway: (...args: unknown[]) => dbMocks.addGateway(args[0] as Gateway),
  listGateways: () => dbMocks.listGateways(),
  updateGateway: (...args: unknown[]) => dbMocks.updateGateway(...args),
  deleteGateway: (id: string) => dbMocks.deleteGateway(id),
  db: {
    agents: {
      where: () => ({
        equals: () => ({
          modify: (changes: unknown) => dbMocks.agentsWhereModify(changes),
        }),
      }),
    },
  },
}));

const cryptoMocks = {
  saveGatewayApiKey: vi.fn(),
  loadGatewayApiKey: vi.fn<() => string | null>().mockReturnValue(null),
  clearGatewayApiKey: vi.fn(),
};

vi.mock("@/lib/crypto", () => ({
  saveGatewayApiKey: (id: string, plain: string) => cryptoMocks.saveGatewayApiKey(id, plain),
  loadGatewayApiKey: (id: string) => cryptoMocks.loadGatewayApiKey(id),
  clearGatewayApiKey: (id: string) => cryptoMocks.clearGatewayApiKey(id),
}));

const adapterMocks = {
  anthropic: vi.fn<() => AsyncIterable<string | GatewayError>>(),
  openai: vi.fn<() => AsyncIterable<string | GatewayError>>(),
};

vi.mock("@/services/gateway-adapters", () => ({
  anthropicAdapter: (params: unknown) => adapterMocks.anthropic(params),
  openaiCompatibleAdapter: (params: unknown) => adapterMocks.openai(params),
}));

// Hooks: capture react-query mutation config so we can drive it directly.
const invalidateSpy = vi.fn();
const capturedConfigs: Array<{
  mutationFn: (...args: unknown[]) => Promise<unknown>;
  onSuccess?: () => void;
}> = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: undefined })),
  useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
  useMutation: (config: {
    mutationFn: (...args: unknown[]) => Promise<unknown>;
    onSuccess?: () => void;
  }) => {
    capturedConfigs.push(config);
    return {
      mutateAsync: (...args: unknown[]) => config.mutationFn(...args),
    };
  },
}));

// Dynamic import keeps hoisting order clean. Use top-level await.
const { createGatewayAction, updateGatewayAction, deleteGatewayAction, gatewayKeys } = await import(
  "@/stores/gateways"
);
const { testGatewayConnection } = await import("@/lib/gateway-test");

// --- fixtures ------------------------------------------------------------
function gateway(over: Partial<Gateway> = {}): Gateway {
  return {
    id: "g1",
    name: "Claude 主账号",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4",
    createdAt: 0,
    ...over,
  };
}

function makeStream(chunks: Array<string | GatewayError>): AsyncIterable<string | GatewayError> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

// --- tests ---------------------------------------------------------------

describe("gatewayKeys", () => {
  it("exposes list + detail key factories", () => {
    expect(gatewayKeys.list).toEqual(["gateways"]);
    expect(gatewayKeys.detail("g1")).toEqual(["gateway", "g1"]);
  });
});

describe("createGatewayAction", () => {
  beforeEach(() => {
    dbMocks.addGateway.mockClear();
    cryptoMocks.saveGatewayApiKey.mockClear();
  });

  it("creates gateway via createGateway + addGateway + saveGatewayApiKey", async () => {
    const out = await createGatewayAction({
      name: "Claude",
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-4",
      apiKey: "sk-test",
    });
    expect(out.name).toBe("Claude");
    expect(dbMocks.addGateway).toHaveBeenCalledTimes(1);
    expect(cryptoMocks.saveGatewayApiKey).toHaveBeenCalledWith(out.id, "sk-test");
  });
});

describe("updateGatewayAction", () => {
  beforeEach(() => {
    dbMocks.updateGateway.mockClear();
    cryptoMocks.saveGatewayApiKey.mockClear();
  });

  it("updates gateway without touching key when apiKey omitted", async () => {
    await updateGatewayAction({ id: "g1", changes: { name: "renamed" } });
    expect(dbMocks.updateGateway).toHaveBeenCalledWith("g1", { name: "renamed" });
    expect(cryptoMocks.saveGatewayApiKey).not.toHaveBeenCalled();
  });

  it("saves new key when apiKey provided non-empty", async () => {
    await updateGatewayAction({ id: "g1", changes: { name: "x" }, apiKey: "sk-new" });
    expect(cryptoMocks.saveGatewayApiKey).toHaveBeenCalledWith("g1", "sk-new");
  });

  it("does not save key when apiKey is empty string", async () => {
    await updateGatewayAction({ id: "g1", changes: {}, apiKey: "" });
    expect(cryptoMocks.saveGatewayApiKey).not.toHaveBeenCalled();
  });
});

describe("deleteGatewayAction", () => {
  beforeEach(() => {
    dbMocks.deleteGateway.mockClear();
    dbMocks.agentsWhereModify.mockClear();
    cryptoMocks.clearGatewayApiKey.mockClear();
  });

  it("clears agent.gatewayId of all referencing agents, deletes gateway, clears key", async () => {
    await deleteGatewayAction("g1");
    expect(dbMocks.agentsWhereModify).toHaveBeenCalledWith({ gatewayId: "" });
    expect(dbMocks.deleteGateway).toHaveBeenCalledWith("g1");
    expect(cryptoMocks.clearGatewayApiKey).toHaveBeenCalledWith("g1");
  });
});

describe("useCreateGateway / useUpdateGateway / useDeleteGateway hooks (wiring)", () => {
  it("registers three mutation configs that invalidate the gateways list on success", async () => {
    const { useCreateGateway, useUpdateGateway, useDeleteGateway } = await import(
      "@/stores/gateways"
    );
    useCreateGateway();
    useUpdateGateway();
    useDeleteGateway();

    expect(invalidateSpy).not.toHaveBeenCalled();
    // Each config's onSuccess must invalidate the gateways list key at least once.
    // useDeleteGateway additionally invalidates rooms + agents — captured here too.
    for (const cfg of capturedConfigs) {
      cfg.onSuccess?.();
    }
    const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
    const gatewaysCalls = calls.filter((s) => s.includes('"gateways"')).length;
    expect(gatewaysCalls).toBeGreaterThanOrEqual(capturedConfigs.length);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: gatewayKeys.list });
  });
});

describe("testGatewayConnection", () => {
  beforeEach(() => {
    cryptoMocks.loadGatewayApiKey.mockReset();
    cryptoMocks.loadGatewayApiKey.mockReturnValue(null);
    adapterMocks.anthropic.mockReset();
    adapterMocks.openai.mockReset();
  });

  it("returns invalid_key without calling adapter when apiKey missing", async () => {
    cryptoMocks.loadGatewayApiKey.mockReturnValue(null);
    const res = await testGatewayConnection(gateway());
    expect(res).toEqual({ ok: false, error: { kind: "invalid_key", message: "未配置 API 密钥" } });
    expect(adapterMocks.anthropic).not.toHaveBeenCalled();
  });

  it("returns ok:true when adapter yields a string chunk", async () => {
    cryptoMocks.loadGatewayApiKey.mockReturnValue("sk-test");
    adapterMocks.anthropic.mockReturnValue(makeStream(["hello", "world"]));
    const res = await testGatewayConnection(gateway());
    expect(res).toEqual({ ok: true });
  });

  it("returns ok:false with GatewayError when adapter yields error chunk", async () => {
    cryptoMocks.loadGatewayApiKey.mockReturnValue("sk-test");
    const err: GatewayError = { kind: "invalid_key", message: "HTTP 401", httpStatus: 401 };
    adapterMocks.anthropic.mockReturnValue(makeStream([err]));
    const res = await testGatewayConnection(gateway());
    expect(res).toEqual({ ok: false, error: err });
  });

  it("selects openaiCompatibleAdapter for type=openai-compatible", async () => {
    cryptoMocks.loadGatewayApiKey.mockReturnValue("sk-test");
    adapterMocks.openai.mockReturnValue(makeStream(["x"]));
    const res = await testGatewayConnection(gateway({ type: "openai-compatible" }));
    expect(res).toEqual({ ok: true });
    expect(adapterMocks.anthropic).not.toHaveBeenCalled();
    expect(adapterMocks.openai).toHaveBeenCalledTimes(1);
    expect(adapterMocks.openai.mock.calls[0][0]).toMatchObject({
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      model: "claude-sonnet-4",
    });
  });

  it("passes minimal ping message + maxTokens=1 to adapter", async () => {
    cryptoMocks.loadGatewayApiKey.mockReturnValue("sk-test");
    adapterMocks.anthropic.mockReturnValue(makeStream(["x"]));
    await testGatewayConnection(gateway());
    const params = adapterMocks.anthropic.mock.calls[0][0] as {
      messages: ModelMessage[];
      maxTokens?: number;
    };
    expect(params.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(params.maxTokens).toBe(1);
  });
});
