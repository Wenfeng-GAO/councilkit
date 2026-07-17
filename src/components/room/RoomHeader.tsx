import {
  resolveSpeaker,
  roomRunStateLabel,
  roomRunStateTone,
} from "@/components/room/round-timeline";
import { StatusPill } from "@/components/shared/StatusPill";
import type { DiscussionAgent, DiscussionRoom, Participant } from "@/models/discussion/entities";

interface RoomHeaderProps {
  room: DiscussionRoom;
  /** All Participants of the Room; only active ones are shown in the strip. */
  participants: Participant[];
  agents: DiscussionAgent[];
}

/** Room header (U6): topic, runState pill (text label, not color-only) and
 * the active Participant strip. */
export function RoomHeader({ room, participants, agents }: RoomHeaderProps) {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const participantsById = new Map(
    participants.map((participant) => [participant.id, participant]),
  );
  const active = participants.filter((participant) => participant.state === "active");

  return (
    <header className="border-b border-edge px-6 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="break-words text-lg font-semibold text-fg">{room.topic}</h1>
        <StatusPill
          tone={roomRunStateTone(room.runState)}
          text={roomRunStateLabel(room.runState)}
        />
      </div>
      {active.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="参与者">
          {active.map((participant) => {
            const speaker = resolveSpeaker(participant.id, participantsById, agentsById);
            return (
              <li
                key={participant.id}
                className="flex items-center gap-1.5 rounded border border-edge bg-surface px-2 py-1 text-xs text-fg"
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: speaker.color }}
                  aria-hidden="true"
                />
                {speaker.name}
              </li>
            );
          })}
        </ul>
      ) : null}
    </header>
  );
}
