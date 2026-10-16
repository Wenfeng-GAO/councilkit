import { DRIVER_IDS } from "@shared/runtime/contracts";
import { GENERATION_TIMEOUTS, generationRule } from "@shared/runtime/generation-timeouts";
import { describe, expect, it } from "vitest";
import { turnGenerationRule } from "../src/run/orchestrator";
import type { ResolvedAgent } from "../src/run/types";

/** B4 #339: `councilkit run` uses the Host's rule per seat; no fixed total. */
describe("councilkit run generation rule", () => {
  it("matches the Host rule for every driver (streaming 2 min, one-shot 10 min)", () => {
    for (const driverId of DRIVER_IDS) {
      const agent = { profile: { driverId } } as unknown as ResolvedAgent;
      expect(turnGenerationRule(agent, GENERATION_TIMEOUTS)).toEqual(
        generationRule(driverId, GENERATION_TIMEOUTS),
      );
    }
    const kimi = { profile: { driverId: "kimi-stream-json" } } as unknown as ResolvedAgent;
    expect(turnGenerationRule(kimi, GENERATION_TIMEOUTS)).toMatchObject({
      mode: "oneshot",
      limitMs: 600_000,
    });
    const claude = { profile: { driverId: "claude-stream-json" } } as unknown as ResolvedAgent;
    expect(turnGenerationRule(claude, GENERATION_TIMEOUTS)).toMatchObject({
      mode: "streaming",
      limitMs: 120_000,
    });
  });

  it("the old fixed 10-minute per-turn total is gone", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/run/orchestrator.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/DEFAULT_TURN_TIMEOUT_MS|turnTimeoutMs|600_000/);
  });
});
