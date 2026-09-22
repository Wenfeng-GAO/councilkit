import { fetchRepairEventDetail } from "@/runtime/repair-observation-client";
import type { RepairEventDetail, RepairOperation } from "@shared/runtime/repair-observation";
import { type RefObject, useEffect, useRef, useState } from "react";
import { activityPresentation, roleName } from "./presentation";
import { IconCopy, IconX } from "./icons";

export function RepairEventDrawer({
  open,
  runId,
  operation,
  onClose,
  returnFocus,
  workspaceTitleRef,
}: {
  open: boolean;
  runId: string;
  operation: RepairOperation | null;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  workspaceTitleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const drawerTitleRef = useRef<HTMLHeadingElement>(null);
  const [detail, setDetail] = useState<RepairEventDetail | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      drawerTitleRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open || !operation) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void fetchRepairEventDetail({ runId, eventId: operation.eventId })
      .then((row) => {
        if (!cancelled) setDetail(row);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, operation, runId]);

  const handleClose = () => {
    onClose();
    window.requestAnimationFrame(() => {
      if (returnFocus?.isConnected) {
        returnFocus.focus();
        return;
      }
      workspaceTitleRef.current?.focus();
    });
  };

  const copy = async () => {
    const text = detail?.body ?? operation?.summary ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    window.setTimeout(() => setCopied(null), 1600);
  };

  return (
    <dialog
      ref={dialogRef}
      className="ck-repair-drawer"
      data-testid="repair-event-drawer"
      onClose={handleClose}
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
    >
      <div className="ck-repair-drawer-panel">
        <header className="ck-repair-drawer-header">
          <h2 tabIndex={-1} ref={drawerTitleRef} className="ck-repair-drawer-title">
            {operation ? activityPresentation(operation).title : "活动详情"}
          </h2>
          <button
            type="button"
            className="ck-repair-icon-btn"
            aria-label="关闭详情"
            onClick={handleClose}
          >
            <IconX />
          </button>
        </header>
        {operation ? (
          <div className="ck-repair-drawer-body">
            <p className="ck-repair-meta">
              {roleName(operation.roleKey)} · {activityPresentation(operation).status}
            </p>
            <details className="ck-repair-raw-detail">
              <summary>原始记录与执行身份</summary>
              <p className="ck-repair-meta">{operation.executionRef}</p>
              <pre className="ck-repair-code">{operation.summary}</pre>
            </details>
            <pre className="ck-repair-code">{detail?.body ?? operation.summary}</pre>
            {detail?.truncated ? (
              <p className="ck-repair-meta">输出已截断，可继续分页读取。</p>
            ) : null}
            <div className="ck-repair-drawer-actions">
              <button
                type="button"
                className="ck-repair-btn"
                data-testid="repair-copy"
                onClick={() => void copy()}
              >
                <IconCopy />{" "}
                {copied === "ok" ? "已复制" : copied === "fail" ? "复制失败，请手动选择" : "复制"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
