import type { SenderType, ValidationResult } from "@/types";

export interface Message {
  id: string;
  senderId: string;
  senderType: SenderType;
  content: string;
  roundId: string;
  timestamp: number;
}

export function validateMessage(message: Message): ValidationResult {
  const errors: string[] = [];
  if (message.content.length === 0) {
    errors.push("content must be non-empty");
  }
  if (message.senderType === "user" && message.senderId !== "user") {
    errors.push('senderId must be "user" when senderType is "user"');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
