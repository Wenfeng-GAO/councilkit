import { describe, expect, it } from "vitest";
import { ideateModelAgents } from "../src/auto/ideate-models";
import { reviewModelAgents } from "../src/auto/review-models";

const DRIVER = { driverId: "grok-stream-json" as const, options: {} };

/** modelId whose composed seat name `${modelId} · 1` cuts inside 😀 at unit 128. */
function straddlingModelId(): string {
  const emoji = "😀";
  expect(emoji.length).toBe(2);
  // Prefix of 127 units + emoji → raw .slice(0, 128) leaves a lone high surrogate.
  return `${"a".repeat(127)}${emoji}${"x".repeat(20)}`;
}

function assertNoLoneSurrogate(name: string): void {
  expect(name.length).toBeLessThanOrEqual(128);
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = name.charCodeAt(i + 1);
      expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`lone low surrogate at index ${i}`);
    }
  }
  expect(name.includes("\uD83D")).toBe(false);
  expect(name.endsWith("\uD83D")).toBe(false);
}

describe("ideate/review model seat name UTF-16 clip", () => {
  it("ideateModelAgents does not split a surrogate pair at the 128-unit name boundary", () => {
    const modelId = straddlingModelId();
    const composed = `${modelId} · 1`;
    expect(composed.length).toBeGreaterThan(128);
    const rawSlice = composed.slice(0, 128);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);
    expect(rawSlice.length).toBe(128);

    const agents = ideateModelAgents({
      models: [
        { modelId, driverSelection: DRIVER },
        { modelId: "other-model", driverSelection: DRIVER },
      ],
      aggregatorIndex: 0,
    });

    const name = agents[0]!.name;
    assertNoLoneSurrogate(name);
    // Drop the straddling emoji rather than split it; keep the ASCII prefix.
    expect(name).toBe("a".repeat(127));
  });

  it("reviewModelAgents does not split a surrogate pair at the 128-unit name boundary", () => {
    const modelId = straddlingModelId();
    const composed = `${modelId} · 1`;
    const rawSlice = composed.slice(0, 128);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);

    const agents = reviewModelAgents({
      models: [{ modelId, driverSelection: DRIVER }],
      aggregatorIndex: 0,
    });

    const name = agents[0]!.name;
    assertNoLoneSurrogate(name);
    expect(name).toBe("a".repeat(127));
  });

  it("passes through short composed names unchanged", () => {
    const agents = reviewModelAgents({
      models: [{ modelId: "gpt-test", driverSelection: DRIVER }],
      aggregatorIndex: 0,
    });
    expect(agents[0]!.name).toBe("gpt-test · 1");
  });
});
