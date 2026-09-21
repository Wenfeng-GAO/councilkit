import { type ComponentType, useEffect, useRef } from "react";
import { NavLink } from "react-router-dom";
import { type WorkbenchHostStatus, hostStatusLabel } from "./host-status";
import {
  FilesIcon,
  HouseIcon,
  LayoutListIcon,
  LightbulbIcon,
  MessageSquarePlusIcon,
  Settings2Icon,
  type WorkbenchIconProps,
} from "./icons";

type IconComponent = ComponentType<WorkbenchIconProps>;

interface WorkbenchNavItem {
  to: string;
  label: string;
  Icon: IconComponent;
  end?: boolean;
}

/** 链接与 AppShell 现有导航一致（首页/新建讨论/产品创意/报告/设置）。 */
export const WORKBENCH_NAV_ITEMS: WorkbenchNavItem[] = [
  { to: "/", label: "首页", Icon: HouseIcon, end: true },
  { to: "/rooms/new", label: "新建讨论", Icon: MessageSquarePlusIcon },
  { to: "/ideate", label: "产品创意", Icon: LightbulbIcon },
  { to: "/reports", label: "报告", Icon: FilesIcon },
  { to: "/settings", label: "设置", Icon: Settings2Icon },
];

export function WorkbenchNav({ hostStatus }: { hostStatus: WorkbenchHostStatus }) {
  return (
    <nav className="ck-wb-global" aria-label="全局导航">
      <div className="ck-wb-brand">CouncilKit</div>
      {WORKBENCH_NAV_ITEMS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          aria-label={label}
          className={({ isActive }) => `ck-wb-nav-item${isActive ? " current" : ""}`}
        >
          <Icon className="ck-wb-icon" />
          <span>{label}</span>
        </NavLink>
      ))}
      <div className="ck-wb-nav-bottom">
        <div className="ck-wb-host">
          <i className="ck-wb-host-dot" data-status={hostStatus} />
          <span>{hostStatusLabel(hostStatus)}</span>
        </div>
      </div>
    </nav>
  );
}

/** ≤640px 时全局导航收起的菜单按钮 + dialog（照 WORKBENCH-PREVIEW；关闭后焦点回到按钮）。 */
export function WorkbenchMobileMenu({ hostStatus }: { hostStatus: WorkbenchHostStatus }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    if (!dialog || !trigger) return;
    const returnFocus = () => trigger.focus();
    dialog.addEventListener("close", returnFocus);
    return () => dialog.removeEventListener("close", returnFocus);
  }, []);

  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ck-wb-mobile-menu ck-wb-ghost"
        aria-label="打开导航菜单"
        onClick={() => dialogRef.current?.showModal()}
      >
        <LayoutListIcon className="ck-wb-icon" />
      </button>
      <dialog ref={dialogRef} className="ck-wb-mobile-nav-dialog" aria-label="全局导航菜单">
        <div className="ck-wb-menu-title">
          <span>CouncilKit</span>
          <button type="button" className="ck-wb-ghost" onClick={close}>
            关闭
          </button>
        </div>
        {WORKBENCH_NAV_ITEMS.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            aria-label={label}
            className={({ isActive }) => `ck-wb-nav-item${isActive ? " current" : ""}`}
            onClick={close}
          >
            <Icon className="ck-wb-icon" />
            <span>{label}</span>
          </NavLink>
        ))}
        <p>{hostStatusLabel(hostStatus)}</p>
      </dialog>
    </>
  );
}
