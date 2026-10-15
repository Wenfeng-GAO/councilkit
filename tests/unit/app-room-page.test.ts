import "./app-dom-install";

import {
  type RoomNotifySignature,
  RoomPage,
  canConcludeNow,
  controlTransition,
  deriveRoomPhase,
  detectRoomNotifyEvent,
  findFailedReportExecution,
  findLiveReportExecution,
  notifyTitle,
  notifyTone,
} from "@/app/pages/RoomPage";
import type { DiscussionRoom, DiscussionRound } from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickButton } from "./app-dom-install";
import { setDocumentVisibility, settle } from "./app-page-harness";

function mutation() {
  return {
    mutate: vi.fn(),
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  };
}

const scene = vi.hoisted(() => {
  const intents = {
    startRound: mutation(),
    pauseRoom: mutation(),
    resumeRoom: mutation(),
    cancelActiveExecution: mutation(),
    abortPausedRound: mutation(),
    concludeRoom: mutation(),
    sendUserMessage: { mutate: vi.fn() },
  };
  const state = {
    roomId: "room-1" as string | undefined,
    roomLoading: false,
    room: null as DiscussionRoom | null,
    rounds: [] as DiscussionRound[],
    participants: [] as Array<{ id: string; agentId: string; modelId: string }>,
    agents: [] as Array<{ id: string; name: string; color: string }>,
    profiles: [] as unknown[],
    messages: [] as unknown[],
    executions: [] as ModelExecution[],
    report: null as { id: string; content: string } | null,
    recovery: {
      executions: [] as ModelExecution[],
      bindings: [] as Array<{ roomId: string; createdAt: string; controllerId: string }>,
      rounds: [] as DiscussionRound[],
    },
    control: "controlling" as string,
    announcement: "第 1 轮已开始",
    hash: "",
    submitted: false,
    cleared: [] as string[],
    bumped: [] as string[],
    releases: [] as string[],
    locks: [] as Array<{ name: string; options: unknown }>,
    intents,
    controlRoom: (_roomId: string, _signal: AbortSignal) =>
      Promise.resolve(null as { release(): void } | null),
  };
  return {
    ...state,
    store: {
      changeTickByRoom: {} as Record<string, number>,
      previewByExecution: {} as Record<string, string>,
      clearPreview(id: string) {
        state.cleared.push(id);
      },
      bumpChanged(roomId: string) {
        state.bumped.push(roomId);
      },
    },
  };
});

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({
    client: {},
    orchestrator: {
      controlRoom: (roomId: string, signal: AbortSignal) => scene.controlRoom(roomId, signal),
    },
  }),
}));

vi.mock("@/stores/runtime-queries", () => ({
  useRuntimeRoom: () => ({ data: scene.room, isLoading: scene.roomLoading }),
  useRuntimeRounds: () => ({ data: scene.rounds }),
  useParticipants: () => ({ data: scene.participants }),
  useAgents: () => ({ data: scene.agents }),
  useExecutionProfiles: () => ({ data: scene.profiles }),
  useRoundMessages: () => ({ data: scene.messages }),
  useRoundExecutions: () => ({ data: scene.executions }),
  useRoomReport: () => ({ data: scene.report }),
  useRoomRecoveryFacts: () => ({ data: scene.recovery }),
}));

vi.mock("@/stores/runtime-intents", () => ({
  useControlState: () => scene.control,
  useRoomIntents: () => scene.intents,
}));

vi.mock("@/stores/runtime-discussion", () => {
  function useRuntimeDiscussionStore(selector: (state: typeof scene.store) => unknown) {
    return selector(scene.store);
  }
  useRuntimeDiscussionStore.getState = () => scene.store;
  return { useRuntimeDiscussionStore };
});

vi.mock("@/components/room/useObserverPreview", () => ({
  useObserverPreview: () => undefined,
}));

vi.mock("@/components/room/useRoomAnnouncer", () => ({
  useRoomAnnouncer: () => scene.announcement,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ roomId: scene.roomId }),
    useLocation: () => ({
      hash: scene.hash,
      pathname: "/rooms/room-1",
      search: "",
      state: null,
      key: "room",
    }),
  };
});

