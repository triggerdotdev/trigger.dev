import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  forwardRef,
  type ReactNode,
} from "react";
import { Link } from "@remix-run/react";
import { motion } from "framer-motion";
import { usePathName } from "~/hooks/usePathName";
import { cn } from "~/utils/cn";
import { type RenderIcon, Icon } from "../primitives/Icon";
import { SimpleTooltip } from "../primitives/Tooltip";

export function SideMenuItem({
  icon,
  activeIconColor,
  inactiveIconColor,
  iconClassName,
  trailingIcon,
  trailingIconClassName,
  name,
  nameClassName,
  to,
  badge,
  target,
  isCollapsed = false,
  action,
  disableIconHover = false,
  indented = false,
  "data-action": dataAction,
}: {
  icon?: RenderIcon;
  activeIconColor?: string;
  inactiveIconColor?: string;
  iconClassName?: string;
  trailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  name: string;
  nameClassName?: string;
  to: string;
  badge?: ReactNode;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  isCollapsed?: boolean;
  action?: ReactNode;
  disableIconHover?: boolean;
  /**
   * Visually indented variant — same item, just pushed further from
   * the left edge so it reads as a child of the row above. Used for
   * grouped sub-items like the Tasks > (Agents / Standard / Scheduled)
   * cluster. The indent is only applied when the side menu is expanded.
   */
  indented?: boolean;
  "data-action"?: string;
}) {
  const pathName = usePathName();
  const isActive = pathName === to;

  const isIndented = indented && !isCollapsed;

  const linkElement = (
    <Link
      to={to}
      target={target}
      data-action={dataAction}
      className={cn(
        "group/menulink flex h-8 items-center gap-2 overflow-hidden rounded pl-1.75 pr-2 focus-custom",
        isIndented ? "min-w-0 flex-1" : "w-full",
        isActive
          ? "bg-tertiary text-text-bright"
          : "text-text-dimmed group-hover/menuitem:bg-background-hover group-hover/menuitem:text-text-bright hover:bg-background-hover hover:text-text-bright"
      )}
    >
      <Icon
        icon={icon}
        className={cn(
          "size-5 shrink-0",
          isActive ? activeIconColor : (inactiveIconColor ?? "text-text-dimmed"),
          !isActive &&
            !disableIconHover &&
            "group-hover/menuitem:text-text-bright group-hover/menulink:text-text-bright",
          iconClassName
        )}
      />
      <motion.div
        className="min-w-0 flex-1 overflow-hidden"
        initial={false}
        animate={{
          width: isCollapsed ? 0 : "auto",
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        {/*
          Label opacity is driven by the side menu's `--sm-label-opacity` variable so it can
          fade in real time as the menu is dragged narrower. The variable is only set inside the
          resizable SideMenu; elsewhere it is unset and falls back to 1 (fully visible).
        */}
        <div
          className="flex w-full min-w-0 items-center justify-between"
          style={{ opacity: "var(--sm-label-opacity, 1)" }}
        >
          <span
            className={cn(
              "select-none truncate text-[0.90625rem] font-medium tracking-[-0.01em]",
              nameClassName
            )}
          >
            {name}
          </span>
          {badge && !isCollapsed && (
            <div className="ml-1 flex shrink-0 items-center gap-1">{badge}</div>
          )}
          {trailingIcon && !isCollapsed && (
            <Icon
              icon={trailingIcon}
              className={cn("ml-1 size-4 shrink-0", trailingIconClassName)}
            />
          )}
        </div>
      </motion.div>
    </Link>
  );

  const link = isIndented ? (
    <div className="flex w-full">
      <div aria-hidden className="w-3 shrink-0" />
      {linkElement}
    </div>
  ) : (
    linkElement
  );

  if (action) {
    return (
      <div className="group/menuitem relative h-8 w-full">
        <SimpleTooltip
          button={link}
          content={name}
          side="right"
          sideOffset={8}
          buttonClassName="h-8! block w-full"
          hidden={!isCollapsed}
          asChild
          tabbable
          disableHoverableContent
        />
        {!isCollapsed && (
          // Fades with the labels via the resizable SideMenu's `--sm-label-opacity` variable
          // (falls back to fully visible when the variable is unset).
          <div
            className={cn(
              "absolute bottom-1 right-1 top-1 flex aspect-square items-center justify-center rounded",
              isActive
                ? "group-hover/menuitem:bg-tertiary"
                : "group-hover/menuitem:bg-background-hover"
            )}
            style={{ opacity: "var(--sm-label-opacity, 1)" }}
          >
            {action}
          </div>
        )}
      </div>
    );
  }

  return (
    <SimpleTooltip
      button={link}
      content={name}
      side="right"
      sideOffset={8}
      buttonClassName="h-8! block w-full"
      hidden={!isCollapsed}
      asChild
      tabbable
      disableHoverableContent
    />
  );
}

/**
 * A button styled to match {@link SideMenuItem}, for menu entries that open a
 * dialog/sheet rather than navigate. Forwards its ref and props so it can be
 * used as a Radix `asChild` trigger.
 */
export const SideMenuItemButton = forwardRef<
  HTMLButtonElement,
  { icon: RenderIcon; name: string; trailing?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>
>(function SideMenuItemButton({ icon, name, trailing, className, type, ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "group/menuitem flex h-8 w-full items-center gap-2 overflow-hidden rounded pl-1.75 pr-2 text-left text-text-dimmed hover:bg-background-hover hover:text-text-bright focus-custom",
        className
      )}
      {...props}
    >
      <Icon
        icon={icon}
        className="size-5 shrink-0 text-text-dimmed group-hover/menuitem:text-text-bright"
      />
      <span className="min-w-0 flex-1 select-none truncate text-[0.90625rem] font-medium tracking-[-0.01em]">
        {name}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-1">{trailing}</span>}
    </button>
  );
});
