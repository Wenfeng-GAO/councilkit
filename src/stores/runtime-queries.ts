import { runtimeDb } from "@/lib/runtime-db";
import type { DecisionReport, DiscussionRound } from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

/**
 * Read-side query hooks over the runtime Dexie DB (U5). Committed page state
 * comes exclusively from Dexie — these hooks never trigger execution; the
 * Orchestrator drives all mutations and bumps the invalidation tick.
 *
 * Tick-keyed hooks keep the previous result across an invalidation tick.
 * Without that placeholder the data would transiently go undefined —
 * unmounting round sections mid-render and, worse, flipping RoomPage's
 * roomExists guard so its Web-Lock effect releases/re-takes control in the
 * middle of an in-flight Round (STALE_CONTROLLER).
 *
 * Hooks scoped to one room or round use keepScopedPlaceholder, not
 * keepPreviousData. A scope-id change must not keep rendering the previous
 * entity until the next fetch resolves. Unscoped lists still use
 * keepPreviousData, because their only key change is the tick.
 */

export const runtimeKeys = {
  /** Shared root: invalidateQueries({ queryKey: runtimeKeys.all }) refetches
   * every runtime query (the Orchestrator's display bridge uses it). */
  all: ["rt"] as const,
  rooms: ["rt", "rooms"] as const,
  room: (id: string) => ["rt", "room", id] as const,
  rounds: (roomId: string) => ["rt", "rounds", roomId] as const,
  round: (roundId: string) => ["rt", "round", roundId] as const,
  messages: (roundId: string) => ["rt", "messages", roundId] as const,
  summary: (roundId: string) => ["rt", "summary", roundId] as const,
  participants: (roomId: string) => ["rt", "participants", roomId] as const,
  executions: (roundId: string) => ["rt", "executions", roundId] as const,
  report: (roomId: string) => ["rt", "report", roomId] as const,
  recovery: (roomId: string) => ["rt", "recovery", roomId] as const,
  agents: ["rt", "agents"] as const,
  profiles: ["rt", "profiles"] as const,
};

/**
 * Scope id position in `["rt", collection, scopeId, tick?]` and in the idle
 * `["rt", collection, "none"]` keys. A tick lives in the last segment, never here.
 */
const RUNTIME_SCOPE_KEY_INDEX = 2;

/**
 * Keep the previous rows when an invalidation tick changes the query key.
 * Drop them when the scope id changes, so room A's discussion is not what
 * room B renders while B's read is in flight.
 */
export function keepScopedPlaceholder<T>(scopeId: string | undefined) {
  return (
    previousData: T | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): T | undefined => {
    if (previousData === undefined || previousQuery === undefined) return undefined;
    if (previousQuery.queryKey[RUNTIME_SCOPE_KEY_INDEX] !== scopeId) return undefined;
    return previousData;
  };
}

export function useRuntimeRooms(tick = 0) {
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [...runtimeKeys.rooms, tick],
    queryFn: () => runtimeDb.rooms.orderBy("lastActiveAt").reverse().toArray(),
  });
}

export function useRuntimeRoom(roomId: string | undefined, tick = 0) {
  return useQuery({
    placeholderData: keepScopedPlaceholder(roomId),
    queryKey: roomId ? [...runtimeKeys.room(roomId), tick] : ["rt", "room", "none"],
    enabled: !!roomId,
    // Dexie returns undefined when the row is missing. TanStack Query v5
    // rejects undefined data and retries, so RoomPage stays on 加载中…
    queryFn: async () => (await runtimeDb.rooms.get(roomId as string)) ?? null,
  });
}

export function useRuntimeRounds(roomId: string | undefined, tick = 0) {
  return useQuery({
    placeholderData: keepScopedPlaceholder(roomId),
    queryKey: roomId ? [...runtimeKeys.rounds(roomId), tick] : ["rt", "rounds", "none"],
    enabled: !!roomId,
    queryFn: async () => {
      const rounds = await runtimeDb.rounds
        .where("roomId")
        .equals(roomId as string)
        .toArray();
      return rounds.sort((a, b) => a.roundNumber - b.roundNumber);
    },
  });
}

export function useRoundMessages(roundId: string | undefined, tick = 0) {
  return useQuery({
    placeholderData: keepScopedPlaceholder(roundId),
    queryKey: roundId ? [...runtimeKeys.messages(roundId), tick] : ["rt", "messages", "none"],
    enabled: !!roundId,
    queryFn: async () => {
      const messages = await runtimeDb.messages
        .where("roundId")
        .equals(roundId as string)
        .toArray();
      return messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },
  });
}

export function useRoundSummary(roundId: string | undefined, tick = 0) {
  return useQuery({
    placeholderData: keepScopedPlaceholder(roundId),
    queryKey: roundId ? [...runtimeKeys.summary(roundId), tick] : ["rt", "summary", "none"],
    enabled: !!roundId,
    queryFn: async () =>
      (await runtimeDb.summaries
        .where("roundId")
        .equals(roundId as string)
        .first()) ?? null,
  });
}

export function useParticipants(roomId: string | undefined, tick = 0) {
  return useQuery({
    placeholderData: keepScopedPlaceholder(roomId),
    queryKey: roomId ? [...runtimeKeys.participants(roomId), tick] : ["rt", "participants", "none"],
    enabled: !!roomId,
    queryFn: async () => {
      const participants = await runtimeDb.participants
        .where("roomId")
        .equals(roomId as string)
        .toArray();
      return participants.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    },
  });
}

