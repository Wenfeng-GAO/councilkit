import type { InputHTMLAttributes, ReactNode } from "react";

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** 行下副文案（12px muted 说明，常见于表单字段提示）。 */
  help?: ReactNode;
}

export function TextInput({ label, help, className = "", id, ...rest }: TextInputProps) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      {label ? <span className="text-muted">{label}</span> : null}
      <input
        id={id}
        className={`rounded border border-edge bg-surface px-3 py-2 text-fg outline-none focus:border-accent ${className}`}
        {...rest}
      />
      {help ? <span className="text-xs text-muted">{help}</span> : null}
    </label>
  );
}
