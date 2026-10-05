import { controlTransition } from "@/app/pages/RoomPage";
import { describe, expect, it } from "vitest";

describe("controlTransition", () => {
  it("does not treat a room switch from controlling to observing as losing this room", () => {
    expect(
      controlTransition({
        previousRoomId: "room-a",
        previousState: "controlling",
        roomId: "room-b",
        state: "observing",
      }),
    ).toEqual({ kind: "reset" });
  });

  it("does not announce a takeover when the next room is already controlling", () => {
    expect(
      controlTransition({
        previousRoomId: "room-a",
        previousState: "observing",
        roomId: "room-b",
        state: "controlling",
      }),
    ).toEqual({ kind: "reset" });
  });

  it("announces a real loss of control and clears preview only in the same room", () => {
    expect(
      controlTransition({
        previousRoomId: "room-b",
        previousState: "controlling",
        roomId: "room-b",
        state: "observing",
      }),
    ).toEqual({ kind: "lost", notice: "已转为只读观察" });
    expect(
      controlTransition({
        previousRoomId: "room-b",
        previousState: "controlling",
        roomId: "room-b",
        state: "lost-control",
      }),
    ).toEqual({ kind: "lost", notice: "已转为只读观察" });
  });

  it("announces a real takeover only in the same room", () => {
    expect(
      controlTransition({
        previousRoomId: "room-b",
        previousState: "observing",
        roomId: "room-b",
        state: "controlling",
      }),
    ).toEqual({ kind: "acquired", notice: "已取得控制权" });
  });

  it("stays quiet when the same room reports the same control state again", () => {
    expect(
      controlTransition({
        previousRoomId: "room-b",
        previousState: "controlling",
        roomId: "room-b",
        state: "controlling",
      }),
    ).toEqual({ kind: "none" });
  });
});
