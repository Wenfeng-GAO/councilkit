import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import type { DiscussionMessage } from "@/models/discussion/entities";
import type { ControlState } from "@/orchestrator/discussion-orchestrator";
import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";

interface UserInputBarProps {
  controlState: ControlState | undefined;
  hasActiveRound: boolean;
  sendUserMessage: UseMutationResult<DiscussionMessage, Error, string, unknown>;
}

/**
 * User message bar (U6): enabled only for the Scope Controller page while an
 * active Round exists. The disabled reason is always visible as helper text.
 * Sending while the Round is paused is allowed (the message bumps the shared
 * context; an in-flight result would then discard as stale_context — by
 * design, no special-casing here).
 */
export function UserInputBar({ controlState, hasActiveRound, sendUserMessage }: UserInputBarProps) {
  const [text, setText] = useState("");

  const controlling = controlState === "controlling";
  const disabledReason = !controlling
    ? controlState === "observing"
      ? "只读观察中，无法发言（另一页面正在控制）"
      : "当前页面没有控制权，无法发言"
    : !hasActiveRound
      ? "两轮之间不能发言，请先开始新一轮"
      : sendUserMessage.isPending
        ? "发送中…"
        : null;
  const disabled = disabledReason !== null;
  const errorMessage = sendUserMessage.error?.message ?? null;
  const help = disabledReason ?? errorMessage;

  return (
    <form
      className="mx-auto flex w-full max-w-3xl items-start gap-2 px-6 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        const content = text.trim();
        if (disabled || content.length === 0) return;
        sendUserMessage.mutateAsync(content).then(
          () => setText(""),
          () => undefined, // error surfaced below via mutation state
        );
      }}
    >
      <TextInput
        className="flex-1"
        placeholder="以参与者身份发言或追问…"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (sendUserMessage.error) sendUserMessage.reset();
        }}
        disabled={disabled}
        aria-label="用户发言"
        help={help}
      />
      <Button type="submit" disabled={disabled || text.trim().length === 0}>
        {sendUserMessage.isPending ? "发送中…" : "发送"}
      </Button>
    </form>
  );
}
