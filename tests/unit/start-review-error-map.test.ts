import { mapStartIdeateError, mapStartReviewError } from "@/lib/start-review-hints";
import { RuntimeClientError } from "@/runtime/client";
import { describe, expect, it } from "vitest";

describe("mapStartReviewError", () => {
  it("offers councilkit init when the host mentions pr-jury", () => {
    expect(
      mapStartReviewError(new RuntimeClientError(409, "CONFLICT", "missing pr-jury profile"), ""),
    ).toEqual({
      text: "missing pr-jury profile",
      copyCommand: "councilkit init",
    });
  });

  it("offers councilkit init when the message mentions councilkit init", () => {
    expect(mapStartReviewError(new Error("run councilkit init first"), "x")).toEqual({
      text: "run councilkit init first",
      copyCommand: "councilkit init",
    });
  });

  it("offers a review command with the trimmed PR when there is no local clone", () => {
    expect(
      mapStartReviewError(
        new Error("No local clone for that URL"),
        "  https://github.com/acme/repo/pull/4  ",
      ),
    ).toEqual({
      text: "No local clone for that URL",
      copyCommand: "councilkit review https://github.com/acme/repo/pull/4 --repo <path>",
    });
  });

  it("uses a placeholder PR when --repo is required and the field is blank", () => {
    expect(mapStartReviewError(new Error("pass --repo"), "   ")).toEqual({
      text: "pass --repo",
      copyCommand: "councilkit review <pr-url> --repo <path>",
    });
  });

  it("returns the message with no command for an ordinary failure", () => {
    expect(mapStartReviewError(new Error("quota"), "https://github.com/acme/repo/pull/4")).toEqual({
      text: "quota",
      copyCommand: null,
    });
    expect(mapStartReviewError("nope", "https://github.com/acme/repo/pull/4")).toEqual({
      text: "启动审查失败",
      copyCommand: null,
    });
  });
});

describe("mapStartIdeateError", () => {
  it("offers councilkit init for product-jury and init hints", () => {
    expect(
      mapStartIdeateError(new RuntimeClientError(409, "CONFLICT", "missing product-jury")),
    ).toEqual({
      text: "missing product-jury",
      copyCommand: "councilkit init",
    });
    expect(mapStartIdeateError(new Error("请先 councilkit init"))).toEqual({
      text: "请先 councilkit init",
      copyCommand: "councilkit init",
    });
  });

  it("returns the message or the fallback with no command otherwise", () => {
    expect(mapStartIdeateError(new Error("roster empty"))).toEqual({
      text: "roster empty",
      copyCommand: null,
    });
    expect(mapStartIdeateError(null)).toEqual({
      text: "启动创意讨论失败",
      copyCommand: null,
    });
  });
});
