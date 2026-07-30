/**
 * Ordinary-turn instruction (plan-a §5). The CLI discussion has no per-round
 * summary, no convergence vote, no facilitator — each agent reads the full
 * shared context and speaks independently once per round. The instruction text
 * is the ONLY per-turn variable besides the snapshot items, so a different
 * round/role ⇒ different text ⇒ different `instructionDigest` (the digest's
 * sole inputs are wire kind + text).
 *
 * Sync-point: the browser's `src/orchestrator/discussion-instructions.ts`
 * MESSAGE_TEMPLATES encode mode-specific guidance; the CLI ships a single
 * discuss-mode message template (V1.1 `workflow.discuss_mode = discuss`).
 */
import type { CouncilSnapshot } from "./types";

/** Build the ordinary-turn instruction text. Names the round, the agent's
 * persona, and requires reading the full context before an independent speech. */
export function messageInstruction(input: {
  agentName: string;
  personaPrompt: string;
  round: number;
  totalRounds: number;
  council: Pick<CouncilSnapshot, "topic">;
}): string {
  const persona = input.personaPrompt.trim();
  return [
    `You are "${input.agentName}" in a structured multi-agent council on the topic: ${input.council.topic}.`,
    persona.length > 0 ? `Your role/stance: ${persona}` : "Your role/stance: (unspecified).",
    `This is round ${input.round} of ${input.totalRounds}.`,
    "Read the full shared context above (topic, background, target output, and every prior speech).",
    "Then give YOUR independent position for this round: challenge, supplement, or diverge from prior points where warranted — do not merely agree.",
    "Output only the body of your speech. Keep it concise to control cost.",
  ].join(" ");
}
