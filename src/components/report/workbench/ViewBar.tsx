import { reviewSeatTitle } from "@/lib/seat-label";
import { type KeyboardEvent, useRef, useState } from "react";
import { CopyIcon } from "./icons";
import type { SeatViewTab, WorkbenchAttempt, WorkbenchSelection } from "./selection";

const TABS: Array<{ id: SeatViewTab; label: string }> = [
  { id: "report", label: "报告" },
  { id: "process", label: "过程" },
];

interface ViewBarProps {
  /** 视图栏左侧职责名（总览/当前修复/席位名）。 */
  title: string;
  /** 选中席位时提供报告/过程 Tab；总览/修复视图为 null（Tab 隐藏）。 */
  attempt: WorkbenchAttempt | null;
  tab: SeatViewTab;
  onTabChange: (tab: SeatViewTab) => void;
  mobileSelect: {
    value: WorkbenchSelection;
    onChange: (value: WorkbenchSelection) => void;
    seats: WorkbenchAttempt[];
    aggregators: WorkbenchAttempt[];
    hasRepair: boolean;
  };
  /** 返回 null 表示当前视图没有可复制内容（按钮禁用）。 */
  getCopyText: () => string | null;
  onExplain?: () => void;
}

/**
 * 48px 视图栏。Tab 使用 roving tabindex + 方向键（ArrowLeft/ArrowRight/Home/End），
 * 行为照 WORKBENCH-PREVIEW。≤900px 时席位列收起，本栏出现 <select>（与桌面同一选择器）。
 */
export function ViewBar({
  title,
  attempt,
  tab,
  onTabChange,
  mobileSelect,
  getCopyText,
  onExplain,
}: ViewBarProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [copied, setCopied] = useState(false);

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onTabChange(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const copy = async () => {
    const text = getCopyText();
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const copyText = getCopyText();

  return (
    <div className="ck-wb-viewbar">
      <div className="ck-wb-view-left">
        <span className="ck-wb-view-name">{title}</span>
        <select
          className="ck-wb-mobile-seat"
          aria-label="选择视图或席位"
          value={mobileSelect.value}
          onChange={(event) => mobileSelect.onChange(event.target.value)}
        >
          <option value="overview">本轮总览</option>
          {mobileSelect.hasRepair ? (
            <optgroup label="当前修复">
              <option value="repair">当前修复</option>
            </optgroup>
          ) : null}
          <optgroup label="审查席位">
            {mobileSelect.seats.map((seat) => (
              <option key={seat.attemptId} value={seat.attemptId}>
                {reviewSeatTitle(seat)}
              </option>
            ))}
          </optgroup>
          {mobileSelect.aggregators.length > 0 ? (
            <optgroup label="汇总">
              {mobileSelect.aggregators.map((seat) => (
                <option key={seat.attemptId} value={seat.attemptId}>
                  {reviewSeatTitle(seat)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        {attempt ? (
          <div className="ck-wb-tabs" role="tablist" aria-label="席位视图">
            {TABS.map((item, index) => (
              <button
                key={item.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`ck-wb-tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls={`ck-wb-panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => onTabChange(item.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="ck-wb-view-actions">
        {onExplain ? (
          <button type="button" className="ck-wb-ghost" onClick={onExplain}>
            理解评审
          </button>
        ) : null}
        <button
          type="button"
          className="ck-wb-ghost"
          aria-label="复制当前内容"
          disabled={copyText === null}
          title={copyText === null ? "当前没有可复制的内容" : undefined}
          onClick={() => void copy()}
        >
          <CopyIcon className="ck-wb-icon" />
          <span className="ck-wb-copy-label">{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
    </div>
  );
}
