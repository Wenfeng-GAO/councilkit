import { describe, expect, it } from "vitest";
import { FINDING, MODULES, OTHER_PR_URL, PR_URL, RUN_ID } from "../../review-explainer/contract";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

const source = {
  prUrl: PR_URL,
  runId: RUN_ID,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  mergeBaseSha: "b".repeat(40),
  findingId: FINDING.busy,
  findingHash: "c".repeat(64),
  diffHash: "d".repeat(64),
  sourceHash: "e".repeat(64),
  driverId: "grok-stream-json",
  modelId: "fixture-model",
  schemaVersion: 1,
  promptVersion: 1,
};
async function api() {
  const mod = await importFeature<Record<string, unknown>>(MODULES.explanationCache);
  return {
    create: requireExport<
      () => {
        getOrGenerate: (key: string, gen: () => Promise<unknown>) => Promise<unknown>;
        size: () => number;
      }
    >(mod, "createExplanationCache", MODULES.explanationCache),
    key: requireExport<(input: Record<string, unknown>) => string>(
      mod,
      "explanationCacheKey",
      MODULES.explanationCache,
    ),
  };
}
describe("A07 explanation cache identity and failures", () => {
  it("coalesces in-flight requests and reuses the completed result", async () => {
    const { create, key } = await api();
    const cache = create();
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const gen = async () => {
      calls += 1;
      await barrier;
      return { assertion: "generated once" };
    };
    const first = cache.getOrGenerate(key(source), gen);
    const second = cache.getOrGenerate(key(source), gen);
    release();
    expect(await first).toEqual(await second);
    expect(await cache.getOrGenerate(key(source), gen)).toEqual({ assertion: "generated once" });
    expect(calls).toBe(1);
    expect(cache.size()).toBe(1);
  });

  it.each([
    ["prUrl", OTHER_PR_URL],
    ["runId", "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02"],
    ["headSha", "f".repeat(40)],
    ["baseSha", "f".repeat(40)],
    ["mergeBaseSha", "f".repeat(40)],
    ["findingHash", "f".repeat(64)],
    ["diffHash", "f".repeat(64)],
    ["sourceHash", "f".repeat(64)],
    ["driverId", "kimi-stream-json"],
    ["modelId", "another-model"],
    ["schemaVersion", 2],
    ["promptVersion", 2],
  ])("invalidates completed entries when %s changes", async (field, value) => {
    const { create, key } = await api();
    const cache = create();
    const firstKey = key(source);
    const changedKey = key({ ...source, [field]: value });
    expect(changedKey).not.toBe(firstKey);
    let calls = 0;
    const gen = async () => ({ count: ++calls });
    await cache.getOrGenerate(firstKey, gen);
    expect(await cache.getOrGenerate(changedKey, gen)).toEqual({ count: 2 });
  });

  it("does not retain failures or a rejected in-flight promise and allows retry", async () => {
    const { create, key } = await api();
    const cache = create();
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fail = async () => {
      calls += 1;
      await barrier;
      throw new Error("executor timed out");
    };
    const outcomes = Promise.allSettled([
      cache.getOrGenerate(key(source), fail),
      cache.getOrGenerate(key(source), fail),
    ]);
    release();
    expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toBe(1);
    expect(cache.size()).toBe(0);
    expect(
      await cache.getOrGenerate(key(source), async () => {
        calls += 1;
        return { assertion: "retried" };
      }),
    ).toEqual({ assertion: "retried" });
    expect(calls).toBe(2);
  });
});
