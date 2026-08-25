import { isHostUnreachableError } from "@/lib/host-status";
import { RuntimeClientError } from "@/runtime/client";
import { describe, expect, it } from "vitest";

describe("isHostUnreachableError", () => {
  it("treats fetch failures and 502 as host-down, not 404", () => {
    expect(isHostUnreachableError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isHostUnreachableError(new RuntimeClientError(502, "BAD_GATEWAY", "proxy"))).toBe(true);
    expect(isHostUnreachableError(new RuntimeClientError(404, "NOT_FOUND", "missing"))).toBe(false);
  });
});