export function useRoundExecutions(roundId: string | undefined, tick = 0) {
  return useQuery({
    placeholderData: keepScopedPlaceholder(roundId),
    queryKey: roundId ? [...runtimeKeys.executions(roundId), tick] : ["rt", "executions", "none"],
    enabled: !!roundId,
    queryFn: () =>
      runtimeDb.modelExecutions
        .where("roundId")
        .equals(roundId as string)
        .toArray(),
  });
}

/** The Room's committed decision report (S2, one per room). Null while no
 * report has landed yet; the read never triggers execution — the Orchestrator
 * commits the report and bumps the invalidation tick. */
export function useRoomReport(roomId: string | undefined, tick = 0) {
  return useQuery({
    placeholderData: keepScopedPlaceholder(roomId),
    queryKey: roomId ? [...runtimeKeys.report(roomId), tick] : ["rt", "report", "none"],
    enabled: !!roomId,
    queryFn: async () =>
      (await runtimeDb.reports
        .where("roomId")
        .equals(roomId as string)
        .first()) ?? null,
    // keepScopedPlaceholder withholds another room. select still rejects a row
    // whose roomId does not match this query.
    select: (report) => guardRoomScopedReport(report, roomId),
  });
}

/** Room-level recovery facts (S3): the terminal executions + bindings history +
 * rounds that the rotation-entry display, the skip badge, and the retry count
 * derive from. A read-only hook mirroring useRoomReport — the Orchestrator owns
 * every write and bumps the invalidation tick. */
export interface RoomRecoveryFacts {
  executions: ModelExecution[];
  bindings: RuntimeBinding[];
  rounds: DiscussionRound[];
}

export function useRoomRecoveryFacts(roomId: string | undefined, tick = 0) {
  return useQuery({
    placeholderData: keepScopedPlaceholder(roomId),
    queryKey: roomId ? [...runtimeKeys.recovery(roomId), tick] : ["rt", "recovery", "none"],
    enabled: !!roomId,
    queryFn: async () => {
      const id = roomId as string;
      const [executions, bindings, rounds] = await Promise.all([
        runtimeDb.modelExecutions.where("roomId").equals(id).toArray(),
        runtimeDb.runtimeBindings.where("roomId").equals(id).toArray(),
        runtimeDb.rounds.where("roomId").equals(id).toArray(),
      ]);
      return { executions, bindings, rounds } satisfies RoomRecoveryFacts;
    },
    // keepScopedPlaceholder withholds another room. select still drops foreign
    // rows in a mixed payload and passes a same-room payload through.
    select: (facts) => filterRoomScopedFacts(facts, roomId),
  });
}

/** F3 pure guard: return the report only when it belongs to the queried room.
 * Exported so the cross-room invariant is unit-testable without standing up a
 * QueryClient + fake-indexeddb hook harness (the parseMaxRoundsInput precedent). */
export function guardRoomScopedReport(
  report: DecisionReport | null | undefined,
  roomId: string | undefined,
): DecisionReport | null | undefined {
  // Preserve null (no row) versus undefined (not passed). A cross-room
  // mismatch still becomes undefined so the previous room's body is not shown.
  if (!report) return report;
  if (roomId === undefined || report.roomId !== roomId) return undefined;
  return report;
}

/** F3 pure guard: zero out every recovery array unless all entries belong to
 * the queried room. Same export rationale as guardRoomScopedReport. */
export function filterRoomScopedFacts(
  facts: RoomRecoveryFacts,
  roomId: string | undefined,
): RoomRecoveryFacts {
  if (roomId === undefined) {
    return { executions: [], bindings: [], rounds: [] };
  }
  const isRoom = (id: string): boolean => id === roomId;
  const executions = facts.executions.filter((execution) => isRoom(execution.roomId));
  const bindings = facts.bindings.filter((binding) => isRoom(binding.roomId));
  const rounds = facts.rounds.filter((round) => isRoom(round.roomId));
  // Only a stale (cross-room) placeholder gets filtered to empty; a same-room
  // facts object passes through intact.
  if (
    executions.length === facts.executions.length &&
    bindings.length === facts.bindings.length &&
    rounds.length === facts.rounds.length
  ) {
    return facts;
  }
  return { executions, bindings, rounds };
}

export function useAgents() {
  return useQuery({
    queryKey: runtimeKeys.agents,
    queryFn: () => runtimeDb.agents.toArray(),
  });
}

export function useExecutionProfiles() {
  return useQuery({
    queryKey: runtimeKeys.profiles,
    queryFn: () => runtimeDb.executionProfiles.toArray(),
  });
}

/** Active warm runtime bindings across all rooms (S5): the RoomHeader quota
 * indicator counts these against QUOTAS.maxActiveScopes. A read-only mirror of
 * the recovery facts hook — the Orchestrator owns every write and bumps the
 * invalidation tick, which re-keys this via runtimeKeys.all. */
export function useActiveRuntimeBindings(tick = 0) {
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: [...["rt", "active-bindings"], tick] as const,
    queryFn: () =>
      runtimeDb.runtimeBindings.filter((binding) => binding.state === "active").toArray(),
  });
}
