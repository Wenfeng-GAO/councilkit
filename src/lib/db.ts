import type { Agent, Message, Room, Round, Summary } from "@/models";
import Dexie, { type Table } from "dexie";

export class CouncilKitDB extends Dexie {
  rooms!: Table<Room, string>;
  agents!: Table<Agent, string>;
  messages!: Table<Message, string>;
  rounds!: Table<Round, string>;
  summaries!: Table<Summary, string>;

  constructor() {
    super("councilkit");
    this.version(1).stores({
      rooms: "id, status, lastActiveAt",
      agents: "id, roomId, model",
      messages: "id, roundId, senderId",
      rounds: "id, roomId, roundNumber",
      summaries: "id, roundId",
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
