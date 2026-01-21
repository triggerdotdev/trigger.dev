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
  name,
  to,
  badge,
  target,
  isCollapsed = false,
}: {
  icon?: RenderIcon;
  activeIconColor?: string;
  inactiveIconColor?: string;
  name: string;
  to: string;
  badge?: ReactNode;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  isCollapsed?: boolean;
}) {
  const pathName = usePathName();
  const isActive = pathName === to;

  const content = (
    <Link
      to={to}
      target={target}
      className={cn(
        "flex h-8 items-center gap-2 overflow-hidden rounded px-2 text-text-bright transition-colors hover:bg-charcoal-750",
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
        }}
        transition={{ duration: 0.15, ease: "easeOut" }}
      >
        <motion.span 
          className="truncate text-2sm"
          initial={false}
          animate={{
            opacity: isCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        >
          {name}
        </motion.span>
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
      </motion.div>
    </Link>
  );

  if (isCollapsed) {
    return (
      <SimpleTooltip 
        button={content} 
        content={name} 
        side="right"
        buttonClassName="!h-8 block"
      />
    );
  }

  return content;
}
