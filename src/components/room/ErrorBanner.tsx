import { useEffect, useState } from "react";

interface ErrorBannerProps {
  /** Untrusted error text (mutation/Host failure); null hides the banner. */
  message: string | null;
  onDismiss: () => void;
}

/**
 * Dismissible mutation-error banner (U6). The message is rendered as a plain
 * React text node (untrusted input), wraps on narrow viewports, and announces
 * via role="alert". Reappears whenever a new error arrives.
 */
export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  const [visible, setVisible] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset visibility on each new message
  useEffect(() => {
    setVisible(true);
  }, [message]);

  if (!message || !visible) return null;

  return (
    <div
      role="alert"
      className="border-b border-error bg-error/10 px-6 py-3 text-sm text-fg"
      data-testid="error-banner"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="break-words leading-snug">{message}</p>
        <button
          type="button"
          aria-label="关闭"
          onClick={() => {
            setVisible(false);
            onDismiss();
          }}
          className="shrink-0 text-muted hover:text-fg"
        >
          ×
        </button>
      </div>
    </div>
  );
}
