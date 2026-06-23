import type { Agent, Message, Room } from "@/models";
import Dexie, { type Table } from "dexie";

export class CouncilKitDB extends Dexie {
  rooms!: Table<Room, string>;
  agents!: Table<Agent, string>;
  messages!: Table<Message, string>;

  constructor() {
    super("councilkit");
    this.version(1).stores({
      rooms: "id, status, lastActiveAt",
      agents: "id, roomId, model",
      messages: "id, roundId, senderId",
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
