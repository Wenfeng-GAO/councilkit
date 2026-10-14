import { liveFollowNotice } from "@/lib/live-follow";
import { describe, expect, it } from "vitest";

describe("liveFollowNotice quiet", () => {
  it("returns null when follow is free and nothing new is ready", () => {
    expect(liveFollowNotice({ pinned: false, newCount: 0, resultReady: false })).toBeNull();
  });
});
