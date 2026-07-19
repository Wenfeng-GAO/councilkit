import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TextInput } from "@/components/ui/TextInput";
import type { DiscussionMessage } from "@/models/discussion/entities";
import type { ControlState } from "@/orchestrator/discussion-orchestrator";
import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";

interface UserInputBarProps {
  controlState: ControlState | undefined;
  hasActiveRound: boolean;
  /** True while the room is concluding (a report is in flight or the conclude
   * mutation is pending) — user input is locked out until the report lands or
   * fails, mirroring the same lockout the operation row applies to the
   * "start round" button. */
  concluding: boolean;
  /** S8：本轮正在生成（按真实 live execution 判定：activeExecutionId 非空且对应
   * execution state ∈ prepared/running/succeeded_uncommitted，与
   * deriveParticipantRoundStatus 的 generating 同源）。提交时若为 true 先开中断确认
   * Modal——本次生成的结果会因上下文过期（stale_context）被丢弃、不写入讨论
   * 记录，需用户显式确认。 */
  roundGenerating?: boolean;
  sendUserMessage: UseMutationResult<DiscussionMessage, Error, string, unknown>;
}

/**
 * User message bar (U6): enabled only for the Scope Controller page while an
 * active Round exists. The disabled reason is always visible as helper text.
 *
 * S8：发送本轮正在生成中的消息会令在途生成的结果因上下文过期（stale_context）
 * 被丢弃且不写入讨论记录——非静默，提交时若 `roundGenerating` 为 true 先弹中断
 * 确认 Modal（标题「发送将中断当前生成」），用户确认后才真正发送；取消则放弃
 * 本次发送、保留输入框内容。
 */
export function UserInputBar({
  controlState,
  hasActiveRound,
  concluding,
  roundGenerating,
  sendUserMessage,
}: UserInputBarProps) {
  const [text, setText] = useState("");
  // S8 中断确认：暂存待发送内容，确认后才提交。
  const [confirmInterruptOpen, setConfirmInterruptOpen] = useState(false);
  const [pendingContent, setPendingContent] = useState<string | null>(null);

  const controlling = controlState === "controlling";
  const disabledReason = !controlling
    ? controlState === "observing"
      ? "只读观察中，无法发言（另一页面正在控制）"
      : "当前页面没有控制权，无法发言"
    : concluding
      ? "报告生成中，无法发言"
      : !hasActiveRound
        ? "两轮之间不能发言，请先开始新一轮"
        : sendUserMessage.isPending
          ? "发送中…"
          : null;
  const disabled = disabledReason !== null;
  const errorMessage = sendUserMessage.error?.message ?? null;
  const help = disabledReason ?? errorMessage;

  const submitContent = (content: string) => {
    sendUserMessage.mutateAsync(content).then(
      () => setText(""),
      () => undefined, // error surfaced below via mutation state
    );
  };

  const closeConfirmInterrupt = () => {
    setConfirmInterruptOpen(false);
    setPendingContent(null);
  };

  return (
    <>
      <form
        className="mx-auto flex w-full max-w-3xl items-start gap-2 px-6 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          const content = text.trim();
          if (disabled || content.length === 0) return;
          // S8：本轮生成中首次提交 → 开中断确认 Modal，暂不发送。
          if (roundGenerating) {
            setPendingContent(content);
            setConfirmInterruptOpen(true);
            return;
          }
          submitContent(content);
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
      <Modal open={confirmInterruptOpen} onClose={closeConfirmInterrupt} title="发送将中断当前生成">
        <p className="text-sm text-fg">
          当前正在生成，发送后本次生成的结果将因上下文过期（stale_context）被丢弃、不写入讨论记录。确定发送？
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={closeConfirmInterrupt}>
            取消
          </Button>
          <Button
            onClick={() => {
              const content = pendingContent;
              setConfirmInterruptOpen(false);
              setPendingContent(null);
              if (content) submitContent(content);
            }}
          >
            确认发送
          </Button>
        </div>
      </Modal>
    </>
  );
}
