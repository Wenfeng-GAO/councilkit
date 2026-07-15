import type { Agent, Gateway, Message, Room, Round, Summary } from "@/models";
import Dexie, { type Table } from "dexie";

export class CouncilKitDB extends Dexie {
  rooms!: Table<Room, string>;
  agents!: Table<Agent, string>;
  messages!: Table<Message, string>;
  rounds!: Table<Round, string>;
  summaries!: Table<Summary, string>;
  gateways!: Table<Gateway, string>;

  constructor() {
    super("councilkit");
    this.version(1).stores({
      rooms: "id, status, lastActiveAt",
      agents: "id, roomId, model",
      messages: "id, roundId, senderId",
      rounds: "id, roomId, roundNumber",
      summaries: "id, roundId",
    });
    this.version(2).stores({
      rooms: "id, status, lastActiveAt",
      agents: "id, roomId, model",
      messages: "id, roundId, senderId",
      rounds: "id, roomId, roundNumber",
      summaries: "id, roundId",
      gateways: "id, type",
    });
    // v3: 为 gateways 增加 createdAt 索引 —— listGateways() 用 orderBy("createdAt")，
    // Dexie 要求 orderBy 的字段必须是索引列，否则抛 OrderByError 导致列表查询失败、
    // 保存成功却看不到网关。
    this.version(3).stores({
      rooms: "id, status, lastActiveAt",
      agents: "id, roomId, model",
      messages: "id, roundId, senderId",
      rounds: "id, roomId, roundNumber",
      summaries: "id, roundId",
      gateways: "id, type, createdAt",
    });
  }
}

export const db = new CouncilKitDB();

export async function addRoom(room: Room): Promise<string> {
  return db.rooms.add(room);
}

export async function getRoom(id: string): Promise<Room | undefined> {
  return db.rooms.get(id);
}

export async function addMessage(message: Message): Promise<string> {
  return db.messages.add(message);
}

export async function getMessagesByRound(roundId: string): Promise<Message[]> {
  return db.messages.where("roundId").equals(roundId).toArray();
}

export async function addAgent(agent: Agent): Promise<string> {
  return db.agents.add(agent);
}

export async function getAgentsByRoom(roomId: string): Promise<Agent[]> {
  return db.agents.where("roomId").equals(roomId).toArray();
}

export async function listRooms(): Promise<Room[]> {
  return db.rooms.orderBy("lastActiveAt").reverse().toArray();
}

export async function getRoundsByRoom(roomId: string): Promise<Round[]> {
  return db.rounds.where("roomId").equals(roomId).toArray();
}

export async function getSummary(roundId: string): Promise<Summary | undefined> {
  return db.summaries.where("roundId").equals(roundId).first();
}

export async function addGateway(gateway: Gateway): Promise<string> {
  return db.gateways.add(gateway);
}

export async function getGateway(id: string): Promise<Gateway | undefined> {
  return db.gateways.get(id);
}

export async function listGateways(): Promise<Gateway[]> {
  return db.gateways.orderBy("createdAt").toArray();
}

export async function updateGateway(
  id: string,
  changes: Partial<Omit<Gateway, "id">>,
): Promise<number> {
  return db.gateways.update(id, changes);
}

export async function deleteGateway(id: string): Promise<void> {
  await db.gateways.delete(id);
}
