import { decideFollowAfterClose } from "@shared/runtime/follow-reconnect";
import { describe, expect, it } from "vitest";

describe("decideFollowAfterClose", () => {
  it("reconnects while the execution is still running", () => {
    expect(
      decideFollowAfterClose({
        snapshot: { state: "running", lastSeq: 2 },
        consumedSeq: 2,
        progressed: false,
        catchUpSpent: true,
      }),
    ).toEqual({ action: "reconnect", catchUpSpent: false });
  });

  it("reconnects when a terminal host is still ahead and this connection moved the cursor", () => {
    expect(
      decideFollowAfterClose({
        snapshot: { state: "completed", lastSeq: 5 },
        consumedSeq: 2,
        progressed: true,
        catchUpSpent: false,
      }),
    ).toEqual({ action: "reconnect", catchUpSpent: false });
  });

  it("allows one empty catch-up when a terminal host is ahead but this connection delivered nothing", () => {
    expect(
      decideFollowAfterClose({
        snapshot: { state: "failed", lastSeq: 4 },
        consumedSeq: 0,
        progressed: false,
        catchUpSpent: false,
      }),
    ).toEqual({ action: "reconnect", catchUpSpent: true });
  });

  it("stops after that empty catch-up still delivers nothing", () => {
    for (const state of ["completed", "failed", "interrupted"]) {
      expect(
        decideFollowAfterClose({
          snapshot: { state, lastSeq: 4 },
          consumedSeq: 0,
          progressed: false,
          catchUpSpent: true,
        }),
      ).toEqual({ action: "stop", reason: "exhausted" });
    }
  });

  it("stops when the cursor is already caught up with a terminal host", () => {
    expect(
      decideFollowAfterClose({
        snapshot: { state: "interrupted", lastSeq: 3 },
        consumedSeq: 3,
        progressed: true,
        catchUpSpent: false,
      }),
    ).toEqual({ action: "stop", reason: "exhausted" });
  });

  it("stops when the execution record is gone", () => {
    expect(
      decideFollowAfterClose({
        snapshot: null,
        consumedSeq: 1,
        progressed: true,
        catchUpSpent: false,
      }),
    ).toEqual({ action: "stop", reason: "lost" });
  });
});