vi.mock("@/components/room/RoomHeader", async () => {
  const { createElement: h } = await import("react");
  return { RoomHeader: (props: { room: { topic: string } }) => h("h1", null, props.room.topic) };
});

vi.mock("@/components/room/ControlBanner", async () => {
  const { createElement: h } = await import("react");
  return {
    ControlBanner: (props: {
      notice: string | null;
      controllerId: string | null;
      onTakeover: () => void;
      takeoverPending: boolean;
    }) =>
      h(
        "div",
        null,
        h("p", null, `notice:${props.notice ?? ""}`),
        h("p", null, `controller:${props.controllerId ?? ""}`),
        h(
          "button",
          { type: "button", onClick: props.onTakeover },
          props.takeoverPending ? "接管中" : "接管控制",
        ),
      ),
  };
});

vi.mock("@/components/room/ErrorBanner", async () => {
  const { createElement: h } = await import("react");
  return {
    ErrorBanner: (props: { message: string | null; onDismiss: () => void }) =>
      h(
        "div",
        null,
        h("p", null, `error:${props.message ?? ""}`),
        h("button", { type: "button", onClick: props.onDismiss }, "关闭错误"),
      ),
  };
});

vi.mock("@/components/room/ReportView", async () => {
  const { createElement: h } = await import("react");
  const actual = await vi.importActual<typeof import("@/components/room/ReportView")>(
    "@/components/room/ReportView",
  );
  return {
    reportFailureCopy: actual.reportFailureCopy,
    ReportProgress: (props: { previewText: string; speakerName: string; speakerColor: string }) =>
      h("p", null, `progress:${props.speakerName}:${props.speakerColor}:${props.previewText}`),
    ReportFailureBanner: (props: { execution: { executionId: string }; onRetry: () => void }) =>
      h(
        "div",
        null,
        h("p", null, `failed:${props.execution.executionId}`),
        h("button", { type: "button", onClick: props.onRetry }, "重试报告"),
      ),
    ReportView: (props: { report: { content: string }; topic: string }) =>
      h("div", { id: "report" }, `${props.topic}:${props.report.content}`),
  };
});

vi.mock("@/components/room/DiscussionStream", async () => {
  const { createElement: h } = await import("react");
  return {
    DiscussionStream: (props: { rounds: unknown[]; activeRoundId: string | null }) =>
      h("p", null, `stream:${props.rounds.length}:${props.activeRoundId ?? ""}`),
  };
});

vi.mock("@/components/room/PausedPanel", async () => {
  const { createElement: h } = await import("react");
  return {
    PausedPanel: (props: { onAbort: () => void; abortPending: boolean }) =>
      h(
        "button",
        { type: "button", onClick: props.onAbort },
        props.abortPending ? "正在放弃…" : "放弃本轮",
      ),
  };
});

vi.mock("@/components/room/UserInputBar", async () => {
  const { createElement: h } = await import("react");
  return {
    UserInputBar: () =>
      h(
        "form",
        {
          onSubmit: (event: Event) => {
            event.preventDefault();
            scene.submitted = true;
          },
        },
        h("input", { "aria-label": "用户发言" }),
        h("button", { type: "submit" }, "发送"),
      ),
  };
});

function room(partial: Partial<DiscussionRoom> = {}): DiscussionRoom {
  return {
    id: "room-1",
    topic: "路线讨论",
    background: "",
    facilitatorParticipantId: "part-1",
    runState: "idle",
    activeRoundId: null,
    contextRevision: 0,
    contextDigest: "",
    mode: "brainstorm",
    targetOutput: "",
    maxRounds: null,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-02T00:00:00.000Z",
    ...partial,
  };
}

function round(partial: Partial<DiscussionRound> = {}): DiscussionRound {
  return {
    id: "round-1",
    roomId: "room-1",
    roundNumber: 1,
    participantOrder: [],
    phase: "completed",
    pausedFrom: null,
    pauseReason: null,
    nextParticipantIndex: 0,
    activeExecutionId: null,
    focusMessageId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T01:00:00.000Z",
    ...partial,
  };
}

