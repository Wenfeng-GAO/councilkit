import { describe, expect, it } from "vitest";
import { GIT_POSITIONAL_MAX_CHARS, gitPositional } from "../src/auto/git-argv";

describe("gitPositional", () => {
  it("keeps ordinary remotes, unicode, and absolute paths", () => {
    expect(gitPositional("  git@github.com:acme/方案.git  ")).toBe("git@github.com:acme/方案.git");
    expect(gitPositional("/tmp/repo")).toBe("/tmp/repo");
    expect(gitPositional("https://code.alipay.com/acme/repo.git")).toBe(
      "https://code.alipay.com/acme/repo.git",
    );
  });

  it("rejects empty, huge, control, and option-shaped values", () => {
    expect(gitPositional("")).toBeNull();
    expect(gitPositional("   ")).toBeNull();
    expect(gitPositional("--upload-pack=/tmp/ck-not-a-helper")).toBeNull();
    expect(gitPositional("-c")).toBeNull();
    expect(gitPositional("git@github.com:acme/repo.git\u0000")).toBeNull();
    expect(gitPositional(`git@h:${"a".repeat(GIT_POSITIONAL_MAX_CHARS)}`)).toBeNull();
  });
});
