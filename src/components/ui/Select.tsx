import type { SelectHTMLAttributes } from "react";

interface Option {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Option[];
}

export function Select({ label, options, className = "", id, ...rest }: SelectProps) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      {label ? <span className="text-muted">{label}</span> : null}
      <select
        id={id}
        className={`rounded border border-edge bg-surface px-3 py-2 text-fg outline-none focus:border-accent ${className}`}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
