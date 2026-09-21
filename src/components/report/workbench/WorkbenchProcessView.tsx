import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import {
  type TimelineBlock,
  displayToolName,
  formatElapsed,
  formatSpan,
  hasUnmatchedFence,
  isJsonDeliverable,
  shortenActivityPath,
  unwrapShellSummary,
} from "@/lib/live-transcript";
import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, CircleXIcon } from "./icons";
import { PROCESS_WINDOW_STEP, type WorkbenchProcessState } from "./useWorkbenchProcess";
/**
 * 席位过程 Tab 内容（WORKSPACE-STATES §4 文案）。轮询/跟随状态由
 * useWorkbenchProcess 提供；本组件只负责渲染与滚动定位（钉底、回到最新）。
 */
export function WorkbenchProcessView({
  state,
  getScroller,
  onViewReport,
}: {
  state: WorkbenchProcessState;
  getScroller: () => HTMLElement | null;
  onViewReport: () => void;
}) {
  const { windowBlocks, hiddenCount, showEarlier } = state;
  const origin = windowBlocks[0]?.at ?? "";
  const lastIndex = windowBlocks.length - 1;
  const jumpTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (jumpTimerRef.current !== undefined) window.clearTimeout(jumpTimerRef.current);
    };
  }, []);

  const jumpToLatest = () => {
    // 滚动到底部即触发 hook 的 scroll 监听恢复跟随；这里只做定位。
    const el = getScroller();
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  // ---- 空态与错误态（WORKSPACE-STATES §4） ----
  const errorNotice = state.readError ? (
    <output className="ck-wb-notice ck-wb-notice-warn">
      <CircleXIcon className="ck-wb-icon ck-wb-icon-state" />
      {state.hasEvents ? "过程读取失败，已保留读取内容" : "过程暂时无法读取"}
      <button type="button" className="ck-wb-statusbar-action" onClick={state.retry}>
        重新读取
      </button>
    </output>
  ) : null;

  if (!state.ready) {
    return (
      <div role="tabpanel" id="ck-wb-panel-process" aria-labelledby="ck-wb-tab-process">
        {errorNotice}
        <p className="ck-wb-source">读取过程…</p>
      </div>
    );
  }

  if (!state.hasEvents) {
    return (
      <div role="tabpanel" id="ck-wb-panel-process" aria-labelledby="ck-wb-tab-process">
        {errorNotice}
        <p className="ck-wb-source">{state.done ? "暂无可读取的过程记录" : "等待首条记录"}</p>
      </div>
    );
  }

  // ---- 跟随通知（INTERACTION-SPEC §4.4：席位完成只提示，不自动切 Tab） ----
  let followNotice: { text: string; action: string; onClick: () => void } | null = null;
  if (state.reportReady) {
    followNotice = { text: "报告已就绪", action: "查看报告", onClick: onViewReport };
  } else if (!state.pinned && state.newCount > 0) {
    followNotice = {
      text: `新增 ${state.newCount} 条活动`,
      action: "回到最新",
      onClick: jumpToLatest,
    };
  }

  return (
    <div role="tabpanel" id="ck-wb-panel-process" aria-labelledby="ck-wb-tab-process">
      {errorNotice}
      {state.truncated ? (
        <output className="ck-wb-notice ck-wb-notice-warn">
          过程记录已截断，当前展示已保存内容
        </output>
      ) : null}
      {state.done ? <p className="ck-wb-source">该席位已保存过程 · 版本未单独记录</p> : null}
      {hiddenCount > 0 ? (
        <p className="ck-wb-source">
          <button type="button" className="ck-wb-ghost" onClick={showEarlier}>
            已隐藏较早 {hiddenCount} 条 · 显示更早 {Math.min(PROCESS_WINDOW_STEP, hiddenCount)} 条
          </button>
        </p>
      ) : null}
      <div className="ck-wb-events">
        {windowBlocks.map((block, index) => (
          <ProcessRow
            key={`${block.kind}-${index}`}
            block={block}
            origin={origin}
            streaming={!state.done && index === lastIndex}
          />
        ))}
      </div>
      {followNotice ? (
        <div className="ck-wb-follow-bar">
          <output>{followNotice.text}</output>
          <button type="button" className="ck-wb-ghost" onClick={followNotice.onClick}>
            {followNotice.action}
            {followNotice.action === "回到最新" ? <ArrowDownIcon className="ck-wb-icon" /> : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ProcessRow({
  block,
  origin,
  streaming,
}: {
  block: TimelineBlock;
  origin: string;
  streaming: boolean;
}) {
  const tick =
    block.kind === "tool" || block.kind === "truncated" ? formatElapsed(origin, block.at) : "";
  return (
    <div className="ck-wb-event">
      <time aria-hidden="true">{tick}</time>
      <div className="ck-wb-event-body">
        <ProcessBlock block={block} streaming={streaming} />
      </div>
    </div>
  );
}

function ProcessBlock({
  block,
  streaming,
}: {
  block: TimelineBlock;
  streaming: boolean;
}) {
  if (block.kind === "truncated") {
    return <p className="ck-wb-source">过程输出已截断（丢弃 {block.dropped} 条增量）</p>;
  }
  if (block.kind === "thinking") {
    const n = Array.from(block.text).length;
    return (
      <details className="ck-wb-think">
        <summary>思考 · {n} 字</summary>
        <pre>{block.text}</pre>
      </details>
    );
  }
  if (block.kind === "tool") {
    const span = block.endAt ? formatSpan(block.at, block.endAt) : "";
    const summary = shortenActivityPath(unwrapShellSummary(block.summary));
    return (
      <div className="ck-wb-tool">
        <p className="ck-wb-tool-head">
          <span className="ck-wb-tool-name">{displayToolName(block.name)}</span>
          <span className="ck-wb-tool-status">
            {block.status === "started" ? "进行中" : "完成"}
            {span ? ` · ${span}` : ""}
          </span>
          {summary ? <CopyCommandButton text={summary} /> : null}
        </p>
        {summary ? <code className="ck-wb-tool-cmd">{summary}</code> : null}
      </div>
    );
  }
  // text
  if (streaming && hasUnmatchedFence(block.text)) {
    return <pre className="ck-wb-text-pre">{block.text}</pre>;
  }
  if (isJsonDeliverable(block.text)) {
    return <pre className="ck-wb-text-pre">{block.text}</pre>;
  }
  return <SafeMarkdown className="ck-wb-text" variant="document" content={block.text} />;
}

function CopyCommandButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, []);
  return (
    <button
      type="button"
      className="ck-wb-statusbar-action"
      aria-label="复制命令"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => setCopied(false), 1600);
          },
          () => setCopied(false),
        );
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}
