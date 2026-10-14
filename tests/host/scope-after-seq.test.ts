import { createExecutionRegistry } from "@host/executions/execution-registry";
import { scopeRoutes } from "@host/routes/scopes";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "./helpers";

/**
 * Scope event resume reads afterSeq from the query string. A partial or
 * unsafe integer must be a 400, not a cursor that skips or repeats events.
 */

let host: TestHost | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
});

async function eventsStatus(query: string): Promise<number> {
  if (!host) throw new Error("host not booted");
  const res = await fetch(
    `${host.baseUrl}/api/v1/scopes/scope-1/executions/exec-1/events${query}`,
    { headers: authedHeaders(host) },
  );
  const status = res.status;
  await res.body?.cancel().catch(() => undefined);
  return status;
}

describe("scope event afterSeq", () => {
  it("keeps a canonical cursor", async () => {
    host = await createTestHost({
      routesFactory: (services) => {
        services.executionRegistry = createExecutionRegistry({ logger: services.logger });
        return scopeRoutes(services);
      },
    });
    expect(await eventsStatus("?afterSeq=0")).toBe(200);
    expect(await eventsStatus("")).toBe(200);
  });

  it("rejects a partial or unsafe afterSeq", async () => {
    host = await createTestHost({
      routesFactory: (services) => {
        services.executionRegistry = createExecutionRegistry({ logger: services.logger });
        return scopeRoutes(services);
      },
    });
    expect(await eventsStatus("?afterSeq=1abc")).toBe(400);
    expect(await eventsStatus("?afterSeq=1.9")).toBe(400);
    expect(await eventsStatus("?afterSeq=9007199254740993")).toBe(400);
    expect(await eventsStatus(`?afterSeq=${"9".repeat(400)}`)).toBe(400);
  });
});
