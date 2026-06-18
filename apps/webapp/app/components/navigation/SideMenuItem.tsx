import { type AnchorHTMLAttributes, type ReactNode } from "react";
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
        "group/menulink flex h-8 items-center gap-2 overflow-hidden rounded pl-[0.4375rem] pr-2",
        isIndented ? "min-w-0 flex-1" : "w-full",
        isActive
          ? "bg-tertiary text-text-bright"
          : "text-text-dimmed group-hover/menuitem:bg-charcoal-750 group-hover/menuitem:text-text-bright hover:bg-charcoal-750 hover:text-text-bright"
      )}
    >
      <Icon
        icon={icon}
        className={cn(
          "size-5 shrink-0",
          isActive ? activeIconColor : inactiveIconColor ?? "text-text-dimmed",
          !isActive &&
            !disableIconHover &&
            "group-hover/menuitem:text-text-bright group-hover/menulink:text-text-bright",
          iconClassName
        )}
      />
      <motion.div
        className="flex min-w-0 flex-1 items-center justify-between overflow-hidden"
        initial={false}
        animate={{
          width: isCollapsed ? 0 : "auto",
          opacity: isCollapsed ? 0 : 1,
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <span className="select-none truncate text-[0.90625rem] font-medium tracking-[-0.01em]">
          {name}
        </span>
        {badge && !isCollapsed && (
          <motion.div
            className="ml-1 flex shrink-0 items-center gap-1"
            initial={false}
            animate={{
              opacity: 1,
            }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {badge}
          </motion.div>
        )}
        {trailingIcon && !isCollapsed && (
          <Icon icon={trailingIcon} className={cn("ml-1 size-4 shrink-0", trailingIconClassName)} />
        )}
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
          buttonClassName="!h-8 block w-full"
          hidden={!isCollapsed}
          asChild
          disableHoverableContent
        />
        {!isCollapsed && (
          <div
            className={cn(
              "absolute bottom-1 right-1 top-1 flex aspect-square items-center justify-center rounded",
              isActive ? "group-hover/menuitem:bg-tertiary" : "group-hover/menuitem:bg-charcoal-750"
            )}
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
      buttonClassName="!h-8 block w-full"
      hidden={!isCollapsed}
      asChild
      disableHoverableContent
    />
  );
}
