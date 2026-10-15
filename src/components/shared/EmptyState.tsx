import { renderInlineCode } from "./InlineCode";

interface EmptyStateProps {
  title: string;
  hint?: string;
}

/** `title` / `hint` may mark commands with backticks; they render as code (#318). */
export function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-base font-medium text-fg">{renderInlineCode(title)}</p>
      {hint ? <p className="text-sm text-muted">{renderInlineCode(hint)}</p> : null}
    </div>
  );
}
