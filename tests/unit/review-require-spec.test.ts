import {
  DEFAULT_REQUIRE_SPEC,
  REQUIRE_SPEC_CHECKBOX_LABEL,
} from "@/lib/review-require-spec";
import { describe, expect, it } from "vitest";

describe("require-spec UI/CLI defaults", () => {
  it("checkbox / CLI force-spec defaults to true", () => {
    expect(DEFAULT_REQUIRE_SPEC).toBe(true);
  });

  it("exposes the Start Review checkbox label", () => {
    expect(REQUIRE_SPEC_CHECKBOX_LABEL).toBe("强制按 spec review");
  });
});
