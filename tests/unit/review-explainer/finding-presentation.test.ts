import { displayFindingTitle } from "@/components/report/explainer/finding-presentation";
import { describe, expect, it } from "vitest";

describe("displayFindingTitle", () => {
  it.each([
    ["HTTP/2 handshake fails after retry", "HTTP/2 handshake fails after retry"],
    ["I/O timeout on shutdown", "I/O timeout on shutdown"],
    ["TCP/IP stack drops the SYN", "TCP/IP stack drops the SYN"],
    ["A/B test flips the metric", "A/B test flips the metric"],
  ])("keeps a slash that is not a source file: %s", (title, expected) => {
    expect(displayFindingTitle({ title })).toBe(expected);
  });

  it("drops a leading source file and keeps the headline", () => {
    expect(
      displayFindingTitle({
        title: "pkg/runtime/manager/session_manager.go:204-205 — 状态回滚失败",
      }),
    ).toBe("状态回滚失败");
  });

  it("drops a backticked source file and keeps the headline", () => {
    expect(displayFindingTitle({ title: "`src/app.ts:12` — null deref" })).toBe("null deref");
  });

  it("keeps a title that is only a source path", () => {
    expect(displayFindingTitle({ title: "src/app.ts:12" })).toBe("src/app.ts:12");
  });
});
