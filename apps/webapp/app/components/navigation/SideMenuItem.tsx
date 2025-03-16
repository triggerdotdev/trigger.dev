import { type AnchorHTMLAttributes } from "react";
import { usePathName } from "~/hooks/usePathName";
import { cn } from "~/utils/cn";
import { LinkButton } from "../primitives/Buttons";
import { type RenderIcon } from "../primitives/Icon";

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
}: {
  icon?: RenderIcon;
  activeIconColor?: string;
  inactiveIconColor?: string;
  trailingIcon?: RenderIcon;
  trailingIconClassName?: string;
  name: string;
  to: string;
  badge?: string;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
}) {
  const pathName = usePathName();
  const isActive = pathName === to;

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
        <div className="flex items-center gap-1">
          {badge !== undefined && <MenuCount count={badge} />}
        </div>
      </div>
    </LinkButton>
  );
}

export function MenuCount({ count }: { count: number | string }) {
  return (
    <div className="rounded-full bg-charcoal-900 px-2 py-1 text-xxs uppercase tracking-wider text-text-dimmed">
      {count}
    </div>
  );
}
