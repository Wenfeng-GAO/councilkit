import {
  type InlineGatewayInfo,
  formatGatewayOfflineInline,
  formatInlineBody,
  formatInlineHeader,
} from "@/lib/round-errors";
import type { Agent, Message } from "@/models";
import type { GatewayError } from "@/types";
import ReactMarkdown from "react-markdown";

interface MessageBubbleProps {
  message: Message;
  agent?: Agent;
  /** 本轮该 agent 遭遇的 GatewayError（可选）；存在则在 content 下方渲染 inline block。 */
  error?: GatewayError;
  /** 对应 gateway 的 name/baseUrl，注入 formatInlineBody 文案。 */
  gateway?: InlineGatewayInfo;
  /** D-11 propagation 标记 —— true 时使用 formatGatewayOfflineInline 文案。 */
  errorPropagated?: boolean;
}

export function MessageBubble({
  message,
  agent,
  error,
  gateway,
  errorPropagated = false,
}: MessageBubbleProps) {
  const isUser = message.senderType === "user";
  const name = isUser ? "你" : (agent?.role ?? "agent");
  const color = isUser ? "#8b919a" : (agent?.color ?? "#6366f1");

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium text-white"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        >
          {name.slice(0, 1)}
        </span>
        <span className="text-sm font-medium text-fg">{name}</span>
        <span className="text-xs text-muted">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>
      <div className="ml-8 text-sm leading-relaxed text-fg">
        <ReactMarkdown>{message.content}</ReactMarkdown>
      </div>
      {renderInlineError(error, gateway, errorPropagated)}
    </div>
  );
}

function renderInlineError(
  error: GatewayError | undefined,
  gateway: InlineGatewayInfo | undefined,
  propagated: boolean,
) {
  if (!error) return null;

  let header: string;
  let body: string;
  // fatal (invalid_key 且非 propagation) → 红；recoverable → 黄；propagation → 红（同 fatal 调性）
  const isError = error.kind === "invalid_key";

  if (propagated) {
    const fmt = formatGatewayOfflineInline();
    header = fmt.header;
    body = fmt.body(gateway?.name ?? "未知网关");
  } else {
    header = formatInlineHeader(error);
    body = formatInlineBody(error, gateway);
  }

  const toneClass = isError ? "border border-error bg-error/10" : "border border-warn bg-warn/10";

  return (
    // biome-ignore lint/a11y/useSemanticElements: inline status block needs div + explicit role for AT
    <div role="status" className={`ml-8 mt-2 rounded p-2 ${toneClass}`} data-testid="inline-error">
      <p className="text-sm font-semibold leading-snug text-fg">{header}</p>
      <p className="text-xs leading-snug text-fg">{body}</p>
    </div>
  );
}
