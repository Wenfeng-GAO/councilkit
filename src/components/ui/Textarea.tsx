import type { TextareaHTMLAttributes } from "react";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export function Textarea({ label, className = "", id, ...rest }: TextareaProps) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      {label ? <span className="text-muted">{label}</span> : null}
      <textarea
        id={id}
        className={`rounded border border-edge bg-surface px-3 py-2 text-fg outline-none focus:border-accent ${className}`}
        {...rest}
      />
    </label>
  );
}
