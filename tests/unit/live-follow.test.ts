import { liveEmptyProcessMessage, liveFollowNotice } from "@/lib/live-follow";
import { describe, expect, it } from "vitest";

describe("liveEmptyProcessMessage", () => {
  it("distinguishes waiting, quiet, missing, and error", () => {
    expect(liveEmptyProcessMessage({ ready: false, active: true, done: false, error: false })).toBe(
      "读取过程…",
    );
    expect(liveEmptyProcessMessage({ ready: true, active: true, done: false, error: false })).toBe(
      "等待首条输出",
    );
    expect(liveEmptyProcessMessage({ ready: true, active: false, done: true, error: false })).toBe(
      "尚无过程记录",
    );
    expect(
      liveEmptyProcessMessage({ ready: true, active: true, done: false, error: true }),
    ).toBeNull();
  });
});

describe("liveFollowNotice", () => {
  it("keeps the reader in place and offers jump-to-latest", () => {
    expect(liveFollowNotice({ pinned: true, newCount: 4, resultReady: false })).toBeNull();
    expect(liveFollowNotice({ pinned: false, newCount: 3, resultReady: false })).toEqual({
      text: "已暂停跟随 · 3 条新活动",
      action: "回到最新",
    });
    expect(liveFollowNotice({ pinned: false, newCount: 0, resultReady: true })).toEqual({
      text: "结果已就绪",
      action: "查看结果",
    });
    expect(liveFollowNotice({ pinned: false, newCount: 2, resultReady: true })).toEqual({
      text: "已暂停跟随 · 2 条新活动 · 结果已就绪",
      action: "查看结果",
    });
  });
});
