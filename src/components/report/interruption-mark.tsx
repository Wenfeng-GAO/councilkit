import type { ReactNode } from "react";
import { CirclePauseIcon } from "./workbench/icons";

/** Shared amber token. The list's former `--color-warn` hex now lives here. */
export const INTERRUPTION_COLOR_TOKEN = "--ck-interrupt";
export const INTERRUPTION_ICON = "circle-pause";

export function InterruptionMark({
  children,
  iconClassName = "ck-wb-icon ck-wb-icon-state",
}: {
  children?: ReactNode;
  iconClassName?: string;
}) {
  return (
    <span
      className="ck-interrupt-mark"
      data-interrupt-token={INTERRUPTION_COLOR_TOKEN}
      data-interrupt-icon={INTERRUPTION_ICON}
    >
      <CirclePauseIcon className={iconClassName} />
      {children}
    </span>
  );
}
