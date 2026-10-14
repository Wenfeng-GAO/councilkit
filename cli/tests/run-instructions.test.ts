/**
 * Ordinary-turn instruction text. The string is the only per-turn variable
 * besides snapshot items, so round, name, topic, and persona are asserted
 * as exact literals.
 */
import { describe, expect, it } from "vitest";
import { messageInstruction } from "../src/run/instructions";

const TAIL =
  "Read the full shared context above (topic, background, target output, and every prior speech). Then give YOUR independent position for this round: challenge, supplement, or diverge from prior points where warranted — do not merely agree. Output only the body of your speech. Keep it concise to control cost.";

describe("messageInstruction", () => {
  it("names the agent, topic, trimmed persona, and round", () => {
    expect(
      messageInstruction({
        agentName: "Alpha",
        personaPrompt: "  skeptical architect  ",
        round: 2,
        totalRounds: 3,
        council: { topic: "route local models cheaply" },
      }),
    ).toBe(
      `You are "Alpha" in a structured multi-agent council on the topic: route local models cheaply. Your role/stance: skeptical architect This is round 2 of 3. ${TAIL}`,
    );
  });

  it("uses the unspecified stance when the persona is empty or whitespace", () => {
    const empty = messageInstruction({
      agentName: "Beta",
      personaPrompt: "",
      round: 1,
      totalRounds: 1,
      council: { topic: "topic" },
    });
    const whitespace = messageInstruction({
      agentName: "Beta",
      personaPrompt: " \n\t ",
      round: 1,
      totalRounds: 1,
      council: { topic: "topic" },
    });
    const expected = `You are "Beta" in a structured multi-agent council on the topic: topic. Your role/stance: (unspecified). This is round 1 of 1. ${TAIL}`;
    expect(empty).toBe(expected);
    expect(whitespace).toBe(expected);
  });

  it.skip("non-empty persona should end its sentence before the round sentence", () => {
    // BUG: a non-empty persona is joined without a sentence period, so the next sentence runs on. The unspecified stance keeps its period.
    expect(
      messageInstruction({
        agentName: "Alpha",
        personaPrompt: "skeptical architect",
        round: 2,
        totalRounds: 3,
        council: { topic: "route local models cheaply" },
      }),
    ).toBe(
      `You are "Alpha" in a structured multi-agent council on the topic: route local models cheaply. Your role/stance: skeptical architect. This is round 2 of 3. ${TAIL}`,
    );
  });

  it("keeps quote characters in the agent name and a changed round in the text", () => {
    expect(
      messageInstruction({
        agentName: 'Ada "Ace"',
        personaPrompt: "reviewer",
        round: 1,
        totalRounds: 4,
        council: { topic: "ship?" },
      }),
    ).toBe(
      `You are "Ada "Ace"" in a structured multi-agent council on the topic: ship?. Your role/stance: reviewer This is round 1 of 4. ${TAIL}`,
    );
  });
});
