import { type AnchorHTMLAttributes, type ReactNode } from "react";
import { Link } from "@remix-run/react";
import { usePathName } from "~/hooks/usePathName";
import { cn } from "~/utils/cn";
import { LinkButton } from "../primitives/Buttons";
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

  if (isCollapsed) {
    return (
      <SimpleTooltip
        button={
          <Link
            to={to}
            target={target}
            className={cn(
              "flex h-8 w-full items-center justify-center rounded text-text-bright transition-colors hover:bg-charcoal-750",
              isActive ? "bg-tertiary" : ""
            )}
          >
            <Icon
              icon={icon}
              className={cn(
                "size-5",
                isActive ? activeIconColor : inactiveIconColor ?? "text-text-dimmed"
              )}
            />
          </Link>
        }
        content={name}
        side="right"
        asChild
      />
    );
  }

  return (
    <LinkButton
      variant="small-menu-item"
      fullWidth
      textAlignLeft
      LeadingIcon={icon}
      leadingIconClassName={isActive ? activeIconColor : inactiveIconColor ?? "text-text-dimmed"}
      TrailingIcon={trailingIcon}
      trailingIconClassName={trailingIconClassName}
      to={to}
      target={target}
      className={cn(
        "text-text-bright group-hover:bg-charcoal-750 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
        isActive ? "bg-tertiary text-text-bright" : "group-hover:text-text-bright"
      )}
    >
      <div className="flex w-full items-center justify-between">
        {name}
        <div className="flex items-center gap-1">{badge !== undefined && badge}</div>
      </div>
    </LinkButton>
  );
}
