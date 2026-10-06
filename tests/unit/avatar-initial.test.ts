import { AgentConfigCard } from "@/components/agent/AgentConfigCard";
import { MessageBubble } from "@/components/message/MessageBubble";
import type { DiscussionAgent } from "@/models/discussion/entities";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const EMOJI_NAME = "😀审查员";

function avatarText(html: string): string {
  const match = /aria-hidden="true">([^<]*)</.exec(html);
  if (!match || match[1] === undefined) throw new Error(`avatar span missing: ${html}`);
  return match[1];
}

const agent: DiscussionAgent = {
  id: "agent-1",
  name: EMOJI_NAME,
  personaPrompt: "审查",
  executionProfileId: "profile-1",
  modelId: "model-a",
  color: "#112233",
  revision: 1,
  enabled: true,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
};

describe("avatar initials", () => {
  it("keeps a leading emoji whole in a discussion bubble", () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        name: EMOJI_NAME,
        color: "#112233",
        content: "结论",
      }),
    );
    expect(avatarText(html)).toBe("😀");
    expect(html).toContain(EMOJI_NAME);
  });

  it("keeps a leading emoji whole on an agent card", () => {
    const html = renderToStaticMarkup(createElement(AgentConfigCard, { agent }));
    expect(avatarText(html)).toBe("😀");
    expect(html).toContain(EMOJI_NAME);
  });

  it("keeps a single BMP character as the initial", () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { name: "安", color: "#112233", content: "好" }),
    );
    expect(avatarText(html)).toBe("安");
  });
});