function execution(partial: Partial<ModelExecution>): ModelExecution {
  return {
    executionId: "exec-1",
    roomId: "room-1",
    resultKind: "report",
    state: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as ModelExecution;
}

describe("room page pure helpers", () => {
  const older = execution({
    executionId: "older",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "running",
  });
  const same = execution({
    executionId: "same",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "prepared",
  });
  const newer = execution({
    executionId: "newer",
    createdAt: "2026-02-01T00:00:00.000Z",
    state: "succeeded_uncommitted",
  });
  const failed = execution({
    executionId: "failed",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "failed",
  });
  const failedLater = execution({
    executionId: "failed-later",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "interrupted",
  });

  it("derives phase and picks the newest live or failed report", () => {
    expect(deriveRoomPhase({ status: "concluded" }, [newer])).toBe("concluded");
    expect(deriveRoomPhase({ status: "open" }, [newer])).toBe("concluding");
    expect(deriveRoomPhase({ status: "open" }, [failed])).toBe("discussing");
    expect(findLiveReportExecution([older, same, newer])?.executionId).toBe("newer");
    expect(findLiveReportExecution([older, same])?.executionId).toBe("older");
    expect(findFailedReportExecution([failed, failedLater])?.executionId).toBe("failed");
    expect(findLiveReportExecution([])).toBeUndefined();
  });

  it("decides conclude, notify, and control transitions", () => {
    expect(
      canConcludeNow({
        controlling: true,
        roomStatus: "open",
        hasActiveExecution: false,
        hasLiveReport: false,
        hasCompletedRound: true,
      }),
    ).toBe(true);
    expect(
      canConcludeNow({
        controlling: false,
        roomStatus: "open",
        hasActiveExecution: false,
        hasLiveReport: false,
        hasCompletedRound: true,
      }),
    ).toBe(false);
    expect(
      canConcludeNow({
        controlling: true,
        roomStatus: "concluded",
        hasActiveExecution: false,
        hasLiveReport: false,
        hasCompletedRound: true,
      }),
    ).toBe(false);
    expect(
      canConcludeNow({
        controlling: true,
        roomStatus: "open",
        hasActiveExecution: true,
        hasLiveReport: false,
        hasCompletedRound: true,
      }),
    ).toBe(false);
    expect(
      canConcludeNow({
        controlling: true,
        roomStatus: "open",
        hasActiveExecution: false,
        hasLiveReport: true,
        hasCompletedRound: true,
      }),
    ).toBe(false);
    expect(
      canConcludeNow({
        controlling: true,
        roomStatus: "open",
        hasActiveExecution: false,
        hasLiveReport: false,
        hasCompletedRound: false,
      }),
    ).toBe(false);

    const base: RoomNotifySignature = {
      roundId: "r1",
      phase: "running",
      roundNumber: 1,
      hasReport: false,
    };
    expect(detectRoomNotifyEvent(base, { ...base, roundId: "r2" })).toBe(null);
    expect(detectRoomNotifyEvent(base, base)).toBe(null);
    expect(detectRoomNotifyEvent(base, { ...base, hasReport: true, phase: "paused" })).toEqual({
      kind: "report-ready",
    });
    expect(detectRoomNotifyEvent(base, { ...base, phase: "paused" })).toEqual({
      kind: "round-paused",
      roundNumber: 1,
    });
    expect(detectRoomNotifyEvent(base, { ...base, phase: "completed" })).toEqual({
      kind: "round-completed",
      roundNumber: 1,
    });
    expect(notifyTitle({ kind: "round-paused", roundNumber: 2 }, "CouncilKit")).toBe(
      "⚠ 第 2 轮已暂停 · CouncilKit",
    );
    expect(notifyTitle({ kind: "round-completed", roundNumber: 2 }, "CouncilKit")).toBe(
      "✓ 第 2 轮已完成 · CouncilKit",
    );
    expect(notifyTitle({ kind: "report-ready" }, "CouncilKit")).toBe(
      "✓ 决策报告已生成 · CouncilKit",
    );
    expect(notifyTone({ kind: "round-paused", roundNumber: 1 })).toBe("warn");
    expect(notifyTone({ kind: "report-ready" })).toBe("success");
    expect(
      controlTransition({
        previousRoomId: "a",
        previousState: "controlling",
        roomId: "b",
        state: "controlling",
      }),
    ).toEqual({ kind: "reset" });
    expect(
      controlTransition({
        previousRoomId: "a",
        previousState: "controlling",
        roomId: "a",
        state: "controlling",
      }),
    ).toEqual({ kind: "none" });
    expect(
      controlTransition({
        previousRoomId: "a",
        previousState: "observing",
        roomId: "a",
        state: "controlling",
      }),
    ).toEqual({ kind: "acquired", notice: "已取得控制权" });
    expect(
      controlTransition({
        previousRoomId: "a",
        previousState: "controlling",
        roomId: "a",
        state: "lost-control",
      }),
    ).toEqual({ kind: "lost", notice: "已转为只读观察" });
    expect(
      controlTransition({
        previousRoomId: "a",
        previousState: "controlling",
        roomId: "a",
        state: "takeover_failed",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("RoomPage", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
    document.title = "";
    setDocumentVisibility("visible");
    scene.roomId = "room-1";
    scene.roomLoading = false;
    scene.room = room();
    scene.rounds = [];
    scene.participants = [];
    scene.agents = [];
    scene.profiles = [];
    scene.messages = [];
    scene.executions = [];
    scene.report = null;
    scene.recovery = { executions: [], bindings: [], rounds: [] };
    scene.control = "controlling";
    scene.announcement = "第 1 轮已开始";
    scene.hash = "";
    scene.submitted = false;
    scene.cleared.length = 0;
    scene.bumped.length = 0;
    scene.releases.length = 0;
    scene.locks.length = 0;
    scene.store.previewByExecution = {};
    scene.controlRoom = async () => null;
    for (const key of [
      "startRound",
      "pauseRoom",
      "resumeRoom",
      "cancelActiveExecution",
      "abortPausedRound",
      "concludeRoom",
    ] as const) {
      scene.intents[key].isPending = false;
      scene.intents[key].error = null;
      scene.intents[key].mutate.mockClear();
      scene.intents[key].reset.mockClear();
    }
  });

  function captureSlowTimers() {
    const timeouts: Array<{ delay: number; run: () => void }> = [];
    const intervals: Array<{ delay: number; run: () => void }> = [];
    let nextId = 1_000_000;
    const originalTimeout = globalThis.setTimeout.bind(globalThis);
    const originalInterval = globalThis.setInterval.bind(globalThis);
    const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const originalClearInterval = globalThis.clearInterval.bind(globalThis);
    const timeoutIds = new Set<number>();
    const intervalIds = new Set<number>();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === "function" && typeof delay === "number" && delay >= 1500) {
        const id = nextId;
        nextId += 1;
        timeoutIds.add(id);
        timeouts.push({ delay, run: () => handler(...args) });
        return id as unknown as ReturnType<typeof setTimeout>;
      }
      return originalTimeout(handler, delay, ...(args as []));
    }) as typeof globalThis.setTimeout);
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === "function" && typeof delay === "number" && delay >= 1500) {
        const id = nextId;
        nextId += 1;
        intervalIds.add(id);
        intervals.push({ delay, run: () => handler(...args) });
        return id as unknown as ReturnType<typeof setInterval>;
      }
      return originalInterval(handler, delay, ...(args as []));
    }) as typeof globalThis.setInterval);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((id?: number) => {
      if (typeof id === "number" && timeoutIds.has(id)) {
        timeoutIds.delete(id);
        return;
      }
      originalClearTimeout(id);
    }) as typeof globalThis.clearTimeout);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((id?: number) => {
      if (typeof id === "number" && intervalIds.has(id)) {
        intervalIds.delete(id);
        return;
      }
      originalClearInterval(id);
    }) as typeof globalThis.clearInterval);
    return {
      timeouts,
      intervals,
      async fire(kind: "timeout" | "interval", delay: number): Promise<void> {
        const list = kind === "timeout" ? timeouts : intervals;
        const found = list.find((item) => item.delay === delay);
        if (!found) {
          throw new Error(
            `missing ${kind} ${delay}; have ${list.map((item) => item.delay).join(",")}`,
          );
        }
        await act(async () => {
          found.run();
        });
      },
    };
  }

  async function paint(): Promise<HTMLDivElement> {
    if (!container || !root) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root?.render(createElement(RoomPage));
    });
    await settle();
    return container;
  }

  it("guards missing, loading, and unknown rooms", async () => {
    scene.roomId = undefined;
    let view = await paint();
    expect(view.textContent).toContain("缺少房间 ID");
    scene.roomId = "room-1";
    scene.roomLoading = true;
    view = await paint();
    expect(view.textContent).toContain("加载中…");
    scene.roomLoading = false;
    scene.room = null;
    view = await paint();
    expect(view.textContent).toContain("未找到房间");
    expect(view.textContent).toContain("它可能已被删除，或尚未在此设备上创建。");
  });

  it("starts, pauses, resumes, stops, and concludes a controlled room", async () => {
    scene.controlRoom = async () => ({
      release: () => scene.releases.push("held"),
    });
    let view = await paint();
    expect(view.textContent).toContain("路线讨论");
    expect(view.textContent).toContain("发起讨论");
    expect(view.textContent).toContain("第 1 轮已开始");
    const start = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "发起讨论",
    );
    expect(start?.getAttribute("title")).toBeNull();
    await clickButton(view, "发起讨论");
    expect(scene.intents.startRound.mutate.mock.calls).toEqual([[]]);

    scene.rounds = [round({ phase: "completed" })];
    view = await paint();
    await clickButton(view, "开始新一轮");
    expect(scene.intents.startRound.mutate.mock.calls).toHaveLength(2);
    await clickButton(view, "总结并结束");
    expect(view.textContent).toContain(
      "将基于已完成轮次生成决策报告,结束后房间只读,无法再发起新一轮讨论。",
    );
    await clickButton(view, "确认总结");
    expect(scene.intents.concludeRoom.mutate.mock.calls).toEqual([[]]);
    expect(view.textContent).not.toContain("将基于已完成轮次生成决策报告");

    scene.room = room({ runState: "running", activeRoundId: "round-live" });
    scene.rounds = [round({ id: "round-live", phase: "running", activeExecutionId: "exec-live" })];
    scene.executions = [
      execution({ executionId: "exec-live", resultKind: "message", state: "running" }),
    ];
    view = await paint();
    await clickButton(view, "停止生成");
    expect(scene.intents.cancelActiveExecution.mutate.mock.calls).toEqual([[]]);
    await clickButton(view, "暂停调度");
    expect(scene.intents.pauseRoom.mutate.mock.calls).toEqual([[]]);
    scene.intents.pauseRoom.isPending = true;
    scene.intents.cancelActiveExecution.isPending = true;
    view = await paint();
    expect(view.textContent).toContain("正在停止…");
    expect(view.textContent).toContain("正在暂停调度…");
    scene.room = room();
    scene.rounds = [];
    scene.executions = [];
    scene.intents.pauseRoom.isPending = false;
    scene.intents.cancelActiveExecution.isPending = false;
    scene.intents.startRound.isPending = true;
    view = await paint();
    expect(view.textContent).toContain("正在开始…");
    scene.intents.startRound.isPending = false;

    scene.intents.startRound.isPending = false;
    scene.intents.pauseRoom.isPending = false;
    scene.intents.cancelActiveExecution.isPending = false;
    scene.room = room({ runState: "paused", activeRoundId: "round-paused" });
    scene.rounds = [round({ id: "round-paused", phase: "paused", activeExecutionId: null })];
    scene.executions = [];
    scene.intents.resumeRoom.isPending = true;
    scene.intents.abortPausedRound.isPending = true;
    view = await paint();
    expect(view.textContent).toContain("正在恢复调度…");
    expect(view.textContent).toContain("正在放弃…");
    scene.intents.resumeRoom.isPending = false;
    scene.intents.abortPausedRound.isPending = false;
    view = await paint();
    await clickButton(view, "恢复调度");
    expect(scene.intents.resumeRoom.mutate.mock.calls).toEqual([[]]);
    await clickButton(view, "放弃本轮");
    expect(scene.intents.abortPausedRound.mutate.mock.calls).toEqual([[]]);

    scene.intents.startRound.error = new Error("启动失败文案");
    view = await paint();
    expect(view.textContent).toContain("error:启动失败文案");
    await clickButton(view, "关闭错误");
    expect(scene.intents.startRound.reset.mock.calls).toEqual([[]]);
    expect(scene.intents.concludeRoom.reset.mock.calls).toEqual([[]]);

    const input = view.querySelector('input[aria-label="用户发言"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("missing user input");
    input.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(scene.submitted).toBe(true);
  });

  it("shows observer hints, a live report, a failed report, and a concluded report", async () => {
    scene.control = "observing";
    scene.recovery.bindings = [
      { roomId: "other", createdAt: "2026-03-01T00:00:00.000Z", controllerId: "other-controller" },
      { roomId: "room-1", createdAt: "2026-01-01T00:00:00.000Z", controllerId: "controller-old" },
      { roomId: "room-1", createdAt: "2026-02-01T00:00:00.000Z", controllerId: "controller-new" },
    ];
    let view = await paint();
    const start = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "发起讨论",
    );
    expect(start?.getAttribute("title")).toBe("当前页面没有控制权，无法操作");
    expect(view.textContent).toContain("controller:controller-new");
    const conclude = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "总结并结束",
    );
    expect(conclude?.getAttribute("title")).toBe("当前页面没有控制权，无法操作");

    scene.control = "controlling";
    scene.rounds = [round({ phase: "running", id: "round-open" })];
    scene.room = room({ activeRoundId: "round-open" });
    view = await paint();
    expect(
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "总结并结束")
        ?.getAttribute("title"),
    ).toBe("有执行进行中,无法结束");

    scene.rounds = [];
    scene.room = room();
    view = await paint();
    expect(
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "总结并结束")
        ?.getAttribute("title"),
    ).toBe("需先完成至少一轮讨论");

    scene.participants = [{ id: "part-1", agentId: "agent-1", modelId: "model-a" }];
    scene.agents = [{ id: "agent-1", name: "主持人甲", color: "#112233" }];
    scene.recovery.executions = [execution({ executionId: "report-live", state: "running" })];
    scene.store.previewByExecution = { "report-live": "报告草稿" };
    scene.rounds = [round()];
    view = await paint();
    expect(view.textContent).toContain("progress:主持人甲:#112233:报告草稿");
    expect(view.textContent).not.toContain("总结并结束");

    scene.recovery.executions = [execution({ executionId: "report-failed", state: "discarded" })];
    scene.store.previewByExecution = {};
    view = await paint();
    expect(view.textContent).toContain("failed:report-failed");
    await clickButton(view, "重试报告");
    expect(scene.intents.concludeRoom.mutate.mock.calls).toEqual([[]]);

    scene.recovery.executions = [];
    scene.room = room({ status: "concluded" });
    scene.report = null;
    view = await paint();
    expect(view.textContent).toContain("报告加载中…");
    expect(view.querySelector('input[aria-label="用户发言"]')).toBeNull();
    scene.report = { id: "report-1", content: "最终结论" };
    scene.hash = "#report";
    const scrolled: ScrollIntoViewOptions[] = [];
    HTMLElement.prototype.scrollIntoView = (options) => {
      scrolled.push(options as ScrollIntoViewOptions);
    };
    view = await paint();
    expect(view.textContent).toContain("路线讨论:最终结论");
    expect(scrolled).toEqual([{ behavior: "smooth" }]);
  });

  it("announces hidden-tab changes, draws a favicon, and clears it when visible", async () => {
    document.title = "房间页";
    setDocumentVisibility("hidden");
    scene.recovery.rounds = [round({ id: "round-1", phase: "running", roundNumber: 1 })];
    let view = await paint();
    scene.recovery.rounds = [round({ id: "round-1", phase: "completed", roundNumber: 1 })];
    view = await paint();
    expect(document.title).toBe("✓ 第 1 轮已完成 · 房间页");
    expect(document.querySelector("link[data-councilkit-status-icon]")).toBeNull();

    const fills: string[] = [];
    HTMLCanvasElement.prototype.getContext = (() => ({
      fillStyle: "",
      beginPath() {},
      arc() {},
      fill(this: { fillStyle: string }) {
        fills.push(this.fillStyle);
      },
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,dot";
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    const stubGetComputedStyle = ((element: Element) => {
      const style = realGetComputedStyle(element);
      return new Proxy(style, {
        get(target, prop, receiver) {
          if (prop === "getPropertyValue") {
            return (name: string) => {
              if (name === "--color-success") return " #16aa16 ";
              if (name === "--color-warn") return "";
              return target.getPropertyValue(name);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof window.getComputedStyle;
    window.getComputedStyle = stubGetComputedStyle;
    globalThis.getComputedStyle = stubGetComputedStyle;
    scene.report = { id: "report-1", content: "完成" };
    view = await paint();
    expect(document.title).toBe("✓ 决策报告已生成 · 房间页");
    expect(fills).toEqual(["#16aa16"]);
    expect(document.querySelector("link[data-councilkit-status-icon]")?.getAttribute("href")).toBe(
      "data:image/png;base64,dot",
    );

    scene.report = null;
    scene.recovery.rounds = [round({ id: "round-1", phase: "paused", roundNumber: 3 })];
    HTMLCanvasElement.prototype.getContext = (() => {
      throw new Error("canvas unavailable");
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    view = await paint();
    expect(document.title).toBe("⚠ 第 3 轮已暂停 · 房间页");

    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(document.title).toBe("房间页");
    expect(document.querySelector("link[data-councilkit-status-icon]")).toBeNull();
    expect(view.textContent).toContain("路线讨论");
  });

  it("takes over the room lock, drops late acquires, and polls while observing", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (name: string, options: unknown, callback: () => unknown) => {
          scene.locks.push({ name, options });
          return Promise.resolve(callback());
        },
      },
    });
    const acquired: Array<{ release(): void }> = [];
    scene.controlRoom = async () => {
      const handle = { release: () => scene.releases.push("takeover") };
      acquired.push(handle);
      return handle;
    };
    const view = await paint();
    await clickButton(view, "接管控制");
    await settle();
    expect(scene.locks).toEqual([{ name: "councilkit-room-room-1", options: { steal: true } }]);
    expect(scene.releases).toContain("takeover");

    scene.locks = [];
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    let resolveLate: (value: { release(): void } | null) => void = () => undefined;
    scene.controlRoom = () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      });
    await clickButton(view, "接管控制");
    await act(async () => {
      root?.unmount();
    });
    root = null;
    resolveLate({ release: () => scene.releases.push("late") });
    await settle();
    expect(scene.releases).toContain("late");

    scene.control = "observing";
    scene.room = room();
    const timers = captureSlowTimers();
    await paint();
    expect(timers.intervals.map((item) => item.delay)).toEqual([2000]);
    await timers.fire("interval", 2000);
    expect(scene.bumped).toEqual(["room-1"]);
    await timers.fire("interval", 2000);
    expect(scene.bumped).toEqual(["room-1", "room-1"]);
  });

  it("records control notices and clears a preview when control is lost", async () => {
    scene.room = room({ activeRoundId: "round-live" });
    scene.rounds = [round({ id: "round-live", phase: "running", activeExecutionId: "exec-live" })];
    scene.executions = [
      execution({ executionId: "exec-live", resultKind: "message", state: "running" }),
    ];
    const timers = captureSlowTimers();
    let view = await paint();
    scene.control = "observing";
    view = await paint();
    expect(view.textContent).toContain("notice:已转为只读观察");
    expect(scene.cleared).toEqual(["exec-live"]);
    expect(timers.timeouts.map((item) => item.delay)).toEqual([5000]);
    expect(view.textContent).toContain("notice:已转为只读观察");
    await timers.fire("timeout", 5000);
    expect(view.textContent).toContain("notice:");
    expect(view.textContent).not.toContain("已转为只读观察");

    scene.control = "controlling";
    view = await paint();
    expect(view.textContent).toContain("notice:已取得控制权");
    scene.control = "takeover_failed";
    scene.executions = [
      execution({ executionId: "exec-other", resultKind: "message", state: "running" }),
    ];
    view = await paint();
    expect(view.textContent).toContain("notice:已取得控制权");
    scene.roomId = "room-2";
    scene.room = room({ id: "room-2" });
    view = await paint();
    expect(view.textContent).toContain("notice:");
    expect(view.textContent).not.toContain("已取得控制权");
  });
});
