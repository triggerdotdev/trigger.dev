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
  trailingIcon,
  trailingIconClassName,
  name,
  to,
  badge,
  target,
  isCollapsed = false,
}: {
  icon?: RenderIcon;
  activeIconColor?: string;
  inactiveIconColor?: string;
  trailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  name: string;
  to: string;
  badge?: ReactNode;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  isCollapsed?: boolean;
}) {
  const pathName = usePathName();
  const isActive = pathName === to;

  return (
    <SimpleTooltip
      button={
        <Link
          to={to}
          target={target}
          className={cn(
            "flex h-8 w-full items-center gap-2 overflow-hidden rounded pr-2 pl-[0.4375rem] text-text-bright transition-colors hover:bg-charcoal-750",
            isActive ? "bg-tertiary" : ""
          )}
        >
          <Icon
            icon={icon}
            className={cn(
              "size-5 shrink-0",
              isActive ? activeIconColor : inactiveIconColor ?? "text-text-dimmed"
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
            <span className="truncate text-2sm">{name}</span>
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
              <Icon
                icon={trailingIcon}
                className={cn("ml-1 size-4 shrink-0", trailingIconClassName)}
              />
            )}
          </motion.div>
        </Link>
      }
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
