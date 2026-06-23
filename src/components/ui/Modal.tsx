import { type ReactNode, useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <dialog
        open
        aria-modal="true"
        className="w-full max-w-md rounded border border-edge bg-surface p-5"
      >
        {title ? <h2 className="mb-3 text-base font-semibold">{title}</h2> : null}
        {children}
        <button type="button" onClick={onClose} className="mt-4 text-sm text-muted hover:text-fg">
          关闭
        </button>
      </dialog>
    </div>
  );
}
