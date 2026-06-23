import type { InputHTMLAttributes } from "react";

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function TextInput({ label, className = "", id, ...rest }: TextInputProps) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      {label ? <span className="text-muted">{label}</span> : null}
      <input
        id={id}
        className={`rounded border border-edge bg-surface px-3 py-2 text-fg outline-none focus:border-accent ${className}`}
        {...rest}
      />
    </label>
  );
}
