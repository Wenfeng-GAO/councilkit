import { runtimeDb } from "@/lib/runtime-db";
import { useQuery } from "@tanstack/react-query";

/**
 * Read-side query hooks over the runtime Dexie DB (U5). Committed page state
 * comes exclusively from Dexie — these hooks never trigger execution; the
 * Orchestrator drives all mutations and bumps the invalidation tick.
 */

export const runtimeKeys = {
  rooms: ["rt-rooms"] as const,
  room: (id: string) => ["rt-room", id] as const,
  rounds: (roomId: string) => ["rt-rounds", roomId] as const,
  round: (roundId: string) => ["rt-round", roundId] as const,
  messages: (roundId: string) => ["rt-messages", roundId] as const,
  participants: (roomId: string) => ["rt-participants", roomId] as const,
  executions: (roundId: string) => ["rt-executions", roundId] as const,
  agents: ["rt-agents"] as const,
  profiles: ["rt-profiles"] as const,
};

export function useRuntimeRooms(tick = 0) {
  return useQuery({
    queryKey: [...runtimeKeys.rooms, tick],
    queryFn: () => runtimeDb.rooms.orderBy("lastActiveAt").reverse().toArray(),
  });
}

export function useRuntimeRoom(roomId: string | undefined, tick = 0) {
  return useQuery({
    queryKey: roomId ? [...runtimeKeys.room(roomId), tick] : ["rt-room", "none"],
    enabled: !!roomId,
    queryFn: () => runtimeDb.rooms.get(roomId as string),
  });
}

export function useRuntimeRounds(roomId: string | undefined, tick = 0) {
  return useQuery({
    queryKey: roomId ? [...runtimeKeys.rounds(roomId), tick] : ["rt-rounds", "none"],
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
    queryKey: roundId ? [...runtimeKeys.messages(roundId), tick] : ["rt-messages", "none"],
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
    queryKey: roundId ? ["rt-summary", roundId, tick] : ["rt-summary", "none"],
    enabled: !!roundId,
    queryFn: () =>
      runtimeDb.summaries
        .where("roundId")
        .equals(roundId as string)
        .first(),
  });
}

export function useParticipants(roomId: string | undefined, tick = 0) {
  return useQuery({
    queryKey: roomId ? [...runtimeKeys.participants(roomId), tick] : ["rt-participants", "none"],
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
    queryKey: roundId ? [...runtimeKeys.executions(roundId), tick] : ["rt-executions", "none"],
    enabled: !!roundId,
    queryFn: () =>
      runtimeDb.modelExecutions
        .where("roundId")
        .equals(roundId as string)
        .toArray(),
  });
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
