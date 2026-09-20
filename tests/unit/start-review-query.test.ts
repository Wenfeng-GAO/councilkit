import { parseStartReviewQuery } from "@/lib/start-review-hints";
import { cliRunStartReviewRequestSchema } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

describe("parseStartReviewQuery", () => {
  it("reads a PR URL and against run id", () => {
    expect(
      parseStartReviewQuery(
        "?pr=https://github.com/acme/repo/pull/1&against=ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      ),
    ).toEqual({
      pr: "https://github.com/acme/repo/pull/1",
      against: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
    });
  });

  it("drops an against value that is not a review run id", () => {
    expect(parseStartReviewQuery("pr=https://github.com/acme/repo/pull/1&against=--repo")).toEqual({
      pr: "https://github.com/acme/repo/pull/1",
    });
  });
});

describe("cliRunStartReviewRequestSchema against", () => {
  it("accepts a review run id", () => {
    const parsed = cliRunStartReviewRequestSchema.safeParse({
      pr: "https://github.com/acme/repo/pull/1",
      against: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects argv-shaped against values", () => {
    expect(
      cliRunStartReviewRequestSchema.safeParse({
        pr: "https://github.com/acme/repo/pull/1",
        against: "--repo",
      }).success,
    ).toBe(false);
  });
});
