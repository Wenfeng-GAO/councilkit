import { modelConfigKey, reviewModelsSchema } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
const model = {
  modelId: "gpt-6-astra",
  driverSelection: { driverId: "codex-app-server", options: {} },
};
describe("per-run review models", () => {
  it("identifies a seat by driver id, options, then model id", () => {
    const reversed = {
      modelId: model.modelId,
      driverSelection: { options: {}, driverId: "codex-app-server" },
    };
    const key = JSON.stringify(["codex-app-server", {}, "gpt-6-astra"]);
    expect(modelConfigKey(model)).toBe(key);
    expect(modelConfigKey(reversed)).toBe(key);
  });
  it("allows models not yet in the discovery catalog for CLI probing", () => {
    expect(
      reviewModelsSchema.parse({ models: [model], aggregatorIndex: 0 }).models[0]?.modelId,
    ).toBe("gpt-6-astra");
  });
  it.each([
    { models: [], aggregatorIndex: 0 },
    { models: [model], aggregatorIndex: -1 },
    { models: [model], aggregatorIndex: 1 },
    { models: [model, model], aggregatorIndex: 0 },
    {
      models: Array.from({ length: 9 }, (_, i) => ({ ...model, modelId: `model-${i}` })),
      aggregatorIndex: 0,
    },
    { models: [{ ...model, modelId: "--config" }], aggregatorIndex: 0 },
    {
      models: [
        {
          ...model,
          driverSelection: { driverId: "codex-app-server", options: { env: { TOKEN: "x" } } },
        },
      ],
      aggregatorIndex: 0,
    },
  ])("rejects invalid or unsafe roster %j", (config) => {
    expect(reviewModelsSchema.safeParse(config).success).toBe(false);
  });
});
