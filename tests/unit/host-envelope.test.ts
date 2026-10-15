import { RuntimeClientError } from "@/runtime/client";
import { readOkData } from "@/runtime/host-envelope";
import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";

const schema = z.object({ n: z.number() });

class CustomHostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CustomHostError";
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readOkData", () => {
  it("returns schema-parsed data when the envelope is ok", async () => {
    await expect(
      readOkData(jsonResponse({ ok: true, data: { n: 1 } }, 200), schema, {
        fallbackMessage: "fallback",
      }),
    ).resolves.toEqual({ n: 1 });
  });

  it("throws RuntimeClientError with UNKNOWN and the status fallback", async () => {
    const error = await readOkData(jsonResponse({ ok: false }, 500), schema, {
      fallbackMessage: (status) => `HTTP ${status}`,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeClientError);
    expect((error as RuntimeClientError).status).toBe(500);
    expect((error as RuntimeClientError).code).toBe("UNKNOWN");
    expect((error as RuntimeClientError).message).toBe("HTTP 500");
  });

  it("uses the envelope message and a caller error class", async () => {
    const error = await readOkData(
      jsonResponse({ ok: false, error: { code: "NOPE", message: "no" } }, 200),
      schema,
      { fallbackMessage: "fallback", ErrorClass: CustomHostError },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CustomHostError);
    expect((error as CustomHostError).status).toBe(200);
    expect((error as CustomHostError).code).toBe("NOPE");
    expect((error as CustomHostError).message).toBe("no");
  });

  it("rejects data that fails the schema", async () => {
    await expect(
      readOkData(jsonResponse({ ok: true, data: { n: "x" } }, 200), schema, {
        fallbackMessage: "fallback",
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
