import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import { useControlState, useRoomIntents } from "@/stores/runtime-intents";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "./render-hook";

const ROOM_ID = "room-42";
const MESSAGE = "Ship the decision report";

const { orchestrator } = vi.hoisted(() => {
  const payloads = {
    startRound: { roundNumber: 1, phase: "pending" },
    pauseRoom: { paused: true },
    resumeRoom: { paused: false },
    cancelActiveExecution: { cancelledExecutionId: "exec-9" },
    abortPausedRound: { abortedRoundId: "round-3" },
    retryFailedParticipant: { retriedParticipantId: "participant-1" },
    skipFailedParticipant: { skippedParticipantId: "participant-1" },
    rotateScope: { scopeRequestId: "scope-req-1" },
    releaseRuntime: { released: true },
    concludeRoom: { concluded: true },
  } as const;

  const call = (name: keyof typeof payloads) =>
    vi.fn(async () => {
      return payloads[name];
    });

  return {
    orchestrator: {
      startRound: call("startRound"),
      pauseRoom: call("pauseRoom"),
      resumeRoom: call("resumeRoom"),
      cancelActiveExecution: call("cancelActiveExecution"),
      abortPausedRound: call("abortPausedRound"),
      retryFailedParticipant: call("retryFailedParticipant"),
      skipFailedParticipant: call("skipFailedParticipant"),
      rotateScope: call("rotateScope"),
      releaseRuntime: call("releaseRuntime"),
      sendUserMessage: vi.fn(async (roomId: string, content: string) => ({
        id: "message-1",
        roomId,
        content,
      })),
      concludeRoom: call("concludeRoom"),
    },
  };
});

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({ orchestrator }),
}));

type Intents = ReturnType<typeof useRoomIntents>;

function mount<T>(useValue: () => T) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  return { invalidate, ...renderHook(useValue, client) };
}

describe("room intents", () => {
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useRuntimeDiscussionStore.setState({
      controlByRoom: {},
      previewByExecution: {},
      changeTickByRoom: {},
    });
    for (const fn of Object.values(orchestrator)) fn.mockClear();
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
  });

  it("forwards every room intent and refetches runtime queries when it settles", async () => {
    const mounted = mount(() => useRoomIntents(ROOM_ID));
    unmount = mounted.unmount;
    const intents = mounted.read();

    await act(async () => {
      await intents.startRound.mutateAsync();
      await intents.pauseRoom.mutateAsync();
      await intents.resumeRoom.mutateAsync();
      await intents.cancelActiveExecution.mutateAsync();
      await intents.abortPausedRound.mutateAsync();
      await intents.retryFailedParticipant.mutateAsync();
      await intents.skipFailedParticipant.mutateAsync();
      await intents.rotateScope.mutateAsync();
      await intents.releaseRuntime.mutateAsync();
      await intents.sendUserMessage.mutateAsync(MESSAGE);
      await intents.concludeRoom.mutateAsync();
      // React Query notifies subscribers on a setTimeout(0). Flush that turn
      // before reading hook state.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const settled = mounted.read();
    expect(settled.startRound.data).toEqual({ roundNumber: 1, phase: "pending" });
    expect(settled.pauseRoom.data).toEqual({ paused: true });
    expect(settled.resumeRoom.data).toEqual({ paused: false });
    expect(settled.cancelActiveExecution.data).toEqual({ cancelledExecutionId: "exec-9" });
    expect(settled.abortPausedRound.data).toEqual({ abortedRoundId: "round-3" });
    expect(settled.retryFailedParticipant.data).toEqual({ retriedParticipantId: "participant-1" });
    expect(settled.skipFailedParticipant.data).toEqual({ skippedParticipantId: "participant-1" });
    expect(settled.rotateScope.data).toEqual({ scopeRequestId: "scope-req-1" });
    expect(settled.releaseRuntime.data).toEqual({ released: true });
    expect(settled.sendUserMessage.data).toEqual({
      id: "message-1",
      roomId: ROOM_ID,
      content: MESSAGE,
    });
    expect(settled.concludeRoom.data).toEqual({ concluded: true });

    const names: Array<Exclude<keyof Intents, "sendUserMessage">> = [
      "startRound",
      "pauseRoom",
      "resumeRoom",
      "cancelActiveExecution",
      "abortPausedRound",
      "retryFailedParticipant",
      "skipFailedParticipant",
      "rotateScope",
      "releaseRuntime",
      "concludeRoom",
    ];
    for (const name of names) {
      expect(settled[name].status).toBe("success");
      expect(settled[name].isPending).toBe(false);
      expect(settled[name].error).toBeNull();
      expect(orchestrator[name].mock.calls).toEqual([[ROOM_ID]]);
    }
    expect(settled.sendUserMessage.status).toBe("success");
    expect(settled.sendUserMessage.isPending).toBe(false);
    expect(settled.sendUserMessage.error).toBeNull();
    expect(orchestrator.sendUserMessage.mock.calls).toEqual([[ROOM_ID, MESSAGE]]);
    expect(mounted.invalidate.mock.calls).toEqual(
      Array.from({ length: 11 }, () => [{ queryKey: ["rt"] }]),
    );
  });

  it("still refetches runtime queries when an intent rejects", async () => {
    orchestrator.pauseRoom.mockRejectedValueOnce(new Error("lock lost"));
    const mounted = mount(() => useRoomIntents(ROOM_ID));
    unmount = mounted.unmount;

    let caught: unknown;
    await act(async () => {
      try {
        await mounted.read().pauseRoom.mutateAsync();
      } catch (error) {
        caught = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(caught).toEqual(new Error("lock lost"));
    expect(mounted.read().pauseRoom.status).toBe("error");
    expect(mounted.read().pauseRoom.isPending).toBe(false);
    expect(mounted.read().pauseRoom.failureCount).toBe(1);
    expect((mounted.read().pauseRoom.error as Error).message).toBe("lock lost");
    expect(orchestrator.pauseRoom.mock.calls).toEqual([[ROOM_ID]]);
    expect(mounted.invalidate.mock.calls).toEqual([[{ queryKey: ["rt"] }]]);
  });

  it("reads the control state for the requested room only", () => {
    const mounted = mount(() => ({
      room: useControlState(ROOM_ID),
      other: useControlState("room-other"),
    }));
    unmount = mounted.unmount;

    expect(mounted.read()).toEqual({ room: undefined, other: undefined });

    act(() => {
      useRuntimeDiscussionStore.getState().setControlState("room-other", "observing");
    });
    expect(mounted.read()).toEqual({ room: undefined, other: "observing" });

    act(() => {
      useRuntimeDiscussionStore.getState().setControlState(ROOM_ID, "acquiring");
    });
    expect(mounted.read()).toEqual({ room: "acquiring", other: "observing" });

    act(() => {
      useRuntimeDiscussionStore.getState().setControlState(ROOM_ID, "takeover_failed");
    });
    expect(mounted.read()).toEqual({ room: "takeover_failed", other: "observing" });

    act(() => {
      useRuntimeDiscussionStore.getState().resetRoom(ROOM_ID);
    });
    expect(mounted.read()).toEqual({ room: undefined, other: "observing" });
  });
});
