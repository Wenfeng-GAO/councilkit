import { deriveRoomReadiness } from "@/app/pages/NewRoomPage";
import { UsageBadge, aggregateUsage } from "@/components/room/UsageBadge";
import {
  isFailedExecution,
  isSkippedFailure,
  resolveSpeaker,
  roomRunStateLabel,
  roomRunStateTone,
} from "@/components/room/round-timeline";
import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/Button";
import type {
  DiscussionAgent,
  DiscussionMode,
  DiscussionRoom,
  DiscussionRound,
  Participant,
} from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import { type ExecutionProfileRecord, toDto } from "@/models/execution-profile";
import { getAppRuntime } from "@/runtime/bootstrap";
import { RuntimeClientError } from "@/runtime/client";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import { useControlState, useRoomIntents } from "@/stores/runtime-intents";
import {
  useActiveRuntimeBindings,
  useExecutionProfiles,
  useRoomRecoveryFacts,
} from "@/stores/runtime-queries";
import { type ProfileReadinessState, QUOTAS } from "@shared/runtime/contracts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";

interface RoomHeaderProps {
  room: DiscussionRoom;
  /** All Participants of the Room; only active ones are shown in the strip. */
  participants: Participant[];
  agents: DiscussionAgent[];
}

/** The display label for a discussion mode (S4 badge). Local constant,
 * mirroring the RoomListItem RUN_STATE_PILL precedent. */
export const ROOM_MODE_PILL: Record<DiscussionMode, string> = {
  brainstorm: "头脑风暴",
  planning: "规划",
  review: "评审",
};

/** Pure label for a discussion mode (unit-tested). */
export function roomModeLabel(mode: DiscussionMode): string {
  return ROOM_MODE_PILL[mode];
}

/** S5 release-runtime gate: a pure function over the same controller / live-
 * execution / active-round facts the orchestrator guards on. Exported for unit
 * testing (the parseMaxRoundsInput precedent). `warm === false` hides the
 * button upstream; this gate only decides whether a warm room may be released.
 *
 * V4: the active-round fact is `hasUnresolvedActiveRound` — a round whose phase
 * is NOT terminal (completed/aborted), mirroring the orchestrator V1 guard.
 * Pre-fix this was `hasInFlightRound` (prewarming/running/summarizing only),
 * which let a paused/pending round through and stranded its recovery path. */
export function deriveReleaseGate(input: {
  controlling: boolean;
  warm: boolean;
  hasLiveExecution: boolean;
  hasUnresolvedActiveRound: boolean;
}): { allowed: boolean; reason?: string } {
  if (input.hasLiveExecution) return { allowed: false, reason: "有执行进行中" };
  if (input.hasUnresolvedActiveRound) return { allowed: false, reason: "当前轮次进行中" };
  if (!input.controlling) return { allowed: false, reason: "当前页面没有控制权" };
  if (!input.warm) return { allowed: true, reason: "运行时未预热" };
  return { allowed: true };
}

const LIVE_EXECUTION_STATES = new Set(["prepared", "running", "succeeded_uncommitted"]);
const TERMINAL_ROUND_PHASES = new Set(["completed", "aborted"]);

/** Map a round phase to "unresolved active round" (V1/V4 mirror of the
 * orchestrator releaseRuntime guard): anything outside completed/aborted
 * blocks release. Exported for direct unit coverage of every phase. */
export function isUnresolvedActiveRoundPhase(phase: DiscussionRound["phase"]): boolean {
  return !TERMINAL_ROUND_PHASES.has(phase);
}

// ---------------------------------------------------------------------------
// S8 Participant 本轮状态条（纯推导，零新增状态机）：四态是对 participantOrder
// 的干净划分——activeExecution 指向本人且 live → generating；本轮有 committed
// message → done；终态失败 message + 无 committed → 复用 isSkippedFailure 判
// skipped/failed；其余 waiting。无需显式 cursor 比较（plan-a §1.2 单测断言等价）。
// ---------------------------------------------------------------------------

export type ParticipantRoundStatus = "waiting" | "generating" | "done" | "failed" | "skipped";

