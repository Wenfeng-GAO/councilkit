import { createDisplayBridge, useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import type { RuntimeEvent } from "@shared/runtime/events";
import { beforeEach, describe, expect, it } from "vitest";

function delta(executionId: string, text: string, seq: number): RuntimeEvent {
  return {
    type: "output.delta",
    executionId,
    seq,
    at: "2026-10-14T00:00:00.000Z",
    text,
  };
}

function snapshot(executionId: string, text: string, seq: number): RuntimeEvent {
  return {
    type: "output.snapshot",
    executionId,
    seq,
    at: "2026-10-14T00:00:01.000Z",
    text,
  };
}

function ignored(type: "started" | "activity" | "usage", executionId: string): RuntimeEvent {
  return {
    type,
    executionId,
    seq: 4,
    at: "2026-10-14T00:00:02.000Z",
  } as RuntimeEvent;
}

function terminal(type: "completed" | "failed" | "interrupted", executionId: string): RuntimeEvent {
  return {
    type,
    executionId,
    seq: 8,
    at: "2026-10-14T00:00:03.000Z",
  } as RuntimeEvent;
}

describe("runtime discussion display store", () => {
  beforeEach(() => {
    useRuntimeDiscussionStore.setState({
      controlByRoom: {},
      previewByExecution: {},
      changeTickByRoom: {},
    });
  });

  it("starts with empty control, preview, and tick maps", () => {
    expect(useRuntimeDiscussionStore.getState().controlByRoom).toEqual({});
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({});
    expect(useRuntimeDiscussionStore.getState().changeTickByRoom).toEqual({});
  });

  it("stores control per room and overwrites only the targeted room", () => {
    const store = useRuntimeDiscussionStore.getState();
    store.setControlState("room-a", "acquiring");
    store.setControlState("room-b", "observing");
    store.setControlState("room-a", "controlling");

    expect(useRuntimeDiscussionStore.getState().controlByRoom).toEqual({
      "room-a": "controlling",
      "room-b": "observing",
    });

    store.setControlState("room-b", "lost-control");
    store.setControlState("room-a", "takeover_failed");
    expect(useRuntimeDiscussionStore.getState().controlByRoom).toEqual({
      "room-a": "takeover_failed",
      "room-b": "lost-control",
    });
  });

  it("appends deltas, replaces them with a snapshot, and leaves other executions alone", () => {
    const store = useRuntimeDiscussionStore.getState();
    store.applyPreview("room-a", delta("exec-1", "Hello", 1));
    store.applyPreview("room-a", delta("exec-1", " ", 2));
    store.applyPreview("room-a", delta("exec-1", "world", 3));
    store.applyPreview("room-a", delta("exec-2", "other", 1));

    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({
      "exec-1": "Hello world",
      "exec-2": "other",
    });

    store.applyPreview("room-a", snapshot("exec-1", "SNAP", 4));
    store.applyPreview("room-a", delta("exec-1", "!", 5));
    store.applyPreview("room-b", snapshot("exec-9", "", 1));

    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({
      "exec-1": "SNAP!",
      "exec-2": "other",
      "exec-9": "",
    });
  });

  it("ignores started, activity, and usage events without replacing state", () => {
    const store = useRuntimeDiscussionStore.getState();
    store.applyPreview("room-a", delta("exec-1", "Hello", 1));
    const before = useRuntimeDiscussionStore.getState();

    before.applyPreview("room-a", ignored("started", "exec-1"));
    before.applyPreview("room-a", ignored("activity", "exec-1"));
    before.applyPreview("room-a", ignored("usage", "exec-9"));

    expect(useRuntimeDiscussionStore.getState()).toBe(before);
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({ "exec-1": "Hello" });
  });

  it("drops a preview on completed, failed, and interrupted, including a missing id", () => {
    const store = useRuntimeDiscussionStore.getState();
    store.applyPreview("room-a", delta("exec-1", "A", 1));
    store.applyPreview("room-a", delta("exec-2", "B", 1));
    store.applyPreview("room-a", delta("exec-3", "C", 1));

    store.applyPreview("room-a", terminal("completed", "exec-1"));
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({
      "exec-2": "B",
      "exec-3": "C",
    });

    store.applyPreview("room-a", terminal("failed", "exec-2"));
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({ "exec-3": "C" });

    store.applyPreview("room-a", terminal("interrupted", "exec-3"));
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({});

    store.applyPreview("room-a", terminal("completed", "exec-missing"));
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({});
  });

  it("clears one execution preview and leaves the others in place", () => {
    const store = useRuntimeDiscussionStore.getState();
    store.applyPreview("room-a", delta("exec-1", "A", 1));
    store.applyPreview("room-a", delta("exec-2", "B", 1));

    store.clearPreview("exec-1");
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({ "exec-2": "B" });

    store.clearPreview("exec-1");
    store.clearPreview("exec-missing");
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({ "exec-2": "B" });
  });

  it("bumps a per-room tick from zero and resets only that room's control and tick", () => {
    const store = useRuntimeDiscussionStore.getState();
    store.applyPreview("room-a", delta("exec-1", "kept", 1));
    store.setControlState("room-a", "controlling");
    store.setControlState("room-b", "observing");
    store.bumpChanged("room-a");
    store.bumpChanged("room-a");
    store.bumpChanged("room-b");

    expect(useRuntimeDiscussionStore.getState().changeTickByRoom).toEqual({
      "room-a": 2,
      "room-b": 1,
    });

    store.resetRoom("room-a");
    expect(useRuntimeDiscussionStore.getState().controlByRoom).toEqual({ "room-b": "observing" });
    expect(useRuntimeDiscussionStore.getState().changeTickByRoom).toEqual({ "room-b": 1 });
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({ "exec-1": "kept" });

    store.resetRoom("room-missing");
    expect(useRuntimeDiscussionStore.getState().controlByRoom).toEqual({ "room-b": "observing" });
    expect(useRuntimeDiscussionStore.getState().changeTickByRoom).toEqual({ "room-b": 1 });
  });

  it("bridges control, preview, and round changes into the live store", () => {
    const seen: Array<{ roomId: string; tick: number }> = [];
    const bridge = createDisplayBridge((roomId) => {
      seen.push({
        roomId,
        tick: useRuntimeDiscussionStore.getState().changeTickByRoom[roomId] ?? -1,
      });
    });
    const onControlState = bridge.onControlState;
    const onPreview = bridge.onPreview;
    const onRoundChanged = bridge.onRoundChanged;
    if (!onControlState || !onPreview || !onRoundChanged) {
      throw new Error("display bridge omitted a sink");
    }

    onPreview("room-a", delta("exec-1", "A", 1));
    onPreview("room-a", delta("exec-1", "B", 2));
    onControlState("room-a", "acquiring");
    onControlState("room-b", "observing");
    onRoundChanged("room-a");
    onRoundChanged("room-b");

    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({ "exec-1": "AB" });
    expect(useRuntimeDiscussionStore.getState().controlByRoom).toEqual({
      "room-a": "acquiring",
      "room-b": "observing",
    });
    expect(useRuntimeDiscussionStore.getState().changeTickByRoom).toEqual({
      "room-a": 1,
      "room-b": 1,
    });
    expect(seen).toEqual([
      { roomId: "room-a", tick: 1 },
      { roomId: "room-b", tick: 1 },
    ]);
  });

  it("bumps the tick when the bridge has no change listener", () => {
    const bridge = createDisplayBridge();
    const onRoundChanged = bridge.onRoundChanged;
    if (!onRoundChanged) throw new Error("display bridge omitted onRoundChanged");

    onRoundChanged("room-c");
    onRoundChanged("room-c");

    expect(useRuntimeDiscussionStore.getState().changeTickByRoom).toEqual({ "room-c": 2 });
    expect(useRuntimeDiscussionStore.getState().controlByRoom).toEqual({});
    expect(useRuntimeDiscussionStore.getState().previewByExecution).toEqual({});
  });
});
