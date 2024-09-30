import { type AnchorHTMLAttributes } from "react";
import { usePathName } from "~/hooks/usePathName";
import { cn } from "~/utils/cn";
import { LinkButton } from "../primitives/Buttons";
import { type IconNames } from "../primitives/NamedIcon";

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
  subItem = false,
}: {
  icon?: IconNames | React.ComponentType<any>;
  activeIconColor?: string;
  inactiveIconColor?: string;
  trailingIcon?: IconNames | React.ComponentType<any>;
  trailingIconClassName?: string;
  name: string;
  to: string;
  badge?: string;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  subItem?: boolean;
}) {
  const pathName = usePathName();
  const isActive = pathName === to;

  return (
    <LinkButton
      variant={subItem ? "small-menu-sub-item" : "small-menu-item"}
      fullWidth
      textAlignLeft
      LeadingIcon={icon}
      leadingIconClassName={isActive ? activeIconColor : inactiveIconColor ?? "text-text-dimmed"}
      TrailingIcon={trailingIcon}
      trailingIconClassName={trailingIconClassName}
      to={to}
      target={target}
      className={cn(
        "text-text-bright group-hover:bg-charcoal-750",
        subItem ? "text-text-dimmed" : "",
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