export const PARTICIPANT_STATUS_LABELS: Record<ParticipantRoundStatus, string> = {
  waiting: "等待中",
  generating: "生成中",
  done: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

/** Derive one Participant's status in the active round (S8). Returns null when
 * there is no active round or the Participant is not in its order (between
 * rounds / late joiners) so the strip renders only the name. 规则见上方分节。 */
export function deriveParticipantRoundStatus(input: {
  participantId: string;
  round: DiscussionRound | null;
  /** Room executions; the function filters to the active round internally. */
  executions: readonly ModelExecution[];
  /** Room rounds, for the isSkippedFailure cursor lookup（与时间线「· 已跳过」
   * 标记同口径）。 */
  rounds: readonly DiscussionRound[];
}): ParticipantRoundStatus | null {
  const { participantId, round, executions, rounds } = input;
  if (!round || !round.participantOrder.includes(participantId)) return null;

  const roundExecutions = executions.filter((execution) => execution.roundId === round.id);

  // generating：activeExecution 指向本人且 live。覆盖发言中、summarizing 与
  // focus 阶段的 facilitator（其 summary/focus execution 的 participantId 即
  // facilitator）；terminal 态的 activeExecution 不计（落入后续规则）。
  const activeExecution = round.activeExecutionId
    ? roundExecutions.find((execution) => execution.executionId === round.activeExecutionId)
    : undefined;
  if (
    activeExecution &&
    activeExecution.participantId === participantId &&
    LIVE_EXECUTION_STATES.has(activeExecution.state)
  ) {
    return "generating";
  }

  // done：本轮存在 committed message。focus 的 committedEntityType 虽为 message
  // 但 resultKind="focus"，不会把 facilitator 误判 done。
  const hasCommittedMessage = roundExecutions.some(
    (execution) =>
      execution.participantId === participantId &&
      execution.resultKind === "message" &&
      execution.state === "committed",
  );
  if (hasCommittedMessage) return "done";

  // failed/skipped：终态失败 message + 无 committed —— isSkippedFailure 同口径
  // （cursor 已越过 → skipped；未越过 → failed）。
  const failedMessageExecution = roundExecutions.find(
    (execution) =>
      execution.participantId === participantId &&
      execution.resultKind === "message" &&
      isFailedExecution(execution),
  );
  if (failedMessageExecution) {
    return isSkippedFailure(failedMessageExecution, rounds, executions) ? "skipped" : "failed";
  }

  return "waiting";
}

/** Room header (U6): topic, runState + mode + status pills (text labels, not
 * color-only), the active Participant strip, and (S5) a self-wired warm/cold
 * runtime indicator with a release button + quota hint. Self-wired so RoomPage
 * needs no change; the tick is read the same way RoomPage does. */
export function RoomHeader({ room, participants, agents }: RoomHeaderProps) {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const participantsById = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const active = participants.filter((participant) => participant.state === "active");

  // S5 self-wired runtime control state (RoomPage is untouched). The tick is
  // read straight from the discussion store (same as RoomPage:129-131).
  const tick = useRuntimeDiscussionStore((state) =>
    state.changeTickByRoom[room.id] ? state.changeTickByRoom[room.id] : 0,
  );
  const controlState = useControlState(room.id);
  const intents = useRoomIntents(room.id);
  const { data: recovery } = useRoomRecoveryFacts(room.id, tick);
  const { data: activeBindings } = useActiveRuntimeBindings(tick);

  // warm = the room's latest non-closed binding is active with a scope id.
  const roomBindings = (recovery?.bindings ?? []).filter((binding) => binding.roomId === room.id);
  const latestNonClosed = roomBindings.length
    ? roomBindings.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    : undefined;
  const dexieWarm = !!latestNonClosed?.executionScopeId && latestNonClosed?.state === "active";

  // V4 warm/配额权威化：Dexie 显示为 active 的 binding 可能与 Host 实际 scope
  // 状态不同步(Host 侧重启/被 reap 后本地仍 active)。挂载或 roomId 变化时,对全
  // 局 active 且带 executionScopeId 的 binding(最多 maxActiveScopes 个,并行)逐个
  // getScopeStatus;返回非 active/404 的在显示层按 cold 处理(只影响显示与配额计数,
  // 不改写 Dexie——ensureScope 收敛路径不动)。查询失败(Host 离线)保持 Dexie 口径。
  //
  // 三态权威集(#2):`null` = 查询中(回退 Dexie 口径,避免冷启动闪烁);`Set`(含空集)
  // = 查询完成,以其为准——空集表示"查完全 cold",此时 Dexie 仍 active 的 binding 应
  // 显示 cold 并退出配额计数(不再像旧版被回退成 warm)。warm 判定与配额计数只在完成态
  // 用查询结果;查询中沿用 Dexie 口径。
  //
  // 抗重渲染(#1):直接对 `activeBindings`(fetch 间引用稳定)做 useMemo,冻结本次结果
  // 的 scopeId 列表;effect 依赖该稳定列表(内容相同 → 同一引用 → 不重跑)。effect 写
  // 状态前做集合相等比较,内容相同不 setState,杜绝「setState→重渲染→新数组→effect 重跑」
  // 循环。无 binding 时早退且不写状态(保留上一轮完成态,不反复写空集)。
  const activeScopedKey = (activeBindings ?? [])
    .filter((binding) => binding.state === "active" && binding.executionScopeId)
    .map((binding) => binding.executionScopeId as string)
    .sort()
    .join("\n");
  // 内容键稳定化:sort+join 的字符串按值相等——refetch 换了 activeBindings 数组引用
  // 但内容相同时 key 相等 → memo 不重算 → effect 不重跑(避免 tick 驱动的 Dexie 刷新
  // 引发 Host 探针风暴);仅内容真实变化才产生新 ids 数组。就绪位同样按值稳定
  // (undefined→defined 只翻转一次),合并进 probeInput 使 effect 依赖全部内容化。
  const bindingsReady = activeBindings !== undefined;
  const probeInput = useMemo(
    () => ({
      ids: activeScopedKey.length > 0 ? activeScopedKey.split("\n") : [],
      ready: bindingsReady,
    }),
    [activeScopedKey, bindingsReady],
  );
  // null = 查询中(Dexie 口径);Set = 查询完成(权威,空集=全 cold)。初值 null:首屏
  // 尚未查询过,沿用 Dexie 口径,避免冷启动误显 cold。
  const [authoritativeWarmScopeIds, setAuthoritativeWarmScopeIds] = useState<Set<string> | null>(
    null,
  );
  useEffect(() => {
    // bindings 查询未就绪:保持查询中(null)——不能把尚未探针的空集写成
    // 权威完成态,否则加载期误显 cold、配额误计(末次复核 P1-a)。
    if (!probeInput.ready) {
      setIfChanged(setAuthoritativeWarmScopeIds, null);
      return;
    }
    const probeIds = probeInput.ids.slice(0, QUOTAS.maxActiveScopes);
    if (probeIds.length === 0) {
      // 查询已就绪且确无 active-scoped binding:完成态空集(全 cold / 无可查)。集合相等
      // 比较由 setIfChanged 统一处理,内容相同不 setState,避免无 binding 时反复写空集。
      setIfChanged(setAuthoritativeWarmScopeIds, new Set());
      return;
    }
    // 新一组 id 的探针开始:先回到查询中(null),防止上一组 id 的旧 Set 被当作当前
    // 权威集(末次复核 P1-b)。
    setIfChanged(setAuthoritativeWarmScopeIds, null);
    let cancelled = false;
    void Promise.all(
      probeIds.map(async (scopeId) => {
        try {
          const status = await getAppRuntime().client.getScopeStatus(scopeId);
          return status.state === "active" ? scopeId : null;
        } catch (error) {
          // 404: Host 已无此 scope → 按 cold 处理。其它失败(Host 离线/网络):
          // 保持 Dexie 口径——把该 scopeId 当作仍 warm(回归 Dexie 显示),避免一次
          // 瞬态网络抖动误把 warm 房间显示成 cold。残余窗口:页面开着期间被 reap
          // 的 scope 不会触发此 effect 重新查询;下一轮 startRound 或重新进房自愈。
          if (error instanceof RuntimeClientError && error.status === 404) return null;
          return scopeId;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      // 完成态:以查询结果为准(含空集 = 全 cold)。集合相等比较避免无谓重渲染。
      setIfChanged(
        setAuthoritativeWarmScopeIds,
        new Set(results.filter((id): id is string => id !== null)),
      );
    });
    return () => {
      cancelled = true;
    };
    // probeInput 引用稳定(内容键 + 就绪位均按值相等)→ effect 只在 id 集合或就绪态
    // 真实变化时重跑。tick 不入依赖:它驱动 Dexie 重读,集合变化已由 probeInput 体现,
    // 避免高频轮询 Host。
  }, [probeInput]);

  /** 内容相等才 setState:新旧 Set 元素相同则不更新,截断「setState→重渲染→effect
   * 重跑」的循环(#1)。新旧任一为 null(查询中)时直接写入——null→Set 是状态推进,
   * 不存在循环。 */
  function setIfChanged(
    setter: Dispatch<SetStateAction<Set<string> | null>>,
    next: Set<string> | null,
  ): void {
    setter((prev) => {
      if (prev instanceof Set && next instanceof Set && setsEqual(prev, next)) {
        return prev; // 内容相同:保留旧引用,不触发重渲染
      }
      return next;
    });
  }
  function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const id of a) if (!b.has(id)) return false;
    return true;
  }

  const authorityReady = authoritativeWarmScopeIds !== null;
  const isAuthoritativelyWarm = (scopeId: string | null | undefined): boolean => {
    if (!scopeId || !authorityReady) return false;
    return authoritativeWarmScopeIds.has(scopeId);
  };
  // 查询中(authorityReady=false)→ 沿用 Dexie 口径;查询完成 → 以权威集为准(空集=全 cold)。
  const warm = authorityReady
    ? dexieWarm && isAuthoritativelyWarm(latestNonClosed?.executionScopeId)
    : dexieWarm;

  const activeScopeCount = authorityReady
    ? (activeBindings ?? []).filter(
        (binding) =>
          binding.state === "active" &&
          binding.executionScopeId &&
          isAuthoritativelyWarm(binding.executionScopeId),
      ).length
    : (activeBindings ?? []).filter(
        (binding) => binding.state === "active" && binding.executionScopeId,
      ).length;
  const maxActiveScopes = QUOTAS.maxActiveScopes;

  const roomExecutions = (recovery?.executions ?? []).filter(
    (execution) => execution.roomId === room.id,
  );
  // S7: 房间头部累计用量（裁决 #6 口径含 discarded/failed；全 null 时组件不渲染）。
  const roomUsageTotals = aggregateUsage(roomExecutions);
  const hasLiveExecution = roomExecutions.some((execution) =>
    LIVE_EXECUTION_STATES.has(execution.state),
  );
  const activeRound = room.activeRoundId
    ? (recovery?.rounds ?? []).find((round) => round.id === room.activeRoundId)
    : undefined;
  // V4: 镜像 orchestrator V1 — 终态(completed/aborted)外的活动轮都视为未解决。
  const hasUnresolvedActiveRound = activeRound
    ? isUnresolvedActiveRoundPhase(activeRound.phase)
    : false;

  const controlling = controlState === "controlling";
  const gate = deriveReleaseGate({
    controlling,
    warm,
    hasLiveExecution,
    hasUnresolvedActiveRound,
  });
  const release = intents.releaseRuntime;
  const releasePending = release.isPending;
  const releaseDisabled = !gate.allowed || releasePending;
  const nearQuota = activeScopeCount >= maxActiveScopes - 1;

  // S8 预检 badge（计划 §1.4）：active participants 的 (executionProfileId,
  // modelId 快照) 去重探针，复用 Settings 的 readiness 握手口径（host 60s 缓存、
  // retry:false、staleTime:30s）。derived problems → warn pill；全 ready → success
  // pill「此房间可运行」。concluded 不渲染。建议性，不阻塞操作。
  // 仅 controlling 页渲染并探针：observer 页不渲染——§578「observer 只发 GET」
  // 的只读契约禁止 observer 触发 Host 探针工作，且「可运行」提示面向可行动者。
  const client = useMemo(() => getAppRuntime().client, []);
  const healthQuery = useQuery({
    queryKey: ["host", "health"],
    queryFn: () => client.health(),
    refetchInterval: 5000,
    retry: false,
  });
  const hostOnline = healthQuery.isPending ? null : healthQuery.isSuccess;
  const profilesQuery = useExecutionProfiles();
  const profiles = useMemo(() => profilesQuery.data ?? [], [profilesQuery.data]);
  // pairs 去重：(profileId, modelId)。badge 只探参与本轮的 profile × 该快照 modelId。
  const readinessPairs = useMemo(() => {
    const seen = new Set<string>();
    const pairs: { profileId: string; modelId: string }[] = [];
    for (const participant of active) {
      const key = `${participant.executionProfileId}::${participant.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ profileId: participant.executionProfileId, modelId: participant.modelId });
    }
    return pairs;
  }, [active]);
  const readinessQueries = useQueries({
    queries: readinessPairs.map((pair) => {
      const profile = profiles.find((candidate) => candidate.id === pair.profileId);
      return {
        queryKey: [
          "host",
          "profile-readiness",
          pair.profileId,
          profile?.revision ?? 0,
          pair.modelId,
        ],
        // enabled 门控 profile 存在；queryFn 内 current 必非空，as 断言安全
        // （避免 noNonNullAssertion）。
        queryFn: () => {
          const current = profiles.find(
            (candidate) => candidate.id === pair.profileId,
          ) as ExecutionProfileRecord;
          return client.profileReadiness(toDto(current), pair.modelId);
        },
        enabled: controlling && hostOnline === true && !!profile,
        staleTime: 30_000,
        retry: false,
      };
    }),
  });
  const roomReadiness = useMemo(() => {
    const profileStates: { name: string; state: ProfileReadinessState | undefined }[] =
      readinessPairs.map((pair, index) => {
        const profile = profiles.find((candidate) => candidate.id === pair.profileId);
        // R3：Host 离线时 readiness 查询 enabled=false 停用，但 TanStack 保留旧成功
        // 缓存 → 离线后仍显绿。派生输入在 hostOnline!==true 时归一到 undefined，落入
        // deriveRoomReadiness 既有「就绪状态未知」分支，避免沿用过期缓存。
        return {
          name: profile?.name ?? "未知 Profile",
          state: hostOnline === true ? readinessQueries[index]?.data?.readiness?.state : undefined,
        };
      });
    return deriveRoomReadiness({
      agentCount: active.length,
      facilitatorChosen: participants.some((p) => p.id === room.facilitatorParticipantId),
      profiles: profileStates,
    });
  }, [
    readinessPairs,
    readinessQueries,
    profiles,
    active.length,
    participants,
    room.facilitatorParticipantId,
    hostOnline,
  ]);

  return (
    <header className="border-b border-edge px-6 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="break-words text-lg font-semibold text-fg">{room.topic}</h1>
        <StatusPill tone="muted" text={ROOM_MODE_PILL[room.mode]} />
        <StatusPill
          tone={roomRunStateTone(room.runState)}
          text={roomRunStateLabel(room.runState)}
        />
        {room.status === "concluded" ? <StatusPill tone="success" text="已结束" /> : null}
        {warm ? (
          <StatusPill tone="info" text="运行时已预热" />
        ) : (
          <StatusPill tone="muted" text="运行时未预热" />
        )}
        <span data-testid="scope-quota" className="text-xs text-muted">
          运行时 {activeScopeCount}/{maxActiveScopes}
        </span>
        <UsageBadge totals={roomUsageTotals} />
        {nearQuota ? <StatusPill tone="warn" text="接近运行时上限，建议先释放不用的房间" /> : null}
        {controlling && room.status !== "concluded" ? (
          <span
            data-testid="room-readiness"
            className="inline-flex flex-wrap items-center gap-1.5 text-xs"
          >
            {roomReadiness.ready ? (
              <StatusPill tone="success" text="此房间可运行" />
            ) : (
              <>
                <StatusPill tone="warn" text="此房间未就绪" />
                <span className="text-muted">
                  {roomReadiness.problems.map((problem) => problem.message).join("；")}
                </span>
              </>
            )}
          </span>
        ) : null}
        {warm ? (
          <Button
            variant="ghost"
            onClick={() => release.mutate()}
            disabled={releaseDisabled}
            title={gate.reason}
          >
            释放运行时
          </Button>
        ) : null}
      </div>
      {release.error ? (
        <p className="mt-1 text-xs text-error" role="alert">
          释放运行时失败：{release.error.message}
        </p>
      ) : null}
      {active.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="参与者">
          {active.map((participant) => {
            const speaker = resolveSpeaker(participant.id, participantsById, agentsById);
            const status = deriveParticipantRoundStatus({
              participantId: participant.id,
              round: activeRound ?? null,
              executions: recovery?.executions ?? [],
              rounds: recovery?.rounds ?? [],
            });
            const statusLabel = status ? PARTICIPANT_STATUS_LABELS[status] : null;
            return (
              <li
                key={participant.id}
                tabIndex={statusLabel ? 0 : undefined}
                aria-label={statusLabel ? `${speaker.name}：${statusLabel}` : speaker.name}
                className="flex items-center gap-1.5 rounded border border-edge bg-surface px-2 py-1 text-xs text-fg"
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: speaker.color }}
                  aria-hidden="true"
                />
                {speaker.name}
                {statusLabel ? <span className="text-muted">· {statusLabel}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </header>
  );
}
