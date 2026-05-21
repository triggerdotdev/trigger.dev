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
}) {
  const pathName = usePathName();
  const isActive = pathName === to;

  const link = (
    <Link
      to={to}
      target={target}
      className={cn(
        "group/menulink flex h-8 w-full items-center gap-2 overflow-hidden rounded pl-[0.4375rem] pr-2 group-hover/menuitem:bg-charcoal-750 group-hover/menuitem:text-text-bright hover:bg-charcoal-750 hover:text-text-bright",
        isActive ? "bg-tertiary text-text-bright" : "text-text-dimmed"
      )}
    >
      <Icon
        icon={icon}
        className={cn(
          "size-5 shrink-0",
          isActive ? activeIconColor : inactiveIconColor ?? "text-text-dimmed",
          !isActive &&
            !disableIconHover &&
            "group-hover/menulink:text-text-bright group-hover/menuitem:text-text-bright",
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
        <span className="select-none truncate text-[0.90625rem] font-medium tracking-[-0.01em]">{name}</span>
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
          <div className="absolute bottom-1 right-1 top-1 flex aspect-square items-center justify-center rounded group-hover/menuitem:bg-charcoal-750">
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
