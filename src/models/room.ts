import type { RoomStatus, ValidationResult } from "@/types";

export interface Room {
  id: string;
  topic: string;
  createdAt: number;
  lastActiveAt: number;
  agentIds: string[];
  roundIds: string[];
  status: RoomStatus;
}

export function validateRoom(room: Room): ValidationResult {
  const errors: string[] = [];
  if (room.topic.length === 0) {
    errors.push("topic must be non-empty");
  }
  if (room.topic.length > 200) {
    errors.push("topic length must be <= 200");
  }
  if (room.agentIds.length < 1) {
    errors.push("agentIds must contain at least 1 agent");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
