import type {
  AgentStatus,
  ModelType,
  RoomStatus,
  RoundStatus,
  SenderType,
  ValidationResult,
} from "@/types";
import { validateAgent } from "./agent";
import type { Agent } from "./agent";
import { validateMessage } from "./message";
import type { Message } from "./message";
import { validateRoom } from "./room";
import type { Room } from "./room";
import { validateRound } from "./round";
import type { Round, Summary } from "./round";

export type { Agent, Message, Round, Room, Summary };
export { validateAgent, validateMessage, validateRound, validateRoom };

function now(): number {
  return Date.now();
}

function uuid(): string {
  return crypto.randomUUID();
}

function assertValid(result: ValidationResult, entity: string): void {
  if (!result.ok) {
    throw new Error(`Invalid ${entity}: ${result.errors.join("; ")}`);
  }
}

export interface CreateRoomInput {
  topic: string;
  agentIds: string[];
  status?: RoomStatus;
}

export function createRoom(input: CreateRoomInput): Room {
  const room: Room = {
    id: uuid(),
    topic: input.topic,
    createdAt: now(),
    lastActiveAt: now(),
    agentIds: input.agentIds,
    roundIds: [],
    status: input.status ?? "idle",
  };
  assertValid(validateRoom(room), "Room");
  return room;
}

export interface CreateAgentInput {
  model: ModelType;
  role: string;
  color: string;
  status?: AgentStatus;
  roomId?: string;
}

export function createAgent(input: CreateAgentInput): Agent {
  const agent: Agent = {
    id: uuid(),
    model: input.model,
    role: input.role,
    color: input.color,
    roomId: input.roomId,
    status: input.status ?? "online",
  };
  assertValid(validateAgent(agent), "Agent");
  return agent;
}

export interface CreateMessageInput {
  senderId: string;
  senderType: SenderType;
  content: string;
  roundId: string;
}

export function createMessage(input: CreateMessageInput): Message {
  const message: Message = {
    id: uuid(),
    senderId: input.senderId,
    senderType: input.senderType,
    content: input.content,
    roundId: input.roundId,
    timestamp: now(),
  };
  assertValid(validateMessage(message), "Message");
  return message;
}

export interface CreateRoundInput {
  roundNumber: number;
  roomId: string;
  status?: RoundStatus;
}

export function createRound(input: CreateRoundInput): Round {
  const round: Round = {
    id: uuid(),
    roundNumber: input.roundNumber,
    roomId: input.roomId,
    messageIds: [],
    status: input.status ?? "active",
  };
  assertValid(validateRound(round), "Round");
  return round;
}

export interface CreateSummaryInput {
  roundId: string;
  content: string;
  model: ModelType;
}

export function createSummary(input: CreateSummaryInput): Summary {
  return {
    id: uuid(),
    roundId: input.roundId,
    content: input.content,
    generatedAt: now(),
    model: input.model,
  };
}
