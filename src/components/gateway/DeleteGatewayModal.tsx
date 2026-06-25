import { Modal } from "@/components/ui/Modal";
import type { Gateway } from "@/models";
import { useEffect, useRef } from "react";

interface DeleteGatewayModalProps {
  open: boolean;
  gateway: Gateway | null;
  agentCount: number;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * 删除网关确认。focus 默认落在「取消」（安全选择）；ESC 走 Modal 内置。
 */
export function DeleteGatewayModal({
  open,
  gateway,
  agentCount,
  onClose,
  onConfirm,
}: DeleteGatewayModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      // 等下一帧确保 dialog 已挂载
      const id = window.setTimeout(() => cancelRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={`删除网关「${gateway?.name ?? ""}」？`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg">
          该网关下 {agentCount} 个 agent 的 gatewayId
          将被清空并标记为离线。密钥将从本机删除。此操作不可撤销。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            ref={cancelRef}
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded border border-edge px-3 py-2 text-sm font-medium text-fg transition hover:bg-surface"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-10 items-center justify-center rounded bg-error px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            删除
          </button>
        </div>
      </div>
    </Modal>
  );
}
