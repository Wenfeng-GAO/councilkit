import type { ModelType, RoundStatus, ValidationResult } from "@/types";

export interface Round {
  id: string;
  roundNumber: number;
  roomId: string;
  messageIds: string[];
  summaryId?: string;
  status: RoundStatus;
}

export interface Summary {
  id: string;
  roundId: string;
  content: string;
  generatedAt: number;
  model: ModelType;
}

export function validateRound(round: Round): ValidationResult {
  const errors: string[] = [];
  if (round.roundNumber < 1) errors.push("roundNumber must be >= 1");
  if (round.roomId.length === 0) errors.push("roomId must be non-empty");
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
