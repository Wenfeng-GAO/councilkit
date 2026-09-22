import { createHash } from "node:crypto";
export function explanationCacheKey(input: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
export function createExplanationCache() {
  const complete = new Map<string, unknown>();
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    size: () => complete.size,
    async getOrGenerate<T>(key: string, generate: () => Promise<T>): Promise<T> {
      if (complete.has(key)) return complete.get(key) as T;
      const current = inFlight.get(key);
      if (current) return current as Promise<T>;
      const promise = Promise.resolve()
        .then(generate)
        .then((result) => {
          complete.set(key, result);
          return result;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, promise);
      return promise;
    },
  };
}
